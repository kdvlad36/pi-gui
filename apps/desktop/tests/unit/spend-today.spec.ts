import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  localDayStart,
  parseCostEntries,
  readTodaySpend,
} from "../../electron/application/spend-today";

/** Local noon, so the test does not depend on the machine's timezone. */
const NOW = new Date(2026, 0, 2, 12, 0, 0).getTime();
const TODAY = new Date(2026, 0, 2, 9, 0, 0).toISOString();
const YESTERDAY = new Date(2026, 0, 1, 23, 30, 0).toISOString();

function reply(options: {
  readonly id: string;
  readonly provider: string;
  readonly total: number;
  readonly reported: boolean;
  readonly timestamp?: string;
}): string {
  return JSON.stringify({
    type: "message",
    id: options.id,
    timestamp: options.timestamp ?? TODAY,
    message: {
      role: "assistant",
      provider: options.provider,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: options.total,
          ...(options.reported ? { totalFromProvider: true } : {}),
        },
      },
    },
  });
}

async function fixtureRoot(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "pi-spend-")), "sessions");
  await mkdir(root, { recursive: true });
  return root;
}

test("keeps provider-reported money and pi estimates apart for today only", async () => {
  const root = await fixtureRoot();
  await writeFile(
    join(root, "session-a.jsonl"),
    [
      reply({ id: "a1", provider: "openrouter", total: 1.25, reported: true }),
      reply({ id: "a2", provider: "openai", total: 4, reported: false }),
      reply({ id: "a3", provider: "openrouter", total: 9, reported: true, timestamp: YESTERDAY }),
    ].join("\n"),
  );

  const snapshot = readTodaySpend({ sessionsRoot: root, now: NOW, fresh: true });

  expect(snapshot.reported).toBe(1.25);
  expect(snapshot.estimated).toBe(4);
  expect(snapshot.requests).toBe(2);
  expect(snapshot.incomplete).toBe(false);
  expect(snapshot.dayStartedAt).toBe(new Date(localDayStart(NOW)).toISOString());
  expect(snapshot.providers).toEqual([
    { provider: "openai", reported: 0, estimated: 4, requests: 1 },
    { provider: "openrouter", reported: 1.25, estimated: 0, requests: 1 },
  ]);
});

test("skips files last written before today and counts a copied reply once", async () => {
  const root = await fixtureRoot();
  const stale = join(root, "stale.jsonl");
  await writeFile(
    stale,
    reply({ id: "copied", provider: "openrouter", total: 50, reported: true }),
  );
  const yesterday = new Date(2026, 0, 1, 18, 0, 0);
  await utimes(stale, yesterday, yesterday);

  await writeFile(
    join(root, "fork-a.jsonl"),
    reply({ id: "copied", provider: "openrouter", total: 2, reported: true }),
  );
  await writeFile(
    join(root, "fork-b.jsonl"),
    reply({ id: "copied", provider: "openrouter", total: 2, reported: true }),
  );

  const snapshot = readTodaySpend({ sessionsRoot: root, now: NOW, fresh: true });

  expect(snapshot.reported).toBe(2);
  expect(snapshot.requests).toBe(1);
});

test("reports incomplete instead of a short total when a session file cannot be read", async () => {
  const root = await fixtureRoot();
  await symlink(join(root, "missing-target"), join(root, "broken.jsonl"));

  const snapshot = readTodaySpend({ sessionsRoot: root, now: NOW, fresh: true });

  expect(snapshot.incomplete).toBe(true);
  expect(snapshot.requests).toBe(0);
});

test("falls back to the last model_change provider for replies without one", () => {
  const entries = parseCostEntries(
    [
      JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "x" }),
      JSON.stringify({
        type: "message",
        id: "tool",
        timestamp: TODAY,
        message: { role: "toolResult", usage: { cost: { total: 0.5 } } },
      }),
    ].join("\n"),
  );

  expect(entries).toEqual([
    { id: "tool", cost: 0.5, at: Date.parse(TODAY), provider: "openrouter", reported: false },
  ]);
});
