import { expect, test } from "@playwright/test";
import { applySubagentRunNotices, subagentRunNotices } from "../../../../packages/session-driver/src/subagent-notification";

const notice = { role: "custom", customType: "subagent-notify", display: false, content: "скрытый текст", details: { runs: [{ runId: "run-1", status: "completed" }] } };

test("matches only explicit run IDs and never promotes a parallel group", () => {
  const items = [
    { kind: "tool", toolName: "subagent", input: { agent: "scout", task: "a" }, output: { details: { asyncId: "run-1" } } },
    { kind: "tool", toolName: "subagent", input: { agent: "worker", task: "b" }, output: { details: { asyncId: "run-2" } } },
    { kind: "tool", toolName: "subagent", input: { workflow: "parallel", args: {} }, output: { details: { asyncId: "run-1" } } },
  ];
  applySubagentRunNotices(items, subagentRunNotices(notice));
  expect(items[0].output).toMatchObject({ subagentCompletion: "completed" });
  expect(items[1].output).not.toHaveProperty("subagentCompletion");
  expect(items[2].output).not.toHaveProperty("subagentCompletion");
});

test("maps parallel children only when agent identities are unambiguous", () => {
  const item = { kind: "tool", toolName: "subagent", input: { workflow: "parallel", args: { tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] } }, output: { details: { asyncId: "p1" } } };
  const runs = subagentRunNotices({ role: "custom", customType: "subagent-notify", details: { runs: [{ runId: "p1", status: "failed", childRuns: [{ runId: "c1", agent: "scout", status: "completed" }, { runId: "c2", agent: "reviewer", status: "failed" }] }] } });
  const items = [item];
  applySubagentRunNotices(items, runs);
  expect(items[0].output).toMatchObject({ subagentChildren: [{ agent: "scout", status: "completed" }, { agent: "reviewer", status: "failed" }] });
});
