import { expect, test } from "@playwright/test";
import type { SessionExtensionUiStateRecord } from "../../contracts/desktop-state";
import { buildExtensionDockModel } from "../../src/features/extensions/extension-session-ui";

function uiState(
  statuses: readonly (readonly [string, string])[],
  widgets: readonly { readonly key: string; readonly lines: readonly string[] }[] = [],
): SessionExtensionUiStateRecord {
  return {
    statuses: statuses.map(([key, text]) => ({ key, text })),
    widgets: widgets.map((widget) => ({
      ...widget,
      lines: [...widget.lines],
      placement: "aboveComposer" as const,
    })),
  } as unknown as SessionExtensionUiStateRecord;
}

test("the collapsed bar keeps every status, whatever order extensions loaded in", () => {
  const dock = buildExtensionDockModel(
    uiState([
      ["spend", "сегодня $0.12 · 30д $25.98"],
      ["codex-limits", "Codex ост. 5ч 71%"],
      ["preset", "preset:разработка"],
    ]),
  );

  expect(dock?.summaryText).toBe(
    "сегодня $0.12 · 30д $25.98 · Codex ост. 5ч 71% · preset:разработка",
  );
});

test("repeated and blank statuses do not pad the bar", () => {
  const dock = buildExtensionDockModel(
    uiState([
      ["a", "готово"],
      ["b", "готово"],
      ["c", "   "],
    ]),
  );

  expect(dock?.summaryText).toBe("готово");
});

test("a widget's first line joins the statuses, multi-line statuses flatten", () => {
  const dock = buildExtensionDockModel(
    uiState([["bg", "1 идёт"]], [{ key: "jobs", lines: ["", "задача: сборка"] }]),
  );

  expect(dock?.summaryText).toBe("1 идёт · задача: сборка");

  const multiline = buildExtensionDockModel(uiState([["status", "первая\nвторая"]]));
  expect(multiline?.summaryText).toBe("первая вторая");
});

test("an empty dock falls back to the generic label", () => {
  expect(buildExtensionDockModel(uiState([]))).toBeUndefined();
});
