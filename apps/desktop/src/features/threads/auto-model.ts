import type { CodexLimitsResult } from "../../../contracts/spend";

/** Choose the preferred model only from a fresh, actual five-hour Codex window. */
export function shouldUseCodexPreferredModel(
  result: CodexLimitsResult | undefined,
  modelAvailable: boolean,
  now = Date.now(),
): boolean {
  if (!modelAvailable || !result?.limits || result.limits.provider !== "openai-codex") return false;
  const reportedAt = Date.parse(result.limits.reportedAt);
  if (!Number.isFinite(reportedAt) || reportedAt > now || now - reportedAt > 120_000) return false;
  const window = result.limits.limits.find((limit) => limit.windowMinutes === 300);
  if (
    !window ||
    !Number.isFinite(window.usedPercent) ||
    window.usedPercent < 0 ||
    window.usedPercent > 80
  )
    return false;
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(reset) && reset > now;
}
