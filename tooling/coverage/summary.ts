#!/usr/bin/env bun
/**
 * Coverage summary for the README and a shields.io endpoint badge.
 *
 * Reads tooling/coverage/commands.json (written by run.ts) and prints one markdown line with the
 * headless / GUI-only / partial / unregistered counts; with --badge it also writes
 * docs/coverage-badge.json in the shields.io "endpoint" schema
 * (https://img.shields.io/endpoint?url=<raw url of docs/coverage-badge.json>).
 *
 *   bun tooling/coverage/summary.ts            # print the markdown line
 *   bun tooling/coverage/summary.ts --badge    # also (re)write docs/coverage-badge.json
 *   bun tooling/coverage/summary.ts --json     # print the badge JSON instead of markdown
 *   bun tooling/coverage/summary.ts --check    # exit 1 if docs/coverage-badge.json is stale
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(TOOL_DIR, "..", "..");
export const COMMANDS_JSON = join(TOOL_DIR, "commands.json");
export const BADGE_JSON = join(REPO_DIR, "docs", "coverage-badge.json");

export type Headless = "ok" | "gui-only" | "partial" | "unregistered";
export interface CommandRow {
  command: string;
  group: string;
  headless: Headless;
}
export interface Summary {
  total: number;
  headless: number;
  guiOnly: number;
  partial: number;
  unregistered: number;
  /** headless / total, 0..100 */
  percent: number;
}
export interface Badge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
}

export function summarize(rows: CommandRow[]): Summary {
  const count = (h: Headless) => rows.filter((r) => r.headless === h).length;
  const total = rows.length;
  const headless = count("ok");
  return {
    total,
    headless,
    guiOnly: count("gui-only"),
    partial: count("partial"),
    unregistered: count("unregistered"),
    percent: total === 0 ? 0 : Math.round((headless / total) * 1000) / 10,
  };
}

export function markdownLine(s: Summary, commit?: string): string {
  const parts = [`**${s.headless}/${s.total}** commands headless (${s.percent}%)`, `${s.guiOnly} GUI-only`];
  if (s.partial) parts.push(`${s.partial} partial`);
  parts.push(`${s.unregistered} unregistered`);
  return `IPC API coverage: ${parts.join(" · ")}${commit ? ` — KiCad ${commit.slice(0, 10)}` : ""}`;
}

export function badgeColor(percent: number): string {
  if (percent >= 95) return "brightgreen";
  if (percent >= 85) return "green";
  if (percent >= 70) return "yellowgreen";
  if (percent >= 50) return "yellow";
  return "orange";
}

export function badge(s: Summary): Badge {
  return {
    schemaVersion: 1,
    label: "IPC API headless",
    message: `${s.headless}/${s.total} (${s.percent}%)`,
    color: badgeColor(s.percent),
    cacheSeconds: 3600,
  };
}

async function readCommit(): Promise<string | undefined> {
  return (await readFile(join(REPO_DIR, "packages", "proto", "KICAD_COMMIT"), "utf8").catch(() => "")).trim() || undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rows = JSON.parse(await readFile(COMMANDS_JSON, "utf8")) as CommandRow[];
  const s = summarize(rows);
  const b = badge(s);
  const json = JSON.stringify(b, null, 2) + "\n";
  if (args.includes("--check")) {
    const onDisk = await readFile(BADGE_JSON, "utf8").catch(() => "");
    if (onDisk !== json) {
      console.error(`docs/coverage-badge.json is stale; run \`bun run coverage:summary --badge\``);
      process.exit(1);
    }
    console.log("docs/coverage-badge.json is up to date");
  } else if (args.includes("--json")) {
    process.stdout.write(json);
  } else {
    console.log(markdownLine(s, await readCommit()));
  }
  if (args.includes("--badge")) {
    await writeFile(BADGE_JSON, json);
    console.log(`wrote ${BADGE_JSON}`);
  }
}
