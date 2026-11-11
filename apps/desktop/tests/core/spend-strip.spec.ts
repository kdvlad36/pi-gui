import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForSelectedSessionReady,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

test("spend strip shows the main provider and keeps the estimate in the card", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("spend-strip-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Spend strip session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  await appendMessagesToSessionFile(sessionFilePath, [
    {
      role: "assistant",
      text: "Today's OpenRouter reply",
      usageCost: { total: 1.25, provider: "openrouter", totalFromProvider: true },
    },
    {
      role: "assistant",
      text: "Today's estimated reply",
      usageCost: { total: 4, provider: "openai" },
    },
    {
      role: "assistant",
      text: "Older reply that must not count",
      timestampMs: twoDaysAgo,
      usageCost: { total: 9, provider: "openrouter", totalFromProvider: true },
    },
  ]);

  const secondRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await secondRun.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await waitForSelectedSessionReady(window, { workspaceId, sessionId });

    const strip = window.getByTestId("today-spend");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Today:");
    await expect(strip).toContainText("OpenRouter $1.25");
    await expect(strip).not.toContainText("$4.00");
    // A bill and an estimate are never added into one invented total, and
    // yesterday's reply stays out of today's sum.
    await expect(strip).not.toContainText("$5.25");
    await expect(strip).not.toContainText("$10.25");
    await expect(strip).not.toContainText("$9.00");

    await strip.click();
    const details = window.getByTestId("today-spend-details");
    await expect(details).toBeVisible();
    await expect(details).toContainText("Provider bill");
    await expect(details).toContainText("$1.25");
    await expect(details).toContainText("pi estimate");
    await expect(details).toContainText("≈$4.00");
    await expect(details).toContainText("not added together");
    await expect(details).toContainText("00:00 local time");
  } finally {
    await secondRun.close();
  }
});
