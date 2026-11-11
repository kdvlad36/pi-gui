import type { TimelineToolCall } from "../../../contracts/timeline-types";

// Only recognize simple shell words, never substitutions, redirections or pipelines.
// A preceding cd and plain ls joined by && are safe: rg runs only if they succeeded.
//
// The scanner below is the linear equivalent of
// `^\s*(?:cd\s+WORD\s*&&\s*)?(?:ls\s*&&\s*)?rg(?:\s+WORD)+\s*$`.
// Written as nested regex quantifiers it backtracked exponentially on commands like
// `cd /some/long/path && wc -l ...` and froze the renderer thread.
const WORD_BREAK = new Set(['"', "'", "\\", "$", "`", ";", "&", "|", "<", ">", "(", ")"]);
// Same character class as `\s` in a regex, kept in one place so word scanning and
// whitespace skipping can never disagree.
const SPACE = /\s/;
const DOUBLE_QUOTE_BREAK = new Set(['"', "\\", "$", "`"]);

function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE.test(char);
}

function isWordBreak(char: string | undefined): boolean {
  return char === undefined || isSpace(char) || WORD_BREAK.has(char);
}

function isDoubleQuoteBreak(char: string | undefined): boolean {
  return char === undefined || DOUBLE_QUOTE_BREAK.has(char);
}

function skipSpaces(text: string, from: number): number {
  let index = from;
  while (index < text.length && isSpace(text[index])) index += 1;
  return index;
}

/** Reads one shell word as concatenated plain runs, 'single' and "double" quotes. */
function readSimpleWord(text: string, from: number): number | null {
  let index = from;
  let matched = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end === -1) return null;
      index = end + 1;
      matched = true;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < text.length && !isDoubleQuoteBreak(text[cursor])) cursor += 1;
      if (text[cursor] !== '"') return null;
      index = cursor + 1;
      matched = true;
      continue;
    }
    if (!isWordBreak(char)) {
      while (index < text.length && !isWordBreak(text[index])) index += 1;
      matched = true;
      continue;
    }
    break;
  }
  return matched ? index : null;
}

/** Matches `keyword\s+WORD\s*&&\s*` and returns the index after it, or null. */
function readKeywordPrefix(text: string, from: number, keyword: string): number | null {
  if (!text.startsWith(keyword, from)) return null;
  const afterKeyword = from + keyword.length;
  if (afterKeyword >= text.length || !isSpace(text[afterKeyword])) return null;
  const wordStart = skipSpaces(text, afterKeyword);
  const wordEnd = readSimpleWord(text, wordStart);
  if (wordEnd === null) return null;
  const andStart = skipSpaces(text, wordEnd);
  if (!text.startsWith("&&", andStart)) return null;
  return skipSpaces(text, andStart + 2);
}

function isSimpleRipgrepCommand(command: string): boolean {
  let index = skipSpaces(command, 0);
  const afterCd = readKeywordPrefix(command, index, "cd");
  if (afterCd !== null) index = afterCd;
  if (command.startsWith("ls", index)) {
    const afterLs = skipSpaces(command, index + 2);
    if (command.startsWith("&&", afterLs)) index = skipSpaces(command, afterLs + 2);
  }
  if (!command.startsWith("rg", index)) return false;
  index += 2;
  let wordCount = 0;
  for (;;) {
    const wordStart = skipSpaces(command, index);
    if (wordStart === index) {
      // `rg` and every argument must be separated by whitespace.
      return wordCount > 0 && wordStart >= command.length;
    }
    if (wordStart >= command.length) return wordCount > 0;
    const wordEnd = readSimpleWord(command, wordStart);
    if (wordEnd === null) return false;
    wordCount += 1;
    index = wordEnd;
  }
}

/** Display-only interpretation: the underlying tool status and output remain unchanged. */
export function isEmptySearch(tool: TimelineToolCall): boolean {
  if (tool.toolName !== "bash" || tool.status !== "error") return false;
  if (typeof tool.input !== "object" || tool.input === null) return false;
  const command = (tool.input as Record<string, unknown>).command;
  if (typeof command !== "string" || !isSimpleRipgrepCommand(command)) return false;
  const output = tool.output;
  const content =
    typeof output === "string"
      ? output
      : typeof output === "object" &&
          output !== null &&
          Array.isArray((output as Record<string, unknown>).content)
        ? (output as { content: unknown[] }).content
            .map((part) =>
              typeof part === "object" &&
              part !== null &&
              (part as Record<string, unknown>).type === "text"
                ? (part as Record<string, unknown>).text
                : "",
            )
            .filter((text): text is string => typeof text === "string")
            .join("\n")
        : "";
  return (
    /(?:^|\n)Command exited with code 1\s*$/.test(content) &&
    !/(?:^|\n)(?:rg:|ls:|(?:\/\S*\/)?bash:)/.test(content)
  );
}
