import type { TimelineToolStatus } from "./timeline-types";

/**
 * The family a tool belongs to, taken from its name. The run summary counts calls by family, and
 * the collapsed row picks its glyph from the largest one, so the same rule must drive both.
 */
export type ToolFamily = "bash" | "read" | "edit" | "search" | "other";

/**
 * Human wording for a tool call, for our Russian desktop build. This is a presentation layer over
 * the transcript: tool name, arguments and result are untouched, and the technical detail
 * ("bash · done") still shows beside the phrase. When an extension registered its own label,
 * the caller keeps that label instead of this one.
 *
 * The verb follows the status: a call in flight reads "Читаю …", a settled one "Прочитал …".
 */
export function russianToolLabel(
  toolName: string,
  input: unknown,
  status: TimelineToolStatus,
): string {
  const live = status === "running";
  const name = toolName.toLowerCase();
  // pi-gui's own thread tools carry names no file or shell rule should claim.
  if (name === "read_thread") {
    const thread = textArgument(input, ["thread_id", "threadId", "id"]);
    return thread
      ? `${live ? "Читаю" : "Прочитал"} тред ${thread}`
      : `${live ? "Читаю" : "Прочитал"} тред`;
  }
  if (name === "list_threads") return live ? "Смотрю список тредов" : "Посмотрел список тредов";
  if (name === "create_child_thread")
    return live ? "Запускаю дочерний тред" : "Запустил дочерний тред";
  if (name === "send_message_to_thread")
    return live ? "Отправляю сообщение в тред" : "Отправил сообщение в тред";
  if (name === "archive_child_threads") return live ? "Архивирую треды" : "Архивировал треды";
  if (/web_?search/.test(name)) {
    const query = pattern(input);
    return query
      ? `${live ? "Ищу" : "Искал"} ${query} в интернете`
      : `${live ? "Ищу" : "Искал"} в интернете`;
  }
  if (/fetch|_url|browser|open_url/.test(name)) {
    const target = textArgument(input, ["url", "query", "path"]);
    return `${live ? "Загружаю" : "Загрузил"} ${target ? truncate(compact(target), 60) : "страницу"}`;
  }
  const family = toolFamily(toolName);
  if (family === "other") return `${live ? "Запускаю" : "Запустил"} ${toolName}`;
  if (family === "edit") {
    const file = fileName(input);
    return file
      ? `${live ? "Правлю" : "Поправил"} ${file}`
      : `${live ? "Правлю" : "Поправил"} файл`;
  }
  if (family === "read") {
    const file = fileName(input) ?? pattern(input);
    return file ? `${live ? "Читаю" : "Прочитал"} ${file}` : `${live ? "Читаю" : "Прочитал"} файл`;
  }
  if (family === "search") {
    const query = pattern(input);
    return query ? `${live ? "Ищу" : "Искал"} ${query} в коде` : `${live ? "Ищу" : "Искал"} в коде`;
  }
  const command = bashCommand(input);
  const phrase = command ? bashPhrase(command) : undefined;
  if (phrase) return live ? phrase.live : phrase.done;
  const tail = command ? `: ${truncate(command, 72)}` : "";
  return `${live ? "Запускаю" : "Запустил"} команду${tail}`;
}

export function toolFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase();
  if (/^(write|edit|patch|apply|multiedit)$/.test(name) || /file_write/.test(name)) return "edit";
  if (/^(bash|shell|exec|terminal|command|run|sh)$/.test(name) || /^run_/.test(name)) return "bash";
  if (/^(grep|glob|search|find|rg)$/.test(name) || /search|fetch|browser/.test(name))
    return "search";
  if (/^(read|view|cat|open|ls|list)$/.test(name) || /^read_|^list_/.test(name)) return "read";
  return "other";
}

interface BashPhrase {
  readonly live: string;
  readonly done: string;
}

/**
 * The commands a person repeats every day get their own wording; everything else keeps its
 * exact command after "Запустил команду", because a pretty but wrong phrase is worse than a
 * technical one.
 */
function bashPhrase(command: string): BashPhrase | undefined {
  if (/\b(docker(\s+compose)?\s+logs|kubectl\s+logs|journalctl|tail\s+-[nf])/i.test(command)) {
    return { live: "Смотрю логи", done: "Посмотрел логи" };
  }
  if (/\b(make\s+\S*up|docker\s+compose\s+up|port-forward|tunnel)\b/i.test(command)) {
    return { live: "Запускаю туннель", done: "Запустил туннель" };
  }
  if (/\b(typecheck|tsc)\b/i.test(command)) {
    return { live: "Проверяю типы", done: "Проверил типы" };
  }
  if (/\b(pytest|vitest|jest|test)\b/i.test(command)) {
    return { live: "Прогоняю тесты", done: "Прогнал тесты" };
  }
  if (/(^|\s)(rg|grep|ag|ack)\b/i.test(command)) {
    const subject = searchedWord(command);
    const tail = subject ? ` ${subject}` : "";
    return { live: `Ищу${tail} в коде`, done: `Искал${tail} в коде` };
  }
  if (/\bgit\s+(status|diff)\b/i.test(command)) {
    return { live: "Проверяю изменения", done: "Проверил изменения" };
  }
  if (/\bgit\s+commit\b/i.test(command)) {
    return { live: "Делаю коммит", done: "Сделал коммит" };
  }
  if (/\bgit\s+push\b/i.test(command)) {
    return { live: "Отправляю ветку", done: "Отправил ветку" };
  }
  if (/(^|\s)(ls|find|fd)\b/i.test(command)) {
    return { live: "Смотрю файлы", done: "Посмотрел файлы" };
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/i.test(command)) {
    return { live: "Запускаю сервер", done: "Запустил сервер" };
  }
  return undefined;
}

function bashCommand(input: unknown): string | undefined {
  if (typeof input === "string") return compact(input);
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return compact(value);
  }
  return undefined;
}

/** The word a grep-like command looks for, without flags or paths around it. */
function searchedWord(command: string): string | undefined {
  const match = command.match(/(?:^|\s)(?:rg|grep|ag|ack)\b([^|;&]*)/i);
  const rest = match?.[1];
  if (!rest) return undefined;
  for (const token of rest.split(/\s+/)) {
    // Flags and their glued values (-n, -g*.ts) are not the word being searched for.
    if (!token || token.startsWith("-")) continue;
    const word = token.replace(/^["']|["']$/g, "");
    if (!word || !/^[-.\w/]+$/.test(word)) continue;
    return truncate(word, 40);
  }
  return undefined;
}

function fileName(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return shortenPath(value.trim());
  }
  return undefined;
}

function textArgument(input: unknown, keys: readonly string[]): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return compact(value);
  }
  return undefined;
}

function pattern(input: unknown): string | undefined {
  if (typeof input === "string") return truncate(compact(input), 60);
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["pattern", "query", "glob", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return truncate(compact(value), 60);
  }
  return undefined;
}

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : parts.slice(-3).join("/");
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
