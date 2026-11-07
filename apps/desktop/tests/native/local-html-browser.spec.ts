import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  seedNamedTextSessionFixture,
  selectSession,
} from "../helpers/electron-app";

test("opens a chat HTML link in the system browser", async () => {
  let rendered = false;
  const server = createServer((request, response) => {
    if (request.url === "/rendered") rendered = true;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test server address");
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("native-local-html");
  const htmlPath = join(workspacePath, "prototype.html");
  await writeFile(
    htmlPath,
    `<title>pi-gui local link test</title><script>new Image().src='http://127.0.0.1:${address.port}/rendered'</script>`,
  );
  await seedAgentDir(agentDir);
  await seedNamedTextSessionFixture(agentDir, workspacePath, {
    title: "Native local link",
    userText: "Open prototype",
    assistantText: `[Open prototype](${pathToFileURL(htmlPath)})`,
  });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
  });
  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Native local link");
    await window.getByRole("link", { name: "Open prototype" }).click();
    await expect.poll(() => rendered, { timeout: 15000 }).toBe(true);
  } finally {
    await harness.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
