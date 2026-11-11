export interface SubagentRunNotice {
  readonly runId: string;
  readonly status: "completed" | "failed" | "paused" | "stopped";
  readonly children?: readonly { readonly agent: string; readonly status: string }[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only the extension's documented host metadata is read, never its hidden message text. */
export function subagentRunNotices(message: unknown): SubagentRunNotice[] {
  const source = object(message);
  if (source?.role !== "custom" || source.customType !== "subagent-notify") return [];
  const runs = object(source.details)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((value) => {
    const run = object(value);
    if (!run || typeof run.runId !== "string" || !["completed", "failed", "paused", "stopped"].includes(String(run.status))) return [];
    const children = Array.isArray(run.childRuns) ? run.childRuns.flatMap((value) => {
      const child = object(value);
      return child && typeof child.agent === "string" && typeof child.status === "string" ? [{ agent: child.agent, status: child.status }] : [];
    }) : [];
    return [{ runId: run.runId, status: run.status as SubagentRunNotice["status"], ...(children.length ? { children } : {}) }];
  });
}

/** Match a single child by the extension's explicit run id; never infer parallel child outcomes. */
export function applySubagentRunNotices<T extends { readonly kind: string }>(items: T[], notices: readonly SubagentRunNotice[]): void {
  for (let i = 0; i < items.length; i++) {
    const item = object(items[i]);
    if (item?.kind !== "tool" || item.toolName !== "subagent") continue;
    const input = object(item.input);
    const single = typeof input?.agent === "string" && typeof input.task === "string";
    const tasks = input?.workflow === "parallel" ? object(input.args)?.tasks : undefined;
    const parallel = Array.isArray(tasks);
    if (!single && !parallel) continue;
    const output = object(item.output);
    const runId = object(output?.details)?.asyncId;
    if (typeof runId !== "string") continue;
    const notice = notices.find((entry) => entry.runId === runId);
    if (!notice) continue;
    if (single) {
      items[i] = { ...items[i], output: { ...output, subagentCompletion: notice.status } } as unknown as T;
    } else if (parallel && notice.children) {
      const children = notice.children.filter((child) => notice.children?.filter((other) => other.agent === child.agent).length === 1 && tasks.filter((task) => object(task)?.agent === child.agent).length === 1);
      if (children.length) items[i] = { ...items[i], output: { ...output, subagentChildren: children } } as unknown as T;
    }
  }
}
