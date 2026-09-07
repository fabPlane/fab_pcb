#!/usr/bin/env bun
/**
 * IPC API coverage analysis.
 *
 * Enumerates every request message in the kiapi command protos (from the generated descriptors in
 * @fp-pcb/proto), scans the KiCad C++ API handlers for `registerHandler<Req, Res>` calls and
 * `checkForHeadless( "Req" )` gates, and writes:
 *
 *   tooling/coverage/commands.json   machine-readable table consumed by the client generator
 *   docs/api-coverage.md             the human-readable matrix
 *
 *   bun run coverage                 (from the repo root; KICAD_SRC overrides ../kicad)
 *   bun run run.ts --check           exit 1 if the outputs on disk are stale
 *   KICAD_WORKTREE=1 bun run coverage   analyse the working tree instead of git HEAD
 *
 * Sources are read from the checkout's git HEAD by default so the matrix matches the commit pinned
 * in packages/proto/KICAD_COMMIT even while uncommitted API patches sit in the working tree.
 *
 * A command counts as GUI-only in a handler when the handler wraps it in `checkForHeadless( "Name" )`
 * or registers it with `HANDLER_MODE::GUI_ONLY`.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DescFile, DescMessage } from "@bufbuild/protobuf";
import { kiapiFiles, kiapiRegistry, wellKnownFiles } from "@fp-pcb/proto";

export const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = resolve(TOOL_DIR, "..", "..");

/** Command proto files and the group label / order used in the matrix. */
export const COMMAND_FILES: ReadonlyArray<{ proto: string; group: string }> = [
  { proto: "common/commands/base_commands.proto", group: "common/base" },
  { proto: "common/commands/project_commands.proto", group: "common/project" },
  { proto: "common/commands/editor_commands.proto", group: "common/editor" },
  { proto: "common/commands/library_commands.proto", group: "common/library" },
  { proto: "common/commands/settings_commands.proto", group: "common/settings" },
  { proto: "common/commands/variant_commands.proto", group: "common/variant" },
  { proto: "common/commands/cross_probe_commands.proto", group: "common/crossprobe" },
  { proto: "board/board_commands.proto", group: "board/commands" },
  { proto: "board/board_jobs.proto", group: "board/jobs" },
  { proto: "schematic/schematic_commands.proto", group: "sch/commands" },
  { proto: "schematic/schematic_jobs.proto", group: "sch/jobs" },
];

/** Handler sources, in the order handlers are listed in the matrix. */
export const HANDLER_FILES: ReadonlyArray<{ path: string; handler: string; cls: string }> = [
  { path: "common/api/api_server.cpp", handler: "server", cls: "API_HANDLER_SERVER (inside the API server, always loaded)" },
  { path: "common/api/api_handler_common.cpp", handler: "common", cls: "API_HANDLER_COMMON" },
  { path: "common/api/api_handler_editor.cpp", handler: "editor", cls: "API_HANDLER_EDITOR" },
  {
    path: "common/api/api_handler_library.cpp",
    handler: "library",
    cls: "API_HANDLER_LIBRARY (base of the footprint and symbol library handlers)",
  },
  { path: "pcbnew/api/api_handler_board.cpp", handler: "board", cls: "API_HANDLER_BOARD" },
  { path: "pcbnew/api/api_handler_pcb.cpp", handler: "pcb", cls: "API_HANDLER_PCB" },
  { path: "pcbnew/api/api_handler_footprint.cpp", handler: "footprint", cls: "API_HANDLER_FOOTPRINT" },
  { path: "pcbnew/api/api_handler_footprint_library.cpp", handler: "fplib", cls: "API_HANDLER_FOOTPRINT_LIBRARY" },
  { path: "eeschema/api/api_handler_symbol_library.cpp", handler: "symlib", cls: "API_HANDLER_SYMBOL_LIBRARY" },
  { path: "eeschema/api/api_handler_sch.cpp", handler: "sch", cls: "API_HANDLER_SCH" },
  { path: "kicad/cli/command_api_server.cpp", handler: "cli", cls: "kicad-cli api-server" },
];

/**
 * A top-level message in a command proto is a request when a handler registers it, or when its name
 * carries no response/data-type suffix and starts with an imperative verb. Everything else
 * (XxxResponse, XxxResult, ItemStatus, SelectionSpec, PathEntry, SaveOptions, BoardPlotSettings,
 * TextOrTextBox, BoardLayers, BOMField, ...) is a payload type.
 */
const NON_REQUEST_SUFFIX = /(Response|Result|Status|Spec|Entry|Options|Settings)$/;
const REQUEST_VERB =
  /^(Get|Set|Add|Delete|Remove|Rename|Copy|Clear|Close|Open|Save|Revert|Run|Begin|End|Create|Update|Hit|Refresh|Expand|Ping|Flip|Interactive|Import|Refill|Inject|Parse|Check|CrossProbe|Sync|Highlight|Focus)[A-Z0-9]/;

export type Headless = "ok" | "gui-only" | "partial" | "unregistered";

export interface Registration {
  handler: string;
  responseType: string;
  /** true when the handler wraps the command in checkForHeadless() */
  gated: boolean;
}

export interface CommandInfo {
  command: string;
  group: string;
  requestType: string;
  /** Full proto name of the response; null when no handler registers the command. */
  responseType: string | null;
  handlers: string[];
  headless: Headless;
  registrations: Registration[];
}

export interface CoverageResult {
  kicadCommit: string;
  kicadVersion: string;
  commands: CommandInfo[];
  /** Top-level messages in the command protos that were classified as payload types. */
  skipped: string[];
  warnings: string[];
}

export function kicadSrc(): string {
  const dir = resolve(process.env.KICAD_SRC ?? join(REPO_DIR, "..", "kicad"));
  if (!existsSync(join(dir, "api", "proto", "common", "envelope.proto"))) {
    throw new Error(`KiCad checkout not found at ${dir} (set KICAD_SRC)`);
  }
  return dir;
}

function gitHead(src: string): string {
  const r = Bun.spawnSync(["git", "-C", src, "rev-parse", "HEAD"]);
  if (r.exitCode !== 0) throw new Error(`git rev-parse failed in ${src}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export function useWorktree(): boolean {
  return process.env.KICAD_WORKTREE === "1";
}

/** Every `*_commands.proto` / `*_jobs.proto` under api/proto, as repo-relative paths. */
async function listCommandProtos(src: string): Promise<string[]> {
  const r = Bun.spawnSync(
    useWorktree()
      ? ["git", "-C", src, "ls-files", "api/proto"]
      : ["git", "-C", src, "ls-tree", "-r", "--name-only", "HEAD", "api/proto"],
  );
  if (r.exitCode !== 0) throw new Error(`git failed listing protos in ${src}: ${r.stderr.toString()}`);
  return r.stdout
    .toString()
    .split("\n")
    .filter((f) => /_(commands|jobs)\.proto$/.test(f))
    .map((f) => f.replace(/^api\/proto\//, ""))
    .sort();
}

/** Reads a file from the checkout: git HEAD by default, the working tree with KICAD_WORKTREE=1. */
async function readSource(src: string, path: string): Promise<string | undefined> {
  if (useWorktree()) return readFile(join(src, path), "utf8").catch(() => undefined);
  const r = Bun.spawnSync(["git", "-C", src, "show", `HEAD:${path}`]);
  return r.exitCode === 0 ? r.stdout.toString() : undefined;
}

async function kicadVersion(src: string): Promise<string> {
  const text = (await readSource(src, "cmake/KiCadVersion.cmake")) ?? "";
  const m = /KICAD_SEMANTIC_VERSION\s+"(\d+\.\d+)/.exec(text);
  return m?.[1] ?? "unknown";
}

/** Builds simpleName -> candidate descriptors for every message in the registry (kiapi + well-known). */
function simpleNameIndex(): Map<string, DescMessage[]> {
  const idx = new Map<string, DescMessage[]>();
  const visit = (m: DescMessage) => {
    const simple = m.name;
    (idx.get(simple) ?? idx.set(simple, []).get(simple)!).push(m);
    m.nestedMessages.forEach(visit);
  };
  for (const f of [...kiapiFiles, ...wellKnownFiles] as DescFile[]) f.messages.forEach(visit);
  return idx;
}

/**
 * Resolves a C++ type spelling (`GetVersion`, `commands::GetVersion`, `types::Box2`,
 * `google::protobuf::Empty`) to a full proto name. `preferred` lists package prefixes to try when the
 * simple name is ambiguous.
 */
export function resolveTypeName(spelling: string, idx: Map<string, DescMessage[]>, preferred: string[]): string {
  const parts = spelling.trim().split("::").filter(Boolean);
  const simple = parts[parts.length - 1]!;
  const candidates = idx.get(simple);
  if (!candidates || candidates.length === 0) throw new Error(`unknown proto message for C++ type "${spelling}"`);
  if (candidates.length === 1) return candidates[0]!.typeName;
  const qualified = parts.join(".");
  const bySuffix = candidates.filter((c) => c.typeName.endsWith("." + qualified));
  if (bySuffix.length === 1) return bySuffix[0]!.typeName;
  for (const p of preferred) {
    const hit = (bySuffix.length ? bySuffix : candidates).filter((c) => c.typeName.startsWith(p + "."));
    if (hit.length === 1) return hit[0]!.typeName;
  }
  throw new Error(`ambiguous C++ type "${spelling}": ${candidates.map((c) => c.typeName).join(", ")}`);
}

export interface HandlerScan {
  handler: string;
  registrations: { request: string; response: string; guiOnly: boolean }[];
  /** simple request names wrapped in checkForHeadless("...") */
  gated: Set<string>;
}

/**
 * Extracts registerHandler<Req, Res>( ... ) pairs (noting a HANDLER_MODE::GUI_ONLY argument) and
 * checkForHeadless("Name") gates from one C++ source.
 */
export function scanHandlerSource(handler: string, text: string): HandlerScan {
  const registrations: HandlerScan["registrations"] = [];
  for (const m of text.matchAll(/registerHandler\s*<\s*([\w:]+)\s*,\s*([\w:]+)\s*>\s*\(([^;]*)\)\s*;/g)) {
    registrations.push({ request: m[1]!, response: m[2]!.trim(), guiOnly: /\bGUI_ONLY\b/.test(m[3]!) });
  }
  const gated = new Set<string>();
  for (const m of text.matchAll(/checkForHeadless\s*\(\s*"(\w+)"\s*\)/g)) gated.add(m[1]!);
  return { handler, registrations, gated };
}

const PREFERRED_PACKAGES = [
  "kiapi.common.commands",
  "kiapi.board.commands",
  "kiapi.schematic.commands",
  "kiapi.common.types",
  "kiapi.common",
];

export async function analyze(src = kicadSrc()): Promise<CoverageResult> {
  const warnings: string[] = [];
  const idx = simpleNameIndex();

  // 1. handlers
  const scans: HandlerScan[] = [];
  for (const h of HANDLER_FILES) {
    const text = await readSource(src, h.path);
    if (text === undefined) {
      warnings.push(`handler source missing: ${h.path}`);
      continue;
    }
    scans.push(scanHandlerSource(h.handler, text));
  }
  const byRequest = new Map<string, Registration[]>();
  for (const s of scans) {
    for (const r of s.registrations) {
      const req = resolveTypeName(r.request, idx, PREFERRED_PACKAGES);
      const res = resolveTypeName(r.response, idx, PREFERRED_PACKAGES);
      const simple = req.split(".").pop()!;
      (byRequest.get(req) ?? byRequest.set(req, []).get(req)!).push({
        handler: s.handler,
        responseType: res,
        gated: r.guiOnly || s.gated.has(simple),
      });
    }
    for (const g of s.gated) {
      if (!s.registrations.some((r) => r.request.split("::").pop() === g)) {
        warnings.push(`${s.handler}: checkForHeadless("${g}") without a matching registerHandler`);
      }
    }
  }

  // 2. request messages
  const fileByName = new Map((kiapiFiles as DescFile[]).map((f) => [f.proto.name, f]));
  const commands: CommandInfo[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  // A command proto that nobody lists here silently produces zero client wrappers, which happened
  // for library_commands.proto: four commits shipped with no way to call them. Fail instead.
  for (const proto of await listCommandProtos(src)) {
    if (!COMMAND_FILES.some((c) => c.proto === proto)) {
      throw new Error(
        `${proto} defines commands but is not in COMMAND_FILES (tooling/coverage/run.ts); ` +
          `add it with a group name so the client gets wrappers for it`,
      );
    }
  }
  for (const { proto, group } of COMMAND_FILES) {
    const file = fileByName.get(proto);
    if (!file) throw new Error(`command proto ${proto} is not in the generated descriptors; run \`bun run gen\``);
    const rows: CommandInfo[] = [];
    for (const msg of file.messages) {
      const regs = byRequest.get(msg.typeName) ?? [];
      const isRequest = regs.length > 0 || (!NON_REQUEST_SUFFIX.test(msg.name) && REQUEST_VERB.test(msg.name));
      if (!isRequest) {
        skipped.push(msg.typeName);
        continue;
      }
      seen.add(msg.typeName);
      const responses = new Set(regs.map((r) => r.responseType));
      if (responses.size > 1) {
        warnings.push(`${msg.name}: handlers disagree on the response type: ${[...responses].join(", ")}`);
      }
      const gated = regs.filter((r) => r.gated).length;
      const headless: Headless = regs.length === 0 ? "unregistered" : gated === 0 ? "ok" : gated === regs.length ? "gui-only" : "partial";
      rows.push({
        command: msg.name,
        group,
        requestType: msg.typeName,
        responseType: regs[0]?.responseType ?? null,
        handlers: regs.map((r) => r.handler),
        headless,
        registrations: regs,
      });
    }
    rows.sort((a, b) => (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
    commands.push(...rows);
  }
  for (const req of byRequest.keys()) {
    if (!seen.has(req)) warnings.push(`registered request ${req} is not defined in any command proto`);
  }

  return { kicadCommit: gitHead(src), kicadVersion: await kicadVersion(src), commands, skipped, warnings };
}

export function summarize(commands: CommandInfo[]): Record<Headless, number> & { total: number } {
  const s = { ok: 0, "gui-only": 0, partial: 0, unregistered: 0, total: commands.length };
  for (const c of commands) s[c.headless]++;
  return s;
}

function notes(c: CommandInfo): string {
  const gated = c.registrations.filter((r) => r.gated).map((r) => r.handler);
  const serving = c.registrations.filter((r) => !r.gated).map((r) => r.handler);
  switch (c.headless) {
    case "unregistered":
      return "no registerHandler call in any handler";
    case "gui-only":
      return `gated by checkForHeadless in ${gated.join(", ")}`;
    case "partial":
      return `headless-gated in ${gated.join(", ")}; ${serving.join(", ")} handler${serving.length > 1 ? "s serve" : " serves"} it`;
    default:
      return "";
  }
}

const HEADLESS_LABEL: Record<Headless, string> = { ok: "yes", "gui-only": "no", partial: "partial", unregistered: "n/a" };

export function renderMarkdown(r: CoverageResult): string {
  const s = summarize(r.commands);
  const out: string[] = [];
  out.push(`# IPC API coverage matrix (KiCad ${r.kicadVersion}, commit ${r.kicadCommit.slice(0, 10)})`);
  out.push("");
  out.push(
    "Generated from `api/proto/**/*.proto` versus `registerHandler<...>` calls in the KiCad sources. " +
      '"Handlers" names the C++ handler class that serves the command: ' +
      HANDLER_FILES.filter((h) => h.handler !== "cli")
        .map((h) => `${h.handler} = ${h.cls}${h.handler === "common" ? " (always loaded)" : ""}`)
        .join(", ") +
      ".",
  );
  out.push("");
  out.push("| Status | Count | Meaning |");
  out.push("|---|---:|---|");
  out.push(`| OK | ${s.ok} | works in \`kicad-cli api-server\` |`);
  out.push(`| GUI-ONLY | ${s["gui-only"]} | handler returns "not available in headless mode" |`);
  out.push(`| PARTIAL | ${s.partial} | headless in some handlers only |`);
  out.push(`| UNREGISTERED | ${s.unregistered} | defined in .proto, no handler anywhere |`);
  out.push(`| **Total** | **${s.total}** | request messages defined in the command protos |`);
  out.push("");
  for (const { group } of COMMAND_FILES) {
    const rows = r.commands.filter((c) => c.group === group);
    out.push("");
    out.push(`## ${group}`);
    out.push("");
    out.push("| Command | Handlers | Headless | Notes |");
    out.push("|---|---|---|---|");
    for (const c of rows) {
      out.push(`| \`${c.command}\` | ${c.handlers.length ? c.handlers.join(", ") : "-"} | ${HEADLESS_LABEL[c.headless]} | ${notes(c)} |`);
    }
  }
  out.push("");
  out.push("## Not expressible at all (no proto message exists)");
  out.push("");
  out.push(
    "See [04-ipc-gaps.md](04-ipc-gaps.md) for the full list: run DRC/ERC and read markers, library browsing, annotation, schematic-to-board sync in one call, ratsnest/unrouted connections, undo/redo, events/notifications, new project/document creation, symbol and drawing-sheet documents, capability discovery, non-IPC transports.",
  );
  out.push("");
  return out.join("\n");
}

export function renderJson(r: CoverageResult): string {
  const rows = r.commands.map(({ command, group, requestType, responseType, handlers, headless }) => ({
    command,
    group,
    requestType,
    responseType,
    handlers,
    headless,
  }));
  return JSON.stringify(rows, null, 2) + "\n";
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const verbose = process.argv.includes("--verbose");
  const src = kicadSrc();
  if (useWorktree()) console.warn("warning: analysing the working tree (KICAD_WORKTREE=1); results may not match the pinned commit");
  const result = await analyze(src);
  const s = summarize(result.commands);
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (verbose) console.error(`payload types skipped: ${result.skipped.join(", ")}`);
  const jsonPath = join(TOOL_DIR, "commands.json");
  const mdPath = join(REPO_DIR, "docs", "api-coverage.md");
  const json = renderJson(result);
  const md = renderMarkdown(result);
  if (check) {
    const bad: string[] = [];
    for (const [p, want] of [
      [jsonPath, json],
      [mdPath, md],
    ] as const) {
      if ((await readFile(p, "utf8").catch(() => "")) !== want) bad.push(p);
    }
    if (bad.length) {
      console.error(`stale: ${bad.join(", ")}; run \`bun run coverage\``);
      process.exit(1);
    }
    console.log("commands.json and docs/api-coverage.md are up to date");
  } else {
    await writeFile(jsonPath, json);
    await writeFile(mdPath, md);
    console.log(`wrote ${jsonPath} and ${mdPath}`);
  }
  console.log(
    `${s.total} commands (KiCad ${result.kicadCommit.slice(0, 10)}): ${s.ok} ok, ${s["gui-only"]} gui-only, ${s.partial} partial, ${s.unregistered} unregistered`,
  );
}
