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

test("new thread selects preferred model with enough Codex quota and respects manual selection", async () => {
  const userDataDir = await makeUserDataDir();
  const workspace = await makeWorkspace("auto-model-workspace");
  const agentDir = join(userDataDir, "agent-fixture");
  const codexHome = join(userDataDir, "codex-fixture");
  await seedAgentDir(agentDir, { enabledModels: ["openai/gpt-5", "openai/gpt-6.1-terra"] });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "gpt-6.1-terra" }],
        },
      },
    }),
  );
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "fixture-secret" } }),
  );
  const app = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspace],
    agentDir,
    testMode: "background",
    scrubProviderEnv: true,
    envOverrides: { CODEX_HOME: codexHome },
  });
  try {
    await app.electronApp.evaluate(() => {
      globalThis.fetch = async () =>
        Response.json({
          rate_limit: {
            primary_window: { used_percent: 80, limit_window_seconds: 18000, reset_at: 4102444800 },
          },
        });
    });
    const window = await app.firstWindow();
    await openNewThread(window);
    const model = window.locator(".model-selector__badge").first();
    await expect(model).toHaveText("openai:gpt-6.1-terra");
    await model.click();
    await window.locator(".model-selector__item").filter({ hasText: /GPT-5/i }).first().click();
    await expect(model).toHaveText("openai:gpt-5");
  } finally {
    await app.close();
  }
});
