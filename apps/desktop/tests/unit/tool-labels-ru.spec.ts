import { expect, test } from "@playwright/test";
import { russianToolLabel, toolFamily } from "../../contracts/tool-labels-ru";

test("a tool's family comes from its name, in the order write, shell, search, read", () => {
  expect(toolFamily("write")).toBe("edit");
  expect(toolFamily("edit")).toBe("edit");
  expect(toolFamily("bash")).toBe("bash");
  expect(toolFamily("grep")).toBe("search");
  expect(toolFamily("read")).toBe("read");
  expect(toolFamily("read_file")).toBe("read");
});

test("a settled call reads in the past and a live one in the present", () => {
  expect(russianToolLabel("read", { path: "src/a.ts" }, "success")).toBe("Прочитал src/a.ts");
  expect(russianToolLabel("read", { path: "src/a.ts" }, "running")).toBe("Читаю src/a.ts");
  expect(russianToolLabel("edit", { file_path: "src/a.ts" }, "success")).toBe("Поправил src/a.ts");
  expect(russianToolLabel("grep", { pattern: "toolCall" }, "success")).toBe(
    "Искал toolCall в коде",
  );
});

test("long paths keep their last three segments", () => {
  const path = "/Users/me/Space/pi-gui/apps/desktop/src/features/conversation/timeline-item.tsx";
  expect(russianToolLabel("read", { path }, "success")).toBe(
    "Прочитал features/conversation/timeline-item.tsx",
  );
});

test("the daily commands get their own wording in both tenses", () => {
  const done = (command: string) => russianToolLabel("bash", { command }, "success");
  const live = (command: string) => russianToolLabel("bash", { command }, "running");
  expect(done("docker compose logs api")).toBe("Посмотрел логи");
  expect(live("tail -f /tmp/dev.log")).toBe("Смотрю логи");
  expect(done("make litellm-up")).toBe("Запустил туннель");
  expect(done("npm run typecheck")).toBe("Проверил типы");
  expect(live("npm test -- timeline")).toBe("Прогоняю тесты");
  expect(done('rg -n "toolCall"')).toBe("Искал toolCall в коде");
  expect(done("git status")).toBe("Проверил изменения");
  expect(done("git commit -m x")).toBe("Сделал коммит");
  expect(done("git push origin HEAD")).toBe("Отправил ветку");
  expect(done("ls src")).toBe("Посмотрел файлы");
  expect(live("pnpm dev")).toBe("Запускаю сервер");
});

test("an unrecognised command keeps its exact text instead of a guessed phrase", () => {
  expect(russianToolLabel("bash", { command: "./scripts/seed.sh --force" }, "success")).toBe(
    "Запустил команду: ./scripts/seed.sh --force",
  );
  expect(russianToolLabel("bash", { command: "sleep 1" }, "running")).toBe(
    "Запускаю команду: sleep 1",
  );
});

test("thread and web tools keep their own wording instead of a file phrase", () => {
  expect(russianToolLabel("read_thread", { thread_id: "01a1b0f0" }, "success")).toBe(
    "Прочитал тред 01a1b0f0",
  );
  expect(russianToolLabel("list_threads", {}, "running")).toBe("Смотрю список тредов");
  expect(russianToolLabel("web_search", { query: "pytest fixtures" }, "success")).toBe(
    "Искал pytest fixtures в интернете",
  );
  expect(russianToolLabel("fetch_content", { url: "https://example.dev/a" }, "success")).toBe(
    "Загрузил https://example.dev/a",
  );
  expect(russianToolLabel("subagent", {}, "running")).toBe("Запускаю subagent");
});
