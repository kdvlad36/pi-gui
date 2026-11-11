import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexLimitsResult } from "../../../contracts/spend";

export function useCodexLimits(enabled: boolean) {
  const [result, setResult] = useState<CodexLimitsResult>();
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled || !window.piApp) return;
    const id = ++sequence.current;
    window.piApp.readCodexLimits().then(
      (value) => { if (id === sequence.current) setResult(value); },
      () => { if (id === sequence.current) setResult({ error: "Could not read Codex limits" }); },
    );
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { setResult(undefined); return; }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { sequence.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [enabled, refresh]);
  return { result, refresh };
}
