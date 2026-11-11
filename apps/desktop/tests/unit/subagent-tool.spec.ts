import { expect, test } from "@playwright/test";
import type { TimelineToolCall } from "../../contracts/timeline-types";
import { subagentLaunchStatus, subagentTasks } from "../../src/features/conversation/subagent-tool";

const row = (input: unknown, toolName = "subagent"): TimelineToolCall => ({
  kind: "tool", id: "1", callId: "1", toolName, status: "running", label: "", createdAt: "", input,
});

test("recognises single and parallel launches without turning control calls into launches", () => {
  expect(subagentTasks(row({ agent: "scout", task: "Проверь код" }))).toEqual([{ agent: "scout", task: "Проверь код" }]);
  expect(subagentTasks(row({ workflow: "parallel", args: { tasks: [{ agent: "scout", task: "Найди" }, { agent: "reviewer", task: "Проверь" }] } }))).toHaveLength(2);
  expect(subagentTasks(row({ action: "status", id: "123" }))).toBeNull();
  expect(subagentTasks(row({ workflow: "parallel", args: { tasks: [{ agent: "scout" }] } }))).toBeNull();
  expect(subagentTasks(row({ agent: "scout", task: "Проверь" }, "other"))).toBeNull();
});

test("an accepted detached launch is not shown as a completed child", () => {
  const item = { ...row({ agent: "scout", task: "Проверь" }), status: "success" as const, output: { details: { asyncId: "run-1" } } };
  expect(subagentLaunchStatus(item)).toEqual({ label: "Запуск принят", detached: true });
});
