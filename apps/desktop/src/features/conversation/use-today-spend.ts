import { useCallback, useEffect, useRef, useState } from "react";
import type { TodaySpendSnapshot } from "../../../contracts/spend";

const REFRESH_INTERVAL_MS = 60_000;

export interface TodaySpendState {
  readonly snapshot?: TodaySpendSnapshot;
  readonly loading: boolean;
  readonly error?: string;
  readonly refresh: () => void;
}

/**
 * Today's spend for the strip under the composer. Reads session files through
 * main, refreshes when a turn changes usage, once a minute (so the total rolls
 * over at local midnight), and when the window becomes visible again.
 *
 * A failed read keeps the last good snapshot on screen: an empty strip would
 * read as "nothing was spent", which is a different claim.
 *
 * Concurrent reads are allowed and the newest answer wins by request id. The
 * main process caches the scan, and skipping a read that started before a turn
 * finished would leave the new reply out of the total until the next minute.
 */
export function useTodaySpend(refreshKey: string): TodaySpendState {
  const [snapshot, setSnapshot] = useState<TodaySpendSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const requestId = useRef(0);

  const refresh = useCallback(() => {
    const api = window.piApp;
    if (!api) {
      setLoading(false);
      setError("Desktop bridge is not available");
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    api
      .readTodaySpend()
      .then((next) => {
        if (!mounted.current || id !== requestId.current) return;
        setSnapshot(next);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!mounted.current || id !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!mounted.current || id !== requestId.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  useEffect(() => {
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
