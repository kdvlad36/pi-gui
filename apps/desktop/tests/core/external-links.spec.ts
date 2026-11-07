import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
  type DesktopHarness,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedExternalLinkSessionFixture,
  seedNamedTextSessionFixture,
  selectSession,
} from "../helpers/electron-app";

async function captureOpenedExternalUrls(
  harness: DesktopHarness,
): Promise<() => Promise<readonly string[]>> {
  await harness.electronApp.evaluate(({ shell }) => {
    const globals = globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] };
    globals.__piGuiOpenedExternalUrls = [];
    shell.openExternal = async (url: string) => {
      globals.__piGuiOpenedExternalUrls?.push(url);
    };
  });

  return () =>
    harness.electronApp.evaluate(
      () =>
        (globalThis as typeof globalThis & { __piGuiOpenedExternalUrls?: string[] })
          .__piGuiOpenedExternalUrls ?? [],
    );
}

test("opens markdown web links externally without leaving the current session", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("external-links-workspace");
  const targetUrl = "https://github.com/minghinmatthewlam/pi-gui/issues/20";
  await seedAgentDir(agentDir);
  await seedExternalLinkSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "External link fixture session");
    const appUrl = window.url();
    const openedExternalUrls = await captureOpenedExternalUrls(harness);

    await window.getByRole("link", { name: "GitHub issue" }).click();

    await expect.poll(openedExternalUrls).toEqual([targetUrl]);
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
    expect(window.url()).toBe(appUrl);
    await expect(window.getByTestId("transcript")).toContainText("GitHub issue");
  } finally {
    await harness.close();
  }
});

test("opens local HTML links and rejects missing or unsafe paths", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("local-html-links");
  const htmlPath = join(workspacePath, "прототип с пробелом.html");
  const executablePath = join(workspacePath, "program.command");
  await writeFile(htmlPath, "<h1>Prototype</h1>");
  await writeFile(executablePath, "echo unsafe");
  await seedAgentDir(agentDir);
  await seedNamedTextSessionFixture(agentDir, workspacePath, {
    title: "Local links",
    userText: "Open prototype",
    assistantText: `[Prototype](${pathToFileURL(htmlPath)}) [Missing](${pathToFileURL(join(workspacePath, "missing.html"))}) [Program](${pathToFileURL(executablePath)}) [Remote](file://remote.example/tmp/a.html) [Web](https://example.com/)`,
  });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Local links");
    await harness.electronApp.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { openedPaths: string[] };
      state.openedPaths = [];
      shell.openPath = async (filePath: string) => {
        state.openedPaths.push(filePath);
        return "";
      };
    });
    const openedPaths = () =>
      harness.electronApp.evaluate(
        () => (globalThis as typeof globalThis & { openedPaths: string[] }).openedPaths,
      );
    await window.getByRole("link", { name: "Prototype" }).click();
    await expect.poll(openedPaths).toEqual([htmlPath]);
    await window.getByRole("link", { name: "Missing" }).click();
    await window.getByRole("link", { name: "Program" }).click();
    await window.getByRole("link", { name: "Remote" }).click();
    await window.evaluate(
      async ({ htmlUrl, programUrl }) => {
        const api = (window as unknown as { piApp: { openLocalHtml(url: string): Promise<void> } })
          .piApp;
        await api.openLocalHtml("not a URL");
        await api.openLocalHtml("file:///bad%2Fname.html");
        await api.openLocalHtml("file://remote.example/tmp/a.html");
        await api.openLocalHtml(programUrl);
        await api.openLocalHtml(`${htmlUrl}?query=1`);
      },
      { htmlUrl: pathToFileURL(htmlPath).href, programUrl: pathToFileURL(executablePath).href },
    );
    await expect.poll(openedPaths).toEqual([htmlPath]);
    await harness.electronApp.evaluate(({ shell }) => {
      shell.openPath = async () => "no handler available";
    });
    await window.evaluate((url) => {
      const api = (window as unknown as { piApp: { openLocalHtml(url: string): Promise<void> } })
        .piApp;
      return api.openLocalHtml(url);
    }, pathToFileURL(htmlPath).href);
    await expect(window.getByTestId("transcript")).toContainText("Prototype");
  } finally {
    await harness.close();
  }
});

test("refuses non-web markdown links from message content", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("unsafe-external-links-workspace");
  await seedAgentDir(agentDir);
  await seedExternalLinkSessionFixture(agentDir, workspacePath);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "External link fixture session");
    const appUrl = window.url();
    const openedExternalUrls = await captureOpenedExternalUrls(harness);

    await window.getByRole("link", { name: "email fallback" }).click();

    await expect.poll(openedExternalUrls).toEqual([]);
    await expect
      .poll(() =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      )
      .toBe(1);
    expect(window.url()).toBe(appUrl);
    await expect(window.getByTestId("transcript")).toContainText("email fallback");
  } finally {
    await harness.close();
  }
});
