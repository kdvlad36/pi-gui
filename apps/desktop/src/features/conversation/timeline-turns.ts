import type { TurnChangeSummary } from "../../../contracts/review";
import type {
  DisplayTimelineItem,
  TimelineToolCall,
  TimelineTranscriptItem,
  TimelineTurnMarker,
} from "../../../contracts/timeline-types";

const MIN_WORKED_DURATION_MS = 1_000;

function isUserMessage(item: TimelineTranscriptItem | undefined): boolean {
  return item?.kind === "message" && item.role === "user";
}

/**
 * Insert "Worked for Ns" turn markers, derived purely from real message/tool
 * timestamps. A turn begins at a user message and runs until the next user
 * message; the marker sits directly above the turn's final assistant reply
 * (Codex-style), or at the end of the turn when it has no assistant reply, and
 * reports the elapsed time from the prompt to the last item of that turn.
 *
 * Durations are never fabricated: a marker is emitted only when the turn has
 * downstream work and both endpoints carry parseable timestamps spanning at
 * least one second. The turn still in progress gets no marker, since its final
 * reply is not known yet.
 *
 * Each captured turn that changed files gets a changes card at the end of that turn: after
 * the last transcript item of the turn and any rows that follow it, before the next user
 * message or extension message.
 *
 * While the last turn runs, a "Working" line is appended after everything else so it sits
 * where the newest output appears.
 */
/** An assistant row with nothing to draw: a thinking-only step of a live run. */
function isEmptyAssistantMessage(item: TimelineTranscriptItem | DisplayTimelineItem): boolean {
  return (
    item.kind === "message" &&
    item.role === "assistant" &&
    item.text.trim() === "" &&
    !item.attachments?.length
  );
}

export function buildDisplayTimelineItems(
  transcript: readonly TimelineTranscriptItem[],
  options: {
    readonly lastTurnRunning?: boolean;
    /** When the running turn started; shown as elapsed time on the "Working" line. */
    readonly runningSince?: string;
    readonly turnChanges?: readonly TurnChangeSummary[];
  } = {},
): readonly DisplayTimelineItem[] {
  // Thinking-only assistant steps carry no text, so they neither draw a row nor break a run.
  const visible = transcript.filter((item) => !isEmptyAssistantMessage(item));
  // Marker to emit immediately before the transcript item at that index.
  // Index `transcript.length` means "after the last item".
  const markersBefore = new Map<number, TimelineTurnMarker>();

  for (let start = 0; start < visible.length; start += 1) {
    const prompt = visible[start];
    if (!prompt || !isUserMessage(prompt)) {
      continue;
    }

    let end = start + 1;
    while (end < visible.length && !isUserMessage(visible[end])) {
      end += 1;
    }
    if (end === visible.length && options.lastTurnRunning) {
      break;
    }

    const startMs = Date.parse(prompt.createdAt);
    if (Number.isNaN(startMs)) {
      continue;
    }

    let endMs: number | null = null;
    let finalReplyIndex: number | null = null;
    for (let index = start + 1; index < end; index += 1) {
      const item = visible[index];
      if (!item) {
        continue;
      }
      if (item.kind === "message" && item.role === "assistant") {
        finalReplyIndex = index;
      }
      // An extension can post into the thread long after the run settled, and a keyed card
      // carries its latest write's time; a message steered into the run is already covered
      // by the reply that follows it.
      if (item.kind === "custom" || item.kind === "card") {
        continue;
      }
      const itemMs = Date.parse(item.createdAt);
      if (!Number.isNaN(itemMs)) {
        endMs = endMs == null ? itemMs : Math.max(endMs, itemMs);
      }
    }

    if (endMs == null || endMs - startMs < MIN_WORKED_DURATION_MS) {
      continue;
    }

    markersBefore.set(finalReplyIndex ?? end, {
      kind: "turn-marker",
      id: `turn-marker:${prompt.id}`,
      durationMs: endMs - startMs,
    });
  }

  const cardsAfter = turnChangeCardPositions(visible, options.turnChanges ?? []);
  if (markersBefore.size === 0 && cardsAfter.size === 0 && !options.lastTurnRunning) {
    return groupToolRuns(visible);
  }

  const result: DisplayTimelineItem[] = [];
  for (let index = 0; index <= visible.length; index += 1) {
    const marker = markersBefore.get(index);
    if (marker) {
      result.push(marker);
    }
    const item = visible[index];
    if (item) {
      result.push(item);
    }
    for (const turn of cardsAfter.get(index) ?? []) {
      result.push({ kind: "turn-changes", id: `turn-changes:${turn.checkpointId}`, turn });
    }
  }
  if (options.lastTurnRunning) {
    result.push({ kind: "working", id: "working-indicator", startedAt: options.runningSince });
  }
  return groupToolRuns(result);
}

/**
 * Folds runs of adjacent tool calls into one row. Prose, turn markers and extension cards end a
 * run, so "said what it would do, then did it" keeps its order. A run of one call stays a plain
 * tool row: a one-line group would only add a second level to open.
 */
export function groupToolRuns(
  items: readonly DisplayTimelineItem[],
): readonly DisplayTimelineItem[] {
  const grouped: DisplayTimelineItem[] = [];
  let run: TimelineToolCall[] = [];
  const flush = () => {
    const [first, ...rest] = run;
    run = [];
    if (!first) return;
    if (rest.length === 0) grouped.push(first);
    else
      grouped.push({
        kind: "tool-run",
        id: `tool-run:${first.callId}`,
        tools: [first, ...rest],
      });
  };
  for (const item of items) {
    if (isEmptyAssistantMessage(item)) continue;
    if (item.kind === "tool") run.push(item);
    else {
      flush();
      grouped.push(item);
    }
  }
  flush();
  return grouped;
}

function turnChangeCardPositions(
  transcript: readonly TimelineTranscriptItem[],
  turnChanges: readonly TurnChangeSummary[],
): ReadonlyMap<number, TurnChangeSummary[]> {
  const positions = new Map<number, TurnChangeSummary[]>();
  if (turnChanges.length === 0) return positions;
  const turnByEntry = new Map<string, TurnChangeSummary>();
  for (const turn of turnChanges)
    for (const entryId of turn.entryIds) turnByEntry.set(entryId, turn);
  const lastIndex = new Map<TurnChangeSummary, number>();
  transcript.forEach((item, index) => {
    if (item.kind !== "message") return;
    const turn = turnByEntry.get(item.sourceMessageId ?? item.id);
    if (turn) lastIndex.set(turn, index);
  });
  // Cards keep the capture order when several turns end at the same row.
  for (const turn of turnChanges) {
    let index = lastIndex.get(turn);
    if (index === undefined) continue;
    while (index + 1 < transcript.length && !startsAnotherTurn(transcript[index + 1], turn)) {
      index += 1;
    }
    positions.set(index, [...(positions.get(index) ?? []), turn]);
  }
  return positions;

  function startsAnotherTurn(item: TimelineTranscriptItem | undefined, turn: TurnChangeSummary) {
    // A later extension message or card is not part of the turn's work, so the card stays above it.
    if (item?.kind === "custom" || item?.kind === "card") return true;
    if (item?.kind !== "message") return false;
    const owner = turnByEntry.get(item.sourceMessageId ?? item.id);
    return item.role === "user" || (owner !== undefined && owner !== turn);
  }
}
