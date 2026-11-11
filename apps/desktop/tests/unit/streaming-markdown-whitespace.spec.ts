import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { appendAssistantDelta, clearActiveAssistantMessage } from "../../electron/conversation/app-store-timeline";

const ref = { workspaceId: "workspace", sessionId: "session" };

test("preserves whitespace-only streaming chunks inside a Markdown response", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const active = new Map<string, string>();
  const chunks = ["### Заголовок", "\n\n", "| A | B |", "\n", "|---|---|", "\n", "| один | два |", " ", "текст"];
  for (const chunk of chunks) appendAssistantDelta(transcript, active, ref, chunk);
  expect(transcript.get(sessionKey(ref))?.[0]).toMatchObject({ kind: "message", text: chunks.join("") });
});

test("ignores empty initial chunks without inserting a row between tools", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const active = new Map<string, string>();
  appendAssistantDelta(transcript, active, ref, " ");
  appendAssistantDelta(transcript, active, ref, "\n");
  expect(transcript.has(sessionKey(ref))).toBe(false);
  appendAssistantDelta(transcript, active, ref, "текст");
  clearActiveAssistantMessage(active, ref);
  appendAssistantDelta(transcript, active, ref, "\n");
  expect(transcript.get(sessionKey(ref))).toHaveLength(1);
});
