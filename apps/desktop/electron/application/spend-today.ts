import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { TodaySpendProvider, TodaySpendSnapshot } from "../../contracts/spend";
import { resolvePiAgentDir } from "../platform/pi-agent-dir";

/**
 * Today's spend across every pi session, read from the session files pi writes.
 * No provider is contacted: the amount is already in each reply's `usage.cost`.
 *
 * Only files touched since local midnight are parsed. A file last written
 * before today cannot hold a reply from today, so the scan stays small however
 * long the history is. Replies pi copied into a fork keep their original
 * timestamps and are dropped, and ids are deduplicated across files for the
 * same reason.
 */

const CACHE_TTL_MS = 3_000;

const COST = /"cost":\{[^}]*?"total":(-?[0-9.eE+]+)/;
const ID = /"id":"([^"]+)"/;
const TIMESTAMP = /"timestamp":"([^"]+)"/;
const PROVIDER = /"provider":"([^"]+)"/;
const REPORTED = /"totalFromProvider":true/;
const NO_PROVIDER = "без провайдера";

interface CostEntry {
  readonly id: string;
  readonly cost: number;
  readonly at: number;
  readonly provider: string;
  readonly reported: boolean;
}

interface FileCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly entries: readonly CostEntry[];
}

interface ScanCache {
  readonly key: string;
  readonly scannedAt: number;
  readonly snapshot: TodaySpendSnapshot;
  readonly files: ReadonlyMap<string, FileCacheEntry>;
}

let cache: ScanCache | undefined;

/** Local midnight in milliseconds, the point where "today" starts. */
export function localDayStart(now: number): number {
  return new Date(now).setHours(0, 0, 0, 0);
}

/**
 * Cost entries of one session file. Provider and model fall back to the last
 * `model_change` because sub-agent tool results can carry no provider of their
 * own.
 */
export function parseCostEntries(text: string): CostEntry[] {
  const entries: CostEntry[] = [];
  let provider = "";
  for (const line of text.split("\n")) {
    if (line.includes('"model_change"')) {
      provider = PROVIDER.exec(line)?.[1] ?? provider;
      continue;
    }
    if (!line.includes('"cost"')) continue;
    const cost = COST.exec(line);
    if (!cost) continue;
    const value = Number(cost[1]);
    if (!Number.isFinite(value)) continue;
    const at = Date.parse(TIMESTAMP.exec(line)?.[1] ?? "");
    entries.push({
      id: ID.exec(line)?.[1] ?? "",
      cost: value,
      at: Number.isFinite(at) ? at : 0,
      provider: PROVIDER.exec(line)?.[1] ?? provider,
      reported: REPORTED.test(line),
    });
  }
  return entries;
}

/** Every session file under the root, including sub-agent runs at any depth. */
export function listSessionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let items: Dirent[];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      // Symlinks are listed too, so a dangling one shows up as an unreadable file
      // instead of silently shrinking the total.
      else if (item.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

export interface ReadTodaySpendOptions {
  /** Overrides `$PI_CODING_AGENT_DIR/sessions`; tests point this at a fixture. */
  readonly sessionsRoot?: string;
  readonly now?: number;
  /** Tests bypass the in-process cache so a rewritten fixture is read again. */
  readonly fresh?: boolean;
}

export function readTodaySpend(options: ReadTodaySpendOptions = {}): TodaySpendSnapshot {
  const now = options.now ?? Date.now();
  const root = options.sessionsRoot ?? join(resolvePiAgentDir(), "sessions");
  const dayStart = localDayStart(now);
  const key = `${root}\0${dayStart}`;
  if (!options.fresh && cache && cache.key === key && now - cache.scannedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const previous = cache && cache.key === key ? cache.files : new Map<string, FileCacheEntry>();
  const files = new Map<string, FileCacheEntry>();
  const seen = new Set<string>();
  const perProvider = new Map<string, { reported: number; estimated: number; requests: number }>();
  let reported = 0;
  let estimated = 0;
  let requests = 0;
  let incomplete = false;

  for (const file of listSessionFiles(root)) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(file);
    } catch {
      incomplete = true;
      continue;
    }
    // A file last written before today started cannot contain today's replies.
    if (stat.mtimeMs < dayStart) continue;

    const cached = previous.get(file);
    let entries: readonly CostEntry[];
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      entries = cached.entries;
    } else {
      try {
        entries = parseCostEntries(readFileSync(file, "utf8"));
      } catch {
        incomplete = true;
        continue;
      }
    }
    files.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });

    entries.forEach((entry, index) => {
      if (entry.at < dayStart) return;
      const id = entry.id || `${file}#${index}`;
      if (seen.has(id)) return;
      seen.add(id);

      const provider = entry.provider || NO_PROVIDER;
      const row = perProvider.get(provider) ?? { reported: 0, estimated: 0, requests: 0 };
      row.requests += 1;
      requests += 1;
      if (entry.reported) {
        row.reported += entry.cost;
        reported += entry.cost;
      } else {
        row.estimated += entry.cost;
        estimated += entry.cost;
      }
      perProvider.set(provider, row);
    });
  }

  const providers: TodaySpendProvider[] = [...perProvider]
    .map(([provider, row]) => ({ provider, ...row }))
    .sort((left, right) => right.reported + right.estimated - (left.reported + left.estimated));

  const snapshot: TodaySpendSnapshot = {
    dayStartedAt: new Date(dayStart).toISOString(),
    readAt: new Date(now).toISOString(),
    reported: round(reported),
    estimated: round(estimated),
    requests,
    providers: providers.map((row) => ({
      ...row,
      reported: round(row.reported),
      estimated: round(row.estimated),
    })),
    incomplete,
  };
  cache = { key, scannedAt: now, snapshot, files };
  return snapshot;
}

/** Keeps float noise from 0.1 + 0.2 out of the UI. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Test seam: forget the in-process cache between fixture rewrites. */
export function resetTodaySpendCache(): void {
  cache = undefined;
}
