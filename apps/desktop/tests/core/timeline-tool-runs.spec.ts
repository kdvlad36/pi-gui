import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

type Harness = Awaited<ReturnType<typeof launchDesktop>>;

async function setWindowSize(
  harness: Harness,
  window: Page,
  width: number,
  height: number,
): Promise<void> {
  const resized = await harness.electronApp.evaluate(
    ({ BrowserWindow }, bounds) => {
      const appWindow = BrowserWindow.getAllWindows()[0];
      if (!appWindow) return false;
      appWindow.setSize(bounds.width, bounds.height);
      return true;
    },
    { width, height },
  );
  expect(resized).toBe(true);
  await expect
    .poll(() => window.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width, height });
}

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

async function call(
  harness: Harness,
  sessionRef: SessionRef,
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
  outcome: "success" | "error" | "running" = "success",
  output?: unknown,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const started: Extract<SessionDriverEvent, { type: "toolStarted" }> = {
    type: "toolStarted",
    sessionRef,
    timestamp,
    toolName,
    callId,
    input,
  };
  await emitTestSessionEvent(harness, started);
  if (outcome === "running") return;
  const finished: Extract<SessionDriverEvent, { type: "toolFinished" }> = {
    type: "toolFinished",
    sessionRef,
    timestamp,
    callId,
    success: outcome === "success",
    output: output ?? (outcome === "success" ? "ok" : "command failed with exit code 1"),
  };
  await emitTestSessionEvent(harness, finished);
}

test("an empty rg result stays in the group while genuine failures stay visible", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("empty-search-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Search outcomes");
    const ref = await selectedSessionRef(window);
    await call(harness, ref, "search", "bash", { command: "rg -n absent ." }, "error", {
      content: [{ type: "text", text: "\nCommand exited with code 1" }],
    });
    await call(harness, ref, "failed", "bash", { command: "pnpm build" }, "error");
    const failures = window.locator('[data-testid="timeline-tool-run-failures"]');
    await expect(failures.locator(".timeline-tool")).toHaveCount(1);
    await expect(failures).toContainText("pnpm build");
    const toggle = window.locator('[data-testid="timeline-tool-run-toggle"]');
    await toggle.click();
    const body = window.locator('[data-testid="timeline-tool-run-body"]');
    await expect(body.locator(".timeline-tool--success")).toHaveCount(1);
    await expect(body).toContainText("совпадений нет");
    await expect(body).not.toContainText("failed");
  } finally {
    await harness.close();
  }
});

/**
 * The collapsed run is the whole point: adjacent calls take one row, a failure stays visible,
 * and the live call is named in the row tail instead of adding another line.
 */
test("adjacent tool calls share one collapsed row with Russian labels", async () => {
  test.setTimeout(90_000);
  const proofDir = process.env.PI_APP_TOOL_RUNS_PROOF_DIR?.trim();
  if (proofDir) await mkdir(proofDir, { recursive: true });
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("timeline-tool-runs-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Tool runs");
    const sessionRef = await selectedSessionRef(window);

    // The driver streams an empty text delta for thinking-only steps; it must not leave a
    // blank row between calls or the run would fold two calls at a time.
    const emptyDelta: SessionDriverEvent = {
      type: "assistantDelta",
      sessionRef,
      timestamp: new Date().toISOString(),
      text: "",
    };
    await call(harness, sessionRef, "run-1", "bash", { command: 'rg -n "toolCall"' });
    await emitTestSessionEvent(harness, emptyDelta);
    await call(harness, sessionRef, "run-2", "read", { path: "/tmp/repo/src/a.ts" });
    await emitTestSessionEvent(harness, emptyDelta);
    await call(harness, sessionRef, "run-3", "bash", { command: "npm run typecheck" });

    const run = window.locator('[data-testid="timeline-tool-run"]');
    await expect(run).toHaveCount(1, { timeout: 15_000 });
    const toggle = window.locator('[data-testid="timeline-tool-run-toggle"]');
    await expect(toggle).toHaveText(/Выполнено 3 действия/);
    await expect(toggle).toHaveText(/2 команды · 1 файл/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Collapsed: the individual rows are not in the layout at all.
    await expect(window.locator('[data-testid="timeline-tool-run-body"]')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const body = window.locator('[data-testid="timeline-tool-run-body"]');
    await expect(body.locator(".timeline-tool")).toHaveCount(3);
    await expect(body).toHaveText(/Искал toolCall в коде/);
    await expect(body).toHaveText(/Прочитал repo\/src\/a\.ts/);
    await expect(body).toHaveText(/Проверил типы/);
    if (proofDir) await window.screenshot({ path: join(proofDir, "run-expanded.png") });

    // A failure is lifted out of the run, so collapsing cannot hide it.
    await call(harness, sessionRef, "run-4", "bash", { command: "pnpm build" }, "error");
    const failures = window.locator('[data-testid="timeline-tool-run-failures"]');
    await expect(failures.locator(".timeline-tool")).toHaveCount(1);
    await expect(failures).toHaveText(/Запустил команду: pnpm build/);
    await expect(body.locator(".timeline-tool")).toHaveCount(3);
    await expect(toggle).toHaveText(/Выполнено 4 действия/);
    await expect(toggle).not.toHaveText(/ошибка/);

    // Collapsing again hides the rows but keeps the failure row.
    await toggle.click();
    await expect(body).toHaveCount(0);
    await expect(failures.locator(".timeline-tool")).toHaveCount(1);

    // A live call keeps the run collapsed and names itself in the tail.
    await call(harness, sessionRef, "run-5", "bash", { command: "make litellm-up" }, "running");
    await expect(toggle).toHaveText(/Выполняется 5 действий/);
    await expect(toggle).toHaveText(/Сейчас: Запускаю туннель/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(window.locator('[data-testid="timeline-tool-run-body"]')).toHaveCount(0);
    await expect(
      window.locator(".timeline-tool-run .timeline-tool__chevron--expanded"),
    ).toHaveCount(0);

    // The Russian phrase and the live tail must not push the row out of a narrow window.
    await setWindowSize(harness, window, 820, 900);
    await expect
      .poll(() =>
        window.evaluate(() => {
          const transcript = document.querySelector<HTMLElement>('[data-testid="transcript"]');
          const pane = document.querySelector<HTMLElement>('[data-testid="timeline-pane"]');
          const run = document.querySelector<HTMLElement>('[data-testid="timeline-tool-run"]');
          if (!transcript || !pane || !run) throw new Error("Expected the timeline and its run");
          const runRect = run.getBoundingClientRect();
          const transcriptRect = transcript.getBoundingClientRect();
          return {
            timelineFits: transcript.scrollWidth <= transcript.clientWidth + 1,
            paneFits: pane.scrollWidth <= pane.clientWidth + 1,
            runInside:
              runRect.left >= transcriptRect.left - 1 && runRect.right <= transcriptRect.right + 1,
          };
        }),
      )
      .toEqual({ timelineFits: true, paneFits: true, runInside: true });
    if (proofDir) await window.screenshot({ path: join(proofDir, "run-collapsed-live.png") });

    // Find in thread walks rendered text, so opening it must reveal the collapsed rows.
    await window.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    const searchInput = window.locator(".thread-search-bar__input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("Проверил типы");
    await expect(window.locator(".thread-search-bar__count")).toHaveText("1 / 1");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await searchInput.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(window.locator('[data-testid="timeline-tool-run-body"]')).toHaveCount(0);
  } finally {
    await harness.close();
  }
});
