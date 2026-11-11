import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexLimits } from "../../electron/application/codex-limits";

test("reads Codex CLI limits without exposing the credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-limits-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: "secret", account_id: "account" } }));
  let requestHeaders: HeadersInit | undefined;
  const mockFetch: typeof fetch = async (url, init) => {
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init?.redirect).toBe("error");
    requestHeaders = init?.headers;
    return Response.json({ rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000000000 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 2000000000 },
    } });
  };
  const result = await readCodexLimits({ authPath, fetch: mockFetch });
  expect(requestHeaders).toEqual({ Authorization: "Bearer secret", "ChatGPT-Account-Id": "account" });
  expect(result.limits?.limits.map((x) => [x.windowMinutes, x.usedPercent])).toEqual([[300, 25], [10080, 50]]);
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("reports missing auth, rejected auth and malformed response without stale data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-codex-limits-"));
  const authPath = join(dir, "auth.json");
  expect(await readCodexLimits({ authPath })).toEqual({ error: "Sign in to Codex CLI" });
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: "secret" } }));
  expect(await readCodexLimits({ authPath, fetch: async () => new Response(null, { status: 401 }) })).toEqual({ error: "Renew Codex CLI sign-in" });
  expect(await readCodexLimits({ authPath, fetch: async () => Response.json({ rate_limit: { primary_window: { used_percent: 101, limit_window_seconds: 1, reset_at: 1 } } }) })).toEqual({ error: "Invalid usage response" });
  expect(await readCodexLimits({ authPath, fetch: async () => { throw new Error("secret"); } })).toEqual({ error: "Could not reach usage API" });
});
