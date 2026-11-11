import { useState } from "react";
import type { TimelineToolCall } from "../../../contracts/timeline-types";

interface AgentTask {
  readonly agent: string;
  readonly task: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only launch calls with explicit tasks are represented; management calls keep their normal row. */
export function subagentTasks(item: TimelineToolCall): AgentTask[] | null {
  if (item.toolName !== "subagent") return null;
  const input = record(item.input);
  if (!input || input.action) return null;
  if (typeof input.agent === "string" && typeof input.task === "string") {
    return [{ agent: input.agent, task: input.task }];
  }
  const args = record(input.args);
  if (input.workflow !== "parallel" || !Array.isArray(args?.tasks)) return null;
  const tasks = args.tasks.map((value): AgentTask | null => {
    const entry = record(value);
    return entry && typeof entry.agent === "string" && typeof entry.task === "string"
      ? { agent: entry.agent, task: entry.task }
      : null;
  });
  return tasks.length > 0 && tasks.every((task) => task !== null) ? (tasks as AgentTask[]) : null;
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  try { return JSON.stringify(output, null, 2); } catch { return "Не удалось показать ответ инструмента"; }
}

export function subagentLaunchStatus(item: TimelineToolCall, agent?: string): { readonly label: string; readonly detached: boolean; readonly completion?: string } {
  const output = record(item.output);
  const details = record(output?.details);
  // An async launch returning successfully is not evidence that its children finished.
  const detached = typeof details?.asyncId === "string" || typeof details?.asyncDir === "string";
  const children = Array.isArray(output?.subagentChildren) ? output.subagentChildren : [];
  const completion = agent ? record(children.find((value) => record(value)?.agent === agent))?.status ?? output?.subagentCompletion : output?.subagentCompletion;
  const labels: Record<string, string> = { completed: "Завершил", failed: "Ошибка", paused: "Приостановлен", stopped: "Остановлен", running: "Работает", pending: "Ожидает" };
  const label = typeof completion === "string" && labels[completion] ? labels[completion] : item.status === "running" ? "Запуск" : item.status === "error" ? "Ошибка запуска" : detached ? "Запуск принят" : "Вызов завершён";
  return { label, detached: detached && !completion, ...(typeof completion === "string" ? { completion } : {}) };
}

export function SubagentTool({ item, tasks }: { readonly item: TimelineToolCall; readonly tasks: readonly AgentTask[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const output = formatOutput(item.output);
  return (
    <article className="subagent-tool" data-testid="subagent-tool">
      {tasks.map((task, index) => {
        const open = expanded.has(index);
        const { label: status, detached, completion } = subagentLaunchStatus(item, task.agent);
        const tone = completion === "failed" || completion === "stopped" ? "error" : completion === "completed" ? "success" : detached || completion === "running" || completion === "pending" ? "running" : item.status;
        return (
          <div className="subagent-tool__item" key={index}>
            <button className="subagent-tool__row" type="button" aria-expanded={open} onClick={() => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(index)) next.delete(index); else next.add(index);
              return next;
            })}>
              <span className="subagent-tool__chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>
              <span className={`subagent-tool__dot subagent-tool__dot--${tone}`} aria-hidden="true" />
              <strong>{task.agent}</strong>
              <span className="subagent-tool__task">{task.task}</span>
              <span className="subagent-tool__status">{status}</span>
            </button>
            {open ? <div className="subagent-tool__details"><div><strong>Задача</strong><p>{task.task}</p></div>{output ? <div><strong>Ответ инструмента{tasks.length > 1 ? " для всего запуска" : ""}</strong><pre>{output}</pre></div> : null}{detached ? <p>Состояние субагента пока недоступно.</p> : null}</div> : null}
          </div>
        );
      })}
    </article>
  );
}
