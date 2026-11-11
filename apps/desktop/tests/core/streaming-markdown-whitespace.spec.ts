import { expect, test } from "@playwright/test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { createSessionViaIpc, emitTestSessionEvents, getDesktopState, launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("streamed whitespace-only chunks keep a Markdown table and its heading separate", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("streaming-markdown-whitespace");
  const harness = await launchDesktop(userDataDir, { initialWorkspaces: [workspacePath], testMode: "foreground" });
  try {
    const window = await harness.firstWindow();
    const initial = await getDesktopState(window);
    const workspaceId = initial.selectedWorkspaceId ?? initial.workspaces[0]?.id;
    if (!workspaceId) throw new Error("No workspace");
    await createSessionViaIpc(window, workspaceId, "Markdown streaming");
    const state = await getDesktopState(window);
    if (!state.selectedSessionId) throw new Error("No session");
    const sessionRef = { workspaceId, sessionId: state.selectedSessionId };
    const timestamp = new Date().toISOString();
    // A controlled event stream isolates whitespace-only provider deltas; the renderer remains real Electron.
    const chunks = ["### Заголовок", "\n\n", "| Имя | Статус |", "\n", "|---|---|", "\n", "| Агент | Готово |"];
    const events: SessionDriverEvent[] = chunks.map((text) => ({ type: "assistantDelta", sessionRef, timestamp, text }));
    await emitTestSessionEvents(harness, events);
    const transcript = window.getByTestId("transcript");
    await expect(transcript.getByRole("heading", { name: "Заголовок" })).toHaveCount(1);
    await expect(transcript.getByRole("table")).toHaveCount(1);
    await expect(transcript.getByRole("cell", { name: "Готово" })).toHaveCount(1);
  } finally { await harness.close(); }
});
