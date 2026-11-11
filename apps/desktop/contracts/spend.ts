/**
 * Today's money and request totals across every pi session on this machine.
 *
 * Cost comes from the `usage.cost` pi writes into each assistant reply. A sum the
 * provider reported (`totalFromProvider`) is a bill; anything else is pi's own
 * catalogue estimate. The two are kept apart all the way to the UI, because
 * adding them would invent money nobody charged.
 */
import type { SessionPlanLimits } from "@pi-gui/session-driver";

export type CodexLimitsResult = { readonly limits: SessionPlanLimits; readonly error?: never } | { readonly error: string; readonly limits?: never };

export interface TodaySpendProvider {
  readonly provider: string;
  /** Sum of replies where the provider itself reported the cost. */
  readonly reported: number;
  /** Sum of replies priced by pi from its catalogue. Not a bill. */
  readonly estimated: number;
  readonly requests: number;
}

export interface TodaySpendSnapshot {
  /** Local midnight the totals start at, so a reader can tell a stale snapshot. */
  readonly dayStartedAt: string;
  readonly readAt: string;
  readonly reported: number;
  readonly estimated: number;
  readonly requests: number;
  readonly providers: readonly TodaySpendProvider[];
  /** True when at least one session file could not be read, so totals may be short. */
  readonly incomplete: boolean;
}
