import { useState } from "react";

export type BgJobSummary = {
  name: string;
  outcome: string;
  duration?: string;
  tone: "success" | "error" | "neutral";
  excerpt?: string;
};

/** Parse only the known heading; the original message always remains available verbatim. */
export function summarizeBgJob(text: string): BgJobSummary {
  const heading = text.split("\n", 1)[0] ?? "";
  const match = /^Фоновая задача «(.+?)» (.+), ([^,]+)\.$/.exec(heading);
  if (!match) return { name: "Фоновая задача", outcome: "Результат доступен", tone: "neutral" };
  const [, name = "", outcome = "", duration] = match;
  const tone = outcome === "завершилась успешно" ? "success" : "error";
  const tail = text.split("\nХвост лога:\n")[1]?.split("\n\nПолный вывод:")[0];
  // An error-like log line is only a hint, never presented as the cause of failure.
  const excerpt =
    tone === "error"
      ? tail
          ?.split("\n")
          .find((line) => /\b(error|failed|failure)\b|ошибк/i.test(line))
          ?.trim()
          .slice(0, 240)
      : undefined;
  return { name, outcome, duration, tone, ...(excerpt ? { excerpt } : {}) };
}

export function BgJobMessage({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeBgJob(text);
  const status = summary.tone === "success" ? "Успешно" : summary.outcome;
  return (
    <article className="bg-job" data-testid="bg-job-message">
      <button
        className="bg-job__toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`bg-job__icon bg-job__icon--${summary.tone}`} aria-hidden="true">
          {summary.tone === "success" ? "✓" : summary.tone === "error" ? "!" : "•"}
        </span>
        <span className="bg-job__name">{summary.name}</span>
        <span className="bg-job__status">
          {status}
          {summary.duration ? ` · ${summary.duration}` : ""}
        </span>
        <span className="bg-job__more">
          {expanded ? "Скрыть" : "Подробнее"} {expanded ? "⌄" : "›"}
        </span>
      </button>
      {summary.excerpt ? (
        <div className="bg-job__excerpt">Строка журнала: {summary.excerpt}</div>
      ) : null}
      {expanded ? (
        <div className="bg-job__details">
          <div className="bg-job__hint">
            Уведомление содержит только хвост журнала, если он был доступен.
          </div>
          <pre>{text}</pre>
        </div>
      ) : null}
    </article>
  );
}
