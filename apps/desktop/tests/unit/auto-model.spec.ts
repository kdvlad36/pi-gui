import { expect, test } from "@playwright/test";
import type { CodexLimitsResult } from "../../contracts/spend";
import { shouldUseCodexPreferredModel } from "../../src/features/threads/auto-model";

const now = Date.parse("2026-01-01T12:00:00Z");
function limits(
  usedPercent: number,
  windowMinutes = 300,
  reportedAt = new Date(now).toISOString(),
): CodexLimitsResult {
  return {
    limits: {
      provider: "openai-codex",
      reportedAt,
      limits: [{ usedPercent, windowMinutes, resetsAt: new Date(now + 60_000).toISOString() }],
    },
  };
}

test("selects preferred model only at or above 20 percent remaining", () => {
  expect(shouldUseCodexPreferredModel(limits(80), true, now)).toBe(true);
  expect(shouldUseCodexPreferredModel(limits(80.01), true, now)).toBe(false);
  expect(shouldUseCodexPreferredModel(limits(0), false, now)).toBe(false);
});

test("falls back on errors, missing five-hour window, stale data or expired reset", () => {
  expect(shouldUseCodexPreferredModel({ error: "offline" }, true, now)).toBe(false);
  expect(shouldUseCodexPreferredModel(limits(20, 10080), true, now)).toBe(false);
  expect(
    shouldUseCodexPreferredModel(limits(20, 300, new Date(now - 120_001).toISOString()), true, now),
  ).toBe(false);
  expect(shouldUseCodexPreferredModel(limits(20), true, now + 60_001)).toBe(false);
});
