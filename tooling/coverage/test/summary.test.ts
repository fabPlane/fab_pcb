import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { BADGE_JSON, COMMANDS_JSON, badge, badgeColor, markdownLine, summarize, type CommandRow } from "../summary";

describe("coverage summary", () => {
  const rows: CommandRow[] = [
    { command: "Ping", group: "common/base", headless: "ok" },
    { command: "GetVersion", group: "common/base", headless: "ok" },
    { command: "RunAction", group: "common/editor", headless: "gui-only" },
    { command: "Refresh", group: "common/editor", headless: "unregistered" },
  ];
  test("counts and percent", () => {
    expect(summarize(rows)).toEqual({ total: 4, headless: 2, guiOnly: 1, partial: 0, unregistered: 1, percent: 50 });
    expect(summarize([])).toMatchObject({ total: 0, percent: 0 });
  });
  test("markdown line and badge", () => {
    const s = summarize(rows);
    expect(markdownLine(s, "3c7ce604bf97e13a")).toBe(
      "IPC API coverage: **2/4** commands headless (50%) · 1 GUI-only · 1 unregistered — KiCad 3c7ce604bf",
    );
    expect(badge(s)).toEqual({ schemaVersion: 1, label: "IPC API headless", message: "2/4 (50%)", color: "yellow", cacheSeconds: 3600 });
    expect(badgeColor(96)).toBe("brightgreen");
    expect(badgeColor(86.1)).toBe("green");
  });
  test("docs/coverage-badge.json matches commands.json", async () => {
    const real = JSON.parse(await readFile(COMMANDS_JSON, "utf8")) as CommandRow[];
    const expected = JSON.stringify(badge(summarize(real)), null, 2) + "\n";
    expect(await readFile(BADGE_JSON, "utf8")).toBe(expected);
  });
});
