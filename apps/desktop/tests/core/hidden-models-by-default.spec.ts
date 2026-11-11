import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";

/** A fresh install saves no enabledModels at all, which must mean "no model enabled". */
test("no saved enabledModels leaves every model off until the user enables one", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("hidden-models-default-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    await expect(window.getByTestId("model-onboarding-notice")).toContainText("Settings > Models");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();

    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    await expect(
      enabledModels.getByRole("switch", { name: "Enable openai/gpt-5", exact: true }),
    ).not.toBeChecked();
    await expect(enabledModels.locator(".settings-section__title")).toContainText("0 of");
  } finally {
    await harness.close();
  }
});

test("enabling one model writes exactly that pattern and nothing else", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("hidden-models-enable-workspace");
  await seedAgentDir(agentDir, { enabledModels: [] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();

    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    await window.getByLabel("Search models").fill("gpt-5");
    const switchForGpt5 = enabledModels.getByRole("switch", {
      name: "Enable openai/gpt-5",
      exact: true,
    });
    await expect(switchForGpt5).not.toBeChecked();
    await switchForGpt5.click();
    await expect(switchForGpt5).toBeChecked();

    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      enabledModels?: unknown;
    };
    expect(settings.enabledModels).toEqual(["openai/gpt-5"]);

    await window.getByRole("button", { name: "Back to app", exact: true }).click();
    await openNewThread(window);
    await window.locator(".new-thread__hint .model-selector__badge").first().click();
    const dropdown = window.locator(".new-thread__hint .model-selector__dropdown").first();
    await expect(dropdown).toContainText("GPT-5");
    await expect(dropdown).not.toContainText("GPT-4o mini");
  } finally {
    await harness.close();
  }
});
