import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  desktopShortcut,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedAgentDir,
} from "../helpers/electron-app";

test("models enabled by an enabledModels glob show in the picker and stay locked on in Settings", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("enabled-model-globs-workspace");
  await seedAgentDir(agentDir, { enabledModels: ["openai/gpt-4o*", "openai/gpt-5"] });

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    await window.locator(".new-thread__hint .model-selector__badge").first().click();
    const dropdown = window.locator(".new-thread__hint .model-selector__dropdown").first();
    await expect(dropdown).toContainText("GPT-4o mini");
    await expect(dropdown).toContainText("GPT-5");
    await expect(dropdown).not.toContainText("GPT-4 Turbo");
    await window.keyboard.press("Escape");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "Models", exact: true }).click();
    const enabledModels = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Enabled models" }),
    });
    const modelSwitch = (pattern: string) =>
      enabledModels.getByRole("switch", { name: `Enable ${pattern}`, exact: true });

    await expect(modelSwitch("openai/gpt-4o-mini")).toBeChecked();
    await expect(modelSwitch("openai/gpt-4o-mini")).toBeDisabled();
    await expect(modelSwitch("openai/gpt-5")).toBeChecked();
    await expect(modelSwitch("openai/gpt-5")).toBeEnabled();
    await expect(modelSwitch("openai/gpt-4-turbo")).not.toBeChecked();

    // Turning off a listed model keeps the user's glob in settings.json.
    await modelSwitch("openai/gpt-5").click();
    await expect(modelSwitch("openai/gpt-5")).not.toBeChecked();
    await expect(modelSwitch("openai/gpt-4o-mini")).toBeChecked();
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      enabledModels?: unknown;
    };
    expect(settings.enabledModels).toEqual(["openai/gpt-4o*"]);
  } finally {
    await harness.close();
  }
});

test("app-global model settings resolve globs against the global patterns, not a project's own", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("enabled-model-globs-project-workspace");
  await seedAgentDir(agentDir, { enabledModels: ["openai/gpt-4o*", "openai/gpt-5"] });
  // pi in this folder would use the project's list; pi-gui's app-global mode shows the global one.
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(
    join(workspacePath, ".pi", "settings.json"),
    `${JSON.stringify({ enabledModels: ["openai/gpt-4-turbo"] })}\n`,
  );

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await openNewThread(window);
    await window.locator(".new-thread__hint .model-selector__badge").first().click();
    const dropdown = window.locator(".new-thread__hint .model-selector__dropdown").first();
    await expect(dropdown).toContainText("GPT-4o mini");
    await expect(dropdown).toContainText("GPT-5");
    await expect(dropdown).not.toContainText("GPT-4 Turbo");
  } finally {
    await harness.close();
  }
});

test("connecting a custom endpoint keeps the saved glob instead of listing every matched id", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("enabled-model-globs-endpoint-workspace");
  await seedAgentDir(agentDir, { enabledModels: ["local-endpoint/*"] });

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
    await window.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(window.locator(".view-header__title")).toHaveText("Providers");

    const customEndpoints = window.locator(".settings-section", {
      has: window.locator(".settings-section__title", { hasText: "Custom endpoints" }),
    });
    await customEndpoints.getByRole("button", { name: "Add endpoint", exact: true }).click();

    const dialog = window.getByTestId("custom-endpoint-dialog");
    await dialog.getByLabel("Provider ID").fill("local-endpoint");
    await dialog.getByLabel("Base URL").fill("http://localhost:11434/v1");
    await dialog.getByLabel("Add model ID manually").fill("llama3.1");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await dialog.getByRole("button", { name: "Add endpoint", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Connecting the endpoint must not append the ids the glob already enables.
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
      enabledModels?: unknown;
    };
    expect(settings.enabledModels).toEqual(["local-endpoint/*"]);
  } finally {
    await harness.close();
  }
});
