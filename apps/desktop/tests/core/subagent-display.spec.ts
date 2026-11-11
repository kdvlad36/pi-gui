import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createNamedThread, launchDesktop, makeUserDataDir, makeWorkspace, seedAgentDir, selectSession, waitForWorkspaceByPath, writeProjectExtension } from "../helpers/electron-app";

const extension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function fixture(pi) {
  pi.registerTool({ name: "subagent", label: "Subagent", description: "fixture", parameters: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"] },
    async execute() { setTimeout(() => pi.sendMessage({ customType: "subagent-notify", content: "Скрытый итог", display: false, details: { runs: [{ runId: "run-123", status: "completed" }] } }, { triggerTurn: false }), 1500); return { content: [{ type: "text", text: "Фоновый запуск принят" }], details: { asyncId: "run-123" } }; } });
  pi.registerProvider("subagent-fixture", { baseUrl: "http://127.0.0.1:9", apiKey: "fixture", api: "subagent-fixture", models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const called = context.messages.some(message => message.role === "toolResult");
      const content = called ? [{ type: "text", text: "Продолжаю работу." }] : [{ type: "toolCall", id: "agent-1", name: "subagent", arguments: { agent: "scout", task: "Проверить авторизацию" } }];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: called ? "stop" : "toolUse", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...message, content: [] } }); if (called) stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); }); return stream;
    }
  });
}`;

test("compact subagent row opens and survives restart", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("subagent-display");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "subagent-fixture", defaultModel: "scripted", enabledModels: ["subagent-fixture/scripted"], packages: [], cacheWarming: "off", compaction: { enabled: false } }));
  await writeProjectExtension(workspacePath, "subagent-fixture.ts", extension);
  const launch = () => launchDesktop(userDataDir, { agentDir, initialWorkspaces: [workspacePath], scrubProviderEnv: true, testMode: "foreground" });
  const first = await launch();
  try {
    const window = await first.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Субагенты");
    const composer = window.getByTestId("composer");
    await composer.fill("Проверь"); await composer.press("Enter");
    const row = window.getByTestId("subagent-tool");
    await expect(row).toContainText("Запуск принят");
    await expect(row).not.toContainText("Ответ инструмента");
    await row.getByRole("button").click();
    await expect(row).toContainText("Фоновый запуск принят");
    await expect(row).toContainText("Завершил");
    await expect(window.getByTestId("transcript")).not.toContainText("Скрытый итог");
  } finally { await first.close(); }
  const second = await launch();
  try {
    const window = await second.firstWindow();
    await selectSession(window, "Субагенты");
    await expect(window.getByTestId("subagent-tool")).toContainText("Завершил");
  } finally { await second.close(); }
});
