import type { SessionPlanLimits } from "@pi-gui/session-driver";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { TodaySpendProvider, TodaySpendSnapshot } from "../../../contracts/spend";

/**
 * Turns a spend snapshot into the words the strip shows. Pure on purpose: the
 * money rules are the part worth testing without an Electron window.
 *
 * A provider-reported sum and pi's own estimate are never added together. A
 * subscription provider has no per-request bill at all, so its estimate stays
 * out of the headline and the strip shows plan limits instead.
 */
export interface SpendProviderView {
  readonly provider: string;
  readonly label: string;
  readonly subscription: boolean;
  /** Provider-reported money, absent when the provider reported none. */
  readonly reported?: number;
  /** pi's catalogue estimate, absent when there is none. */
  readonly estimated?: number;
  readonly requests: number;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "openai-codex": "ChatGPT",
  anthropic: "Claude",
  "kimi-coding": "Kimi Coding",
};

export function providerLabel(provider: string, runtime?: RuntimeSnapshot): string {
  return (
    PROVIDER_LABELS[provider] ??
    runtime?.providers.find((entry) => entry.id === provider)?.name ??
    provider
  );
}

export function subscriptionProviders(runtime?: RuntimeSnapshot): ReadonlySet<string> {
  return new Set(
    (runtime?.providers ?? []).filter((provider) => provider.isSubscription).map((p) => p.id),
  );
}

export function spendProviderViews(
  snapshot: TodaySpendSnapshot,
  runtime?: RuntimeSnapshot,
): SpendProviderView[] {
  const subscriptions = subscriptionProviders(runtime);
  return snapshot.providers
    .map((row) => providerView(row, subscriptions, runtime))
    .sort(compareProviderViews);
}

/**
 * A real bill leads, then estimates, then subscription rows. Money that was
 * actually charged should never be pushed out of the two headline slots by a
 * larger catalogue estimate.
 */
function compareProviderViews(left: SpendProviderView, right: SpendProviderView): number {
  const rank = (view: SpendProviderView): number => {
    if (view.reported !== undefined) return 0;
    if (view.subscription) return 1;
    return 2;
  };
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  const money = (view: SpendProviderView): number => view.reported ?? view.estimated ?? 0;
  return money(right) - money(left);
}

function providerView(
  row: TodaySpendProvider,
  subscriptions: ReadonlySet<string>,
  runtime?: RuntimeSnapshot,
): SpendProviderView {
  return {
    provider: row.provider,
    label: providerLabel(row.provider, runtime),
    subscription: subscriptions.has(row.provider),
    ...(row.reported > 0 ? { reported: row.reported } : {}),
    ...(row.estimated > 0 ? { estimated: row.estimated } : {}),
    requests: row.requests,
  };
}

/** `$29.80`, `$0.624`, `$0.0002`: more digits the smaller the amount. */
export function formatMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/**
 * One main provider for the strip: the largest provider-reported bill, or the
 * largest estimate when nothing was billed. The rest of the breakdown stays in
 * the card, so a tiny search-provider charge never crowds the headline.
 */
export function primaryHeadline(views: readonly SpendProviderView[]): string {
  const billed = views
    .filter((view) => !view.subscription && view.reported !== undefined)
    .sort((left, right) => (right.reported ?? 0) - (left.reported ?? 0));
  const estimated = views
    .filter(
      (view) => !view.subscription && view.reported === undefined && view.estimated !== undefined,
    )
    .sort((left, right) => (right.estimated ?? 0) - (left.estimated ?? 0));
  const primary = billed[0] ?? estimated[0];
  if (!primary) {
    if (views.length === 0) return "no requests";
    const priced = views.some(
      (view) => view.reported !== undefined || view.estimated !== undefined,
    );
    if (priced) return "included in subscription";
    const requests = views.reduce((sum, view) => sum + view.requests, 0);
    return `${requestCount(requests)} with no cost`;
  }
  const parts: string[] = [];
  if (primary.reported !== undefined)
    parts.push(`${primary.label} ${formatMoney(primary.reported)}`);
  if (primary.estimated !== undefined) {
    parts.push(
      primary.reported === undefined
        ? `${primary.label} estimate ≈${formatMoney(primary.estimated)}`
        : `estimate ≈${formatMoney(primary.estimated)}`,
    );
  }
  return parts.join(" · ");
}

export function requestCount(count: number): string {
  return `${count} ${count === 1 ? "request" : "requests"}`;
}

export function limitWindowLabel(windowMinutes: number): string {
  if (windowMinutes === 7 * 24 * 60) return "week";
  if (windowMinutes === 24 * 60) return "24h";
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/** `ChatGPT: 5h 42% · week 18%`, the compact form used in the strip. */
export function limitsHeadline(planLimits: SessionPlanLimits, runtime?: RuntimeSnapshot): string {
  const label = providerLabel(planLimits.provider, runtime);
  const windows = planLimits.limits
    .map((limit) => `${limitWindowLabel(limit.windowMinutes)} ${Math.round(limit.usedPercent)}%`)
    .join(" · ");
  return `${label}: ${windows}`;
}

export interface LimitView {
  readonly window: string;
  readonly usedPercent: string;
  readonly reset?: string;
}

/** Limits with a readable reset time for the details card. */
export function limitViews(planLimits: SessionPlanLimits, now = new Date()): LimitView[] {
  return planLimits.limits.map((limit) => ({
    window: limitWindowLabel(limit.windowMinutes),
    usedPercent: `${Math.round(limit.usedPercent)}%`,
    ...(limit.resetsAt ? { reset: resetLabel(limit.resetsAt, now) } : {}),
  }));
}

function resetLabel(resetsAt: string, now: Date): string | undefined {
  const at = new Date(resetsAt);
  if (!Number.isFinite(at.getTime())) return undefined;
  const time = at.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (at.getTime() - now.getTime() < 24 * 60 * 60 * 1000) return `resets ${time}`;
  const date = at.toLocaleDateString("en-US", { day: "numeric", month: "short" });
  return `resets ${date}, ${time}`;
}
