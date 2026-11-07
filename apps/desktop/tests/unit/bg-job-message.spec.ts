import { expect, test } from "@playwright/test";
import { summarizeBgJob } from "../../src/features/conversation/bg-job-message";

test("summarizes success without showing an unrelated error from the log", () => {
  expect(
    summarizeBgJob(
      "Фоновая задача «Проверка» завершилась успешно, 20 с.\nКоманда: test\n\nХвост лога:\nerror was expected\n\nПолный вывод: bg_logs",
    ),
  ).toEqual({
    name: "Проверка",
    outcome: "завершилась успешно",
    duration: "20 с",
    tone: "success",
  });
});

test("keeps the failure status and a log hint without interpreting it as the cause", () => {
  expect(
    summarizeBgJob(
      "Фоновая задача «Типы» завершилась с кодом 2, 6 с.\n\nХвост лога:\nfirst line\nsrc/a.ts: error TS18048\n\nПолный вывод: bg_logs",
    ),
  ).toEqual({
    name: "Типы",
    outcome: "завершилась с кодом 2",
    duration: "6 с",
    tone: "error",
    excerpt: "src/a.ts: error TS18048",
  });
});

test("unrecognized or empty messages use a neutral fallback", () => {
  for (const input of ["", "another format", "Фоновая задача «X»"]) {
    expect(summarizeBgJob(input)).toEqual({
      name: "Фоновая задача",
      outcome: "Результат доступен",
      tone: "neutral",
    });
  }
});

test("timeout, stopped, and lost are not shown as successful", () => {
  for (const outcome of [
    "снята по таймауту через 30 мин",
    "снята",
    "потеряна",
    "завершилась с кодом ?",
  ]) {
    expect(summarizeBgJob(`Фоновая задача «X» ${outcome}, 1 мин.`).tone).toBe("error");
  }
});
