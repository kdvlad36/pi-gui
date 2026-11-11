import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import type { TurnCaptureBoundary, SessionTreeSnapshot } from "@pi-gui/session-driver";
import { createEmptyDesktopAppState } from "../../contracts/desktop-state";
import { TurnCheckpointStore } from "../../electron/workbench/checkpoint-store";
import { MessageRewindOwner } from "../../electron/workbench/message-rewind-owner";

async function fixture({ capture = true, cancel = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-rewind-owner-")),
    checkout = join(directory, "checkout");
  await mkdir(checkout);
  await new Promise<void>((accept, reject) =>
    execFile("git", ["init", "--template=", checkout], (error) =>
      error ? reject(error) : accept(),
    ),
  );
  const checkpoints = new TurnCheckpointStore(join(directory, "data"), { timeoutMs: 10_000 });
  const target = { workspaceId: "repo", sessionId: "session" };
  const anchor = {
    checkpointId: "turn-1",
    beforeEntryId: null,
    startedAt: "2026-11-09T12:00:00.000Z",
  };
  const base: Omit<TurnCaptureBoundary, "opening" | "closing"> = {
    sessionRef: target,
    workspace: { workspaceId: "repo", path: checkout },
    runtimeGeneration: "runtime",
    runId: "run",
    timestamp: "2026-11-09T12:00:01.000Z",
  };
  await writeFile(join(checkout, "a.txt"), "before\n");
  const signal = new AbortController().signal;
  if (capture) await checkpoints.recordBoundary({ ...base, opening: anchor }, signal);
  await writeFile(join(checkout, "a.txt"), "after\n");
  if (capture)
    await checkpoints.recordBoundary(
      {
        ...base,
        closing: {
          ...anchor,
          userEntryIds: ["user"],
          assistantEntryIds: ["assistant"],
          lastEntryId: "assistant",
          outcome: "completed",
          reason: "settled",
        },
      },
      signal,
    );
  let leaf: string | null = "assistant",
    draft = "unsent draft",
    navigations = 0;
  const host = {
    validateMessageRewind: async () => ({ messageId: "user", text: "original prompt", draft }),
    getSessionTree: async (): Promise<SessionTreeSnapshot> => ({
      leafId: leaf,
      nodes: [
        {
          id: "user",
          parentId: null,
          kind: "message",
          role: "user",
          timestamp: base.timestamp,
          title: "prompt",
        },
        {
          id: "assistant",
          parentId: "user",
          kind: "message",
          role: "assistant",
          timestamp: base.timestamp,
          title: "reply",
        },
      ],
    }),
    getWorkspacePath: () => checkout,
    navigateSessionTree: async () => {
      navigations++;
      if (!cancel) leaf = null;
      return { state: createEmptyDesktopAppState(), result: { cancelled: cancel } };
    },
    updateComposerDraft: async (_target: unknown, text: string) => {
      draft = text;
      return { ...createEmptyDesktopAppState(), composerDraft: text };
    },
  };
  const owner = new MessageRewindOwner(host, checkpoints, join(directory, "app"));
  return {
    owner,
    target,
    checkout,
    getDraft: () => draft,
    getNavigations: () => navigations,
    setLeaf: (value: string) => {
      leaf = value;
    },
  };
}
test("pins native identity, saves the outgoing draft and refuses replay", async () => {
  const f = await fixture();
  const plan = await f.owner.prepare({ target: f.target, messageId: "live-row" });
  expect(plan.fileCount).toBe(1);
  expect(plan.warning).toBeUndefined();
  const result = await f.owner.apply(plan.id, false);
  expect(f.getDraft()).toBe("original prompt");
  expect(JSON.parse(await readFile(result.draftBackupPath!, "utf8"))).toMatchObject({
    text: "unsent draft",
  });
  expect(await readFile(join(f.checkout, "a.txt"), "utf8")).toBe("after\n");
  await expect(f.owner.apply(plan.id, true)).rejects.toThrow("План устарел");
});
test("unknown capture never masquerades as zero changes", async () => {
  const f = await fixture({ capture: false });
  const plan = await f.owner.prepare({ target: f.target, messageId: "user" });
  expect(plan.warning).toContain("Не удалось проверить");
  await expect(f.owner.apply(plan.id, true)).rejects.toThrow("недоступен");
  expect(f.getNavigations()).toBe(0);
});
test("changed branch invalidates a file restore plan", async () => {
  const f = await fixture();
  const plan = await f.owner.prepare({ target: f.target, messageId: "user" });
  f.setLeaf("changed");
  await expect(f.owner.apply(plan.id, true)).rejects.toThrow("Диалог изменился");
  expect(f.getNavigations()).toBe(0);
  expect(await readFile(join(f.checkout, "a.txt"), "utf8")).toBe("after\n");
});
test("cancelled Pi navigation restores files back to their initial state", async () => {
  const f = await fixture({ cancel: true });
  const plan = await f.owner.prepare({ target: f.target, messageId: "user" });
  await expect(f.owner.apply(plan.id, true)).rejects.toThrow(
    "Файлы оставлены в исходном состоянии",
  );
  expect(await readFile(join(f.checkout, "a.txt"), "utf8")).toBe("after\n");
  expect(f.getDraft()).toBe("unsent draft");
});
