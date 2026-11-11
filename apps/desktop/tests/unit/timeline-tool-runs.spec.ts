import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { buildDisplayTimelineItems } from "../../src/features/conversation/timeline-turns";

const base = Date.parse("2026-11-06T12:00:00.000Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

function message(id: string, role: "user" | "assistant", seconds = 0): TranscriptMessage {
  return { kind: "message", id, role, text: id, createdAt: at(seconds) };
}

function tool(id: string, seconds = 0, status: "running" | "success" | "error" = "success") {
  return {
    kind: "tool" as const,
    id,
    callId: id,
    toolName: "bash",
    status,
    label: id,
    createdAt: at(seconds),
  };
}

const ids = (transcript: readonly TranscriptMessage[]) =>
  buildDisplayTimelineItems(transcript).map((item) => item.id);

test("adjacent calls fold into one row named after the first call", () => {
  const items = buildDisplayTimelineItems([
    message("u1", "user"),
    tool("t1"),
    tool("t2"),
    tool("t3"),
  ]);
  expect(items.map((item) => item.id)).toEqual(["u1", "tool-run:t1"]);
  const run = items[1];
  expect(run?.kind).toBe("tool-run");
  if (run?.kind !== "tool-run") throw new Error("run expected");
  expect(run.tools.map((call) => call.callId)).toEqual(["t1", "t2", "t3"]);
});

test("prose ends a run, so what the agent said stays next to what it then did", () => {
  expect(
    ids([
      message("u1", "user"),
      tool("t1"),
      tool("t2"),
      message("a1", "assistant", 2),
      tool("t3"),
      tool("t4"),
    ]),
  ).toEqual(["u1", "tool-run:t1", "turn-marker:u1", "a1", "tool-run:t3"]);
});

test("a single call stays a plain row instead of a one-line group", () => {
  expect(ids([message("u1", "user"), tool("t1", 4), message("u2", "user", 10)])).toEqual([
    "u1",
    "t1",
    "turn-marker:u1",
    "u2",
  ]);
});

test("a failed call stays inside the run for the renderer to lift out", () => {
  const items = buildDisplayTimelineItems([
    message("u1", "user"),
    tool("t1"),
    tool("t2", 1, "error"),
    tool("t3", 2),
  ]);
  const run = items.find((item) => item.kind === "tool-run");
  if (run?.kind !== "tool-run") throw new Error("run expected");
  expect(run.tools.map((call) => call.status)).toEqual(["success", "error", "success"]);
});

test("the turn marker ends a run even without prose in between", () => {
  const items = buildDisplayTimelineItems([
    message("u1", "user"),
    tool("t1"),
    tool("t2"),
    message("a1", "assistant", 3),
    message("u2", "user", 10),
    tool("t3", 12),
    tool("t4", 13),
  ]);
  expect(items.map((item) => item.id)).toEqual([
    "u1",
    "tool-run:t1",
    "turn-marker:u1",
    "a1",
    "u2",
    "tool-run:t3",
    "turn-marker:u2",
  ]);
});

test("the same run keeps its id while a live call changes status", () => {
  const running = buildDisplayTimelineItems([
    message("u1", "user"),
    tool("t1"),
    tool("t2", 1, "running"),
  ]);
  const settled = buildDisplayTimelineItems([
    message("u1", "user"),
    tool("t1"),
    tool("t2", 1, "success"),
  ]);
  expect(running[1]?.id).toBe(settled[1]?.id);
  const before = running[1];
  const after = settled[1];
  if (before?.kind !== "tool-run" || after?.kind !== "tool-run") throw new Error("run expected");
  expect(before.tools[1]?.status).toBe("running");
  expect(after.tools[1]?.status).toBe("success");
});

test("a thinking-only assistant step neither draws a row nor breaks the run", () => {
  const thinkingOnly: TranscriptMessage = {
    kind: "message",
    id: "thinking-1",
    role: "assistant",
    text: "   ",
    createdAt: at(1),
  };
  const items = buildDisplayTimelineItems([
    message("u1", "user"),
    tool("t1"),
    thinkingOnly,
    tool("t2"),
    tool("t3"),
  ]);
  expect(items.map((item) => item.id)).toEqual(["u1", "tool-run:t1"]);
  const run = items[1];
  if (run?.kind !== "tool-run") throw new Error("run expected");
  expect(run.tools.map((call) => call.callId)).toEqual(["t1", "t2", "t3"]);
});
