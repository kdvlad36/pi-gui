import { useEffect, useId, useRef, useState } from "react";
import type { SessionUsageSnapshot } from "@pi-gui/session-driver";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import {
  formatMoney,
  limitViews,
  limitWindowLabel,
  primaryHeadline,
  providerLabel,
  requestCount,
  spendProviderViews,
  type SpendProviderView,
} from "./spend-format";
import { useTodaySpend } from "./use-today-spend";
import { useCodexLimits } from "./use-codex-limits";

interface SpendStripProps {
  readonly usage?: SessionUsageSnapshot;
  readonly provider?: string;
  readonly runtime?: RuntimeSnapshot;
}

/**
 * Today's money across every pi session, under the composer. One main provider
 * leads, OpenAI plan limits follow, and the full breakdown waits in the card.
 * Provider bills and pi estimates are never added together.
 */
export function SpendStrip({ usage, provider, runtime }: SpendStripProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refreshKey = `${usage?.totals.cost ?? ""}|${usage?.planLimits?.reportedAt ?? ""}`;
  const { snapshot, loading, error, refresh } = useTodaySpend(refreshKey);
  const codexEnabled = Boolean(
    runtime?.providers.some((item) => item.id === "openai-codex" && item.hasAuth),
  );
  const { result: codex, refresh: refreshCodex } = useCodexLimits(codexEnabled);
  const codexLimits = codex?.limits;
  const codexHeadline = codexLimits
    ? `OpenAI: ${codexLimits.limits
        .map((limit) => {
          const window = limitWindowLabel(limit.windowMinutes);
          return `${window} ${limit.resetsAt && Date.parse(limit.resetsAt) <= Date.now() ? "refreshing" : `${Math.floor(100 - limit.usedPercent)}% left`}`;
        })
        .join(" · ")}`
    : codex?.error
      ? `OpenAI: ${codex.error}`
      : codexEnabled
        ? "OpenAI: loading…"
        : undefined;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const views = snapshot ? spendProviderViews(snapshot, runtime) : [];
  const money = snapshot ? primaryHeadline(views) : "reading session history…";
  const planLimits = usage?.planLimits;

  return (
    <div className="spend-strip" ref={rootRef}>
      <button
        type="button"
        className="spend-strip__button"
        data-testid="today-spend"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Today's spend: ${money}${codexHeadline ? `; ${codexHeadline}` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="spend-strip__today">
          <span className="spend-strip__label">Today:</span> {money}
        </span>
        {codexHeadline ? <span className="spend-strip__limits">{codexHeadline}</span> : null}
        <span className="spend-strip__chevron" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open ? (
        <div
          className="spend-strip__card"
          id={panelId}
          role="region"
          aria-label="Today's spend"
          data-testid="today-spend-details"
        >
          <div className="spend-strip__head">
            <h3 className="spend-strip__heading">Today</h3>
            <button
              type="button"
              className="spend-strip__refresh"
              onClick={() => {
                refresh();
                refreshCodex();
              }}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {error ? (
            <p className="spend-strip__warning">Could not read session history: {error}</p>
          ) : null}
          {!snapshot && !error ? (
            <p className="spend-strip__note">Reading session history…</p>
          ) : null}
          {snapshot?.incomplete ? (
            <p className="spend-strip__warning">
              Some session files could not be read, so the total may be short.
            </p>
          ) : null}
          {snapshot && views.length === 0 ? (
            <p className="spend-strip__note">No requests today.</p>
          ) : null}
          {views.map((view) => (
            <SpendRow key={view.provider} view={view} />
          ))}
          {codexEnabled ? (
            <section className="spend-strip__section">
              <h4 className="spend-strip__subheading">OpenAI: limits</h4>
              <p className="spend-strip__note">
                Account from Codex CLI; it may differ from the account signed into Pi.
              </p>
              {codexLimits ? (
                codexLimits.limits.map((limit) => {
                  const view = limitViews({ ...codexLimits, limits: [limit] })[0];
                  if (!view) return null;
                  const expired = limit.resetsAt && Date.parse(limit.resetsAt) <= Date.now();
                  return (
                    <div className="spend-strip__row" key={view.window}>
                      <span>{view.window}</span>
                      <span className="spend-strip__value">
                        {expired
                          ? "Refreshing…"
                          : `${view.usedPercent} used${view.reset ? ` · ${view.reset}` : ""}`}
                      </span>
                    </div>
                  );
                })
              ) : (
                <p className="spend-strip__note">{codex?.error ?? "Loading…"}</p>
              )}
            </section>
          ) : null}
          {planLimits ? (
            <section className="spend-strip__section">
              <h4 className="spend-strip__subheading">
                {providerLabel(planLimits.provider, runtime)}: limits
              </h4>
              {limitViews(planLimits).map((limit) => (
                <div className="spend-strip__row" key={limit.window}>
                  <span>{limit.window}</span>
                  <span className="spend-strip__value">
                    {limit.usedPercent}
                    {limit.reset ? ` · ${limit.reset}` : ""}
                  </span>
                </div>
              ))}
            </section>
          ) : usage?.subscription && provider ? (
            <section className="spend-strip__section">
              <h4 className="spend-strip__subheading">
                {providerLabel(provider, runtime)}: limits
              </h4>
              <p className="spend-strip__note">
                The provider did not report limits in the latest reply.
              </p>
            </section>
          ) : null}
          <p className="spend-strip__note">
            Provider-reported bills and pi's catalogue estimates are not added together. This is not
            a provider invoice.
          </p>
          <p className="spend-strip__note">
            The day starts at 00:00 local time.
            {snapshot ? ` Read at ${timeOf(snapshot.readAt)}.` : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SpendRow({ view }: { readonly view: SpendProviderView }) {
  return (
    <div className="spend-strip__provider">
      <div className="spend-strip__provider-head">
        <span className="spend-strip__provider-name">{view.label}</span>
        <span className="spend-strip__requests">{requestCount(view.requests)}</span>
      </div>
      {view.reported !== undefined ? (
        <div className="spend-strip__row">
          <span>Provider bill</span>
          <span className="spend-strip__value">{formatMoney(view.reported)}</span>
        </div>
      ) : null}
      {view.estimated !== undefined ? (
        <div className="spend-strip__row">
          <span>
            {view.subscription ? "Included in subscription · token estimate" : "pi estimate"}
          </span>
          <span className="spend-strip__value">≈{formatMoney(view.estimated)}</span>
        </div>
      ) : null}
      {view.reported === undefined && view.estimated === undefined ? (
        <div className="spend-strip__row">
          <span>{view.subscription ? "Included in subscription" : "Cost"}</span>
          <span className="spend-strip__value">no amount</span>
        </div>
      ) : null}
    </div>
  );
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
