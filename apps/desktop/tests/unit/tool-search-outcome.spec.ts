import { expect, test } from "@playwright/test";
import type { TimelineToolCall } from "../../contracts/timeline-types";
import { isEmptySearch } from "../../src/features/conversation/tool-search-outcome";

function search(command: string, text = "\nCommand exited with code 1"): TimelineToolCall {
  return {
    kind: "tool",
    id: "1",
    callId: "1",
    toolName: "bash",
    status: "error",
    label: "search",
    createdAt: "2026-11-07T00:00:00Z",
    input: { command },
    output: { content: [{ type: "text", text }] },
  };
}

test("recognizes an unambiguous ripgrep no-match without changing the original status", () => {
  const tool = search(
    `cd /Users/test/project && ls && rg -n "Codex CLI|ChatGPT" -r '' --files-with-matches .`,
    "index.ts\n\nCommand exited with code 1",
  );
  expect(isEmptySearch(tool)).toBe(true);
  expect(tool.status).toBe("error");
  expect(isEmptySearch(search("rg -n missing ."))).toBe(true);
});

test("does not hide failures, ambiguous shell commands or unrelated tools", () => {
  expect(isEmptySearch(search("rg x .", "rg: permission denied\nCommand exited with code 1"))).toBe(
    false,
  );
  expect(isEmptySearch(search("rg x .", "Command exited with code 2"))).toBe(false);
  expect(isEmptySearch(search("rg x . | head"))).toBe(false);
  expect(isEmptySearch(search("rg x .; false"))).toBe(false);
  expect(
    isEmptySearch(
      search(
        "cd /missing && rg x .",
        "/bin/bash: cd: /missing: No such file or directory\nCommand exited with code 1",
      ),
    ),
  ).toBe(false);
  expect(isEmptySearch(search("rg $(false) ."))).toBe(false);
  expect(isEmptySearch({ ...search("rg x ."), toolName: "other" })).toBe(false);
  expect(isEmptySearch({ ...search("rg x ."), status: "success" })).toBe(false);
});

test("stays linear on long cd prefixes that never reach rg", () => {
  // Regression: the previous nested-quantifier regex backtracked exponentially here
  // and froze the renderer thread while it rendered an errored bash tool call.
  const longPath = `/Users/vladkolupaev/.pi/agent/install/releases/1.4.0/node_modules/${"@earendil-works/pi-coding-agent/docs/".repeat(6)}`;
  const command = `cd ${longPath} && wc -l README.md docs/index.md docs/how-pi-works.md`;
  const startedAt = performance.now();
  expect(isEmptySearch(search(command, "wc: docs: No such file or directory\nCommand exited with code 1"))).toBe(
    false,
  );
  expect(performance.now() - startedAt).toBeLessThan(1000);
  expect(isEmptySearch(search(`rg -n ${"x".repeat(4000)} .`))).toBe(true);
});
