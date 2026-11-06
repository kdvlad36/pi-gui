import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSupervisor } from "../dist/runtime-supervisor.js";

const PROVIDER = "repro-provider";
const PATTERN = `${PROVIDER}/model-*`;

function registerModels(): { id: string; name: string; input: string[] }[] {
  return [1, 2, 3, 4].map((index) => ({
    id: `model-${index}`,
    name: `Repro Model ${index}`,
    input: ["text"],
  }));
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-enabled-models-"));
  const agentDir = join(root, "agent");
  const workspacePath = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], enabledModels: [PATTERN] }, null, 2),
  );
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));

  const supervisor = new RuntimeSupervisor({
    agentDir,
    builtinExtensions: [
      {
        name: "repro-provider",
        displayName: "Repro provider",
        factory: (pi) => {
          pi.registerProvider(PROVIDER, {
            baseUrl: "http://localhost:9/v1",
            apiKey: "test-key",
            api: "openai-completions",
            models: registerModels(),
          });
        },
      },
    ],
  });

  return {
    agentDir,
    workspace: { workspaceId: "repro", path: workspacePath, displayName: "repro" },
    supervisor,
  };
}

async function readEnabledModels(agentDir: string): Promise<unknown> {
  const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as {
    enabledModels?: unknown;
  };
  return settings.enabledModels;
}

test("refreshRuntime keeps a pattern-only enabledModels list instead of listing every model", async () => {
  const { agentDir, workspace, supervisor } = await createFixture();

  const snapshot = await supervisor.getRuntimeSnapshot(workspace);
  const available = snapshot.models.filter((model) => model.available);
  assert.equal(available.length, 4, "the repro provider must expose four available models");
  assert.deepEqual(await readEnabledModels(agentDir), [PATTERN], "snapshot must not write patterns");

  await supervisor.refreshRuntime(workspace);

  assert.deepEqual(
    await readEnabledModels(agentDir),
    [PATTERN],
    "refreshRuntime must not expand saved patterns into explicit model ids",
  );
});

test("login keeps a pattern-only enabledModels list instead of listing every model", async () => {
  const { agentDir, workspace, supervisor } = await createFixture();

  await supervisor.login(workspace, PROVIDER, {
    onAuth: () => undefined,
    onPrompt: async () => "test-key",
  });

  assert.deepEqual(
    await readEnabledModels(agentDir),
    [PATTERN],
    "login must not expand saved patterns into explicit model ids",
  );
});

test("setProviderApiKey keeps a pattern-only enabledModels list instead of listing every model", async () => {
  const { agentDir, workspace, supervisor } = await createFixture();

  await supervisor.setProviderApiKey(workspace, PROVIDER, "test-key");

  assert.deepEqual(
    await readEnabledModels(agentDir),
    [PATTERN],
    "setProviderApiKey must not expand saved patterns into explicit model ids",
  );
});
