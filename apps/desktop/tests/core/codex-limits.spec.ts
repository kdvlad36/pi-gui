import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";

test("new thread shows Codex limits, errors and no credentials", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("codex-limits-workspace");
  const agentDir = join(userDataDir, "agent-fixture");
  const codexHome = join(userDataDir, "codex-fixture");
  await seedAgentDir(agentDir);
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      openai: { type: "api_key", key: "test-key" },
      "openai-codex": {
        type: "oauth",
        access: "test-access",
        refresh: "test-refresh",
        expires: 4102444800000,
        accountId: "test-account",
      },
    }),
  );
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    agentDir,
    testMode: "background",
    envOverrides: { CODEX_HOME: codexHome },
  });
  try {
    const window = await app.firstWindow();
    await openNewThread(window);
    const strip = window.getByTestId("today-spend");
    await expect(strip).toContainText("OpenAI: Sign in to Codex CLI");
    await strip.click();
    const details = window.getByTestId("today-spend-details");
    await expect(details).toContainText("Account from Codex CLI");
    await expect(details).not.toContainText("test-access");

    // The main-process fetch is replaced with a fixture: no provider is contacted.
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-secret" } }),
    );
    await app.electronApp.evaluate(() => {
      globalThis.fetch = async () =>
        Response.json({
          rate_limit: {
            primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 4102444800 },
            secondary_window: {
              used_percent: 40,
              limit_window_seconds: 604800,
              reset_at: 4102444800,
            },
          },
        });
    });
    await details.getByRole("button", { name: "Refresh" }).click();
    await expect(strip).toContainText("OpenAI: 5h 80% left · week 60% left");
    await expect(details).toContainText("20% used");
    await expect(details).not.toContainText("fixture-secret");
    await app.electronApp.evaluate(() => {
      globalThis.fetch = async () => new Response(null, { status: 401 });
    });
    await details.getByRole("button", { name: "Refresh" }).click();
    await expect(strip).toContainText("OpenAI: Renew Codex CLI sign-in");
    await expect(strip).not.toContainText("80% left");
  } finally {
    await app.close();
  }
});
