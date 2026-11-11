import { expect, test } from "@playwright/test";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { TodaySpendSnapshot } from "../../contracts/spend";
import {
  formatMoney,
  limitViews,
  limitWindowLabel,
  limitsHeadline,
  primaryHeadline,
  providerLabel,
  requestCount,
  spendProviderViews,
} from "../../src/features/conversation/spend-format";

const runtime: RuntimeSnapshot = {
  workspace: { workspaceId: "spend", path: "/spend" },
  providers: [
    {
      id: "openrouter",
      name: "OpenRouter",
      hasAuth: true,
      authType: "api_key",
      authSource: "auth_file",
      oauthSupported: false,
      isSubscription: false,
      apiKeySetupSupported: true,
    },
    {
      id: "openai-codex",
      name: "openai-codex",
      hasAuth: true,
      authType: "oauth",
      authSource: "oauth",
      oauthSupported: true,
      isSubscription: true,
      apiKeySetupSupported: false,
    },
  ],
  models: [],
  skills: [],
  extensions: [],
  settings: { enableSkillCommands: false, enabledModelPatterns: [] },
};

function snapshot(providers: TodaySpendSnapshot["providers"]): TodaySpendSnapshot {
  return {
    dayStartedAt: "2026-01-02T00:00:00.000Z",
    readAt: "2026-01-02T12:00:00.000Z",
    reported: providers.reduce((sum, row) => sum + row.reported, 0),
    estimated: providers.reduce((sum, row) => sum + row.estimated, 0),
    requests: providers.reduce((sum, row) => sum + row.requests, 0),
    providers,
    incomplete: false,
  };
}

test("the strip shows one main provider and keeps its estimate separate", () => {
  const views = spendProviderViews(
    snapshot([
      { provider: "openrouter", reported: 29.8, estimated: 6.17, requests: 42 },
      { provider: "openai", reported: 1.2, estimated: 0, requests: 3 },
      { provider: "exa", reported: 0.24, estimated: 0, requests: 9 },
    ]),
    runtime,
  );

  expect(primaryHeadline(views)).toBe("OpenRouter $29.80 · estimate ≈$6.17");
});

test("a provider bill leads over a larger estimate, other providers stay in the card", () => {
  const views = spendProviderViews(
    snapshot([
      { provider: "openai", reported: 0, estimated: 4, requests: 1 },
      { provider: "openrouter", reported: 1.25, estimated: 0, requests: 1 },
    ]),
    runtime,
  );

  expect(primaryHeadline(views)).toBe("OpenRouter $1.25");
});

test("the card puts bills first, then the subscription, then estimates", () => {
  const views = spendProviderViews(
    snapshot([
      { provider: "openai", reported: 0, estimated: 4, requests: 1 },
      { provider: "openai-codex", reported: 0, estimated: 5.52, requests: 20 },
      { provider: "openrouter", reported: 1.25, estimated: 0.3, requests: 1 },
    ]),
    runtime,
  );

  expect(views.map((view) => view.label)).toEqual(["OpenRouter", "ChatGPT", "openai"]);
});

test("a subscription provider stays out of the money headline", () => {
  const views = spendProviderViews(
    snapshot([{ provider: "openai-codex", reported: 0, estimated: 5.52, requests: 269 }]),
    runtime,
  );

  expect(views[0]?.subscription).toBe(true);
  expect(primaryHeadline(views)).toBe("included in subscription");
});

test("empty history reads as no requests, not as a free day", () => {
  expect(primaryHeadline([])).toBe("no requests");
  expect(primaryHeadline(spendProviderViews(snapshot([]), runtime))).toBe("no requests");
});

test("a zero-cost provider is not called a subscription", () => {
  const views = spendProviderViews(
    snapshot([{ provider: "openrouter", reported: 0, estimated: 0, requests: 2 }]),
    runtime,
  );

  expect(primaryHeadline(views)).toBe("2 requests with no cost");
});

test("money gets more digits as it gets smaller", () => {
  expect(formatMoney(29.8)).toBe("$29.80");
  expect(formatMoney(0.624)).toBe("$0.624");
  expect(formatMoney(0.0002)).toBe("$0.0002");
});

test("limits use friendly provider and window names", () => {
  const limits = {
    provider: "openai-codex",
    reportedAt: "2026-01-02T12:00:00.000Z",
    limits: [
      {
        windowMinutes: 300,
        usedPercent: 42.4,
        resetsAt: new Date(2026, 0, 2, 18, 40, 0).toISOString(),
      },
      { windowMinutes: 7 * 24 * 60, usedPercent: 18 },
    ],
  };

  expect(providerLabel("openai-codex", runtime)).toBe("ChatGPT");
  expect(providerLabel("openrouter", runtime)).toBe("OpenRouter");
  expect(providerLabel("unknown-provider", runtime)).toBe("unknown-provider");
  expect(limitWindowLabel(300)).toBe("5h");
  expect(limitWindowLabel(7 * 24 * 60)).toBe("week");
  expect(limitsHeadline(limits, runtime)).toBe("ChatGPT: 5h 42% · week 18%");
  expect(limitViews(limits, new Date(2026, 0, 2, 12, 0, 0))).toEqual([
    { window: "5h", usedPercent: "42%", reset: "resets 18:40" },
    { window: "week", usedPercent: "18%" },
  ]);
});

test("request counts agree with the number", () => {
  expect(requestCount(1)).toBe("1 request");
  expect(requestCount(3)).toBe("3 requests");
  expect(requestCount(11)).toBe("11 requests");
  expect(requestCount(21)).toBe("21 requests");
});
