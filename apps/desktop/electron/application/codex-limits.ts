import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexLimitsResult } from "../../contracts/spend";

/** Codex CLI owns this credential. Never refresh it or return it to the renderer. */
export async function readCodexLimits(options: {
  authPath?: string;
  fetch?: typeof fetch;
} = {}): Promise<CodexLimitsResult> {
  let auth: { tokens?: { access_token?: unknown; account_id?: unknown } };
  try {
    auth = JSON.parse(await readFile(options.authPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8"));
  } catch {
    return { error: "Sign in to Codex CLI" };
  }
  const token = auth?.tokens?.access_token;
  if (typeof token !== "string" || !token) return { error: "Sign in to Codex CLI" };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (typeof auth.tokens?.account_id === "string") headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  try {
    const response = await (options.fetch ?? fetch)("https://chatgpt.com/backend-api/wham/usage", {
      headers, signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return { error: "Renew Codex CLI sign-in" };
    if (!response.ok) return { error: `Usage API: HTTP ${response.status}` };
    const data: unknown = await response.json();
    const rate = (data as { rate_limit?: Record<string, unknown> } | null)?.rate_limit;
    const limits = [];
    for (const key of ["primary_window", "secondary_window"]) {
      const w = rate?.[key] as Record<string, unknown> | undefined;
      if (!w) continue;
      const used = w.used_percent, seconds = w.limit_window_seconds, reset = w.reset_at;
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 ||
          typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 ||
          typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0 || reset * 1000 > 8.64e15) {
        return { error: "Invalid usage response" };
      }
      limits.push({ windowMinutes: seconds / 60, usedPercent: used, resetsAt: new Date(reset * 1000).toISOString() });
    }
    if (!limits.length) return { error: "No limits reported" };
    return { limits: { provider: "openai-codex", limits, reportedAt: new Date().toISOString() } };
  } catch {
    return { error: "Could not reach usage API" };
  }
}
