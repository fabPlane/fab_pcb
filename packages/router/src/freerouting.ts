/**
 * `FreeroutingRouter`: Freerouting (Java, GPL-3.0) driven headless through its CLI:
 *
 *   java -jar freerouting.jar -de in.dsn -do out.ses -mp <passes> --gui.enabled=false
 *
 * Two ways in and out of the board, chosen per call by `mode`:
 *
 * - `"kicad"` — the DSN comes from KiCad's own exporter (`RunBoardJobExportSpecctra`, inline) and
 *   the session goes back through `ImportSpecctraSession`, so KiCad's exact pad geometry, zones and
 *   its own importer are used. Needs both API commands (KiCad >= 11.0 fork); `available()` checks
 *   `GetSupportedCommands`. The commands are called by name through the generated `commands`
 *   module when present, so this file compiles against a client that predates them.
 * - `"builtin"` — the DSN is written from `RouteInput` by `specctra/dsn.ts` and the session parsed
 *   by `specctra/ses.ts` into tracks and vias for `applyRouteResult()`. Works on any server; pads
 *   are approximated (see dsn.ts).
 *
 * Default: `"auto"` — `"kicad"` when the server supports it, else `"builtin"`.
 *
 * `RouteResult` for the kicad mode carries no tracks (KiCad already created them) and reports the
 * importer's counts in `log`; the bench measures completion with `GetRatsnest` in both modes.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board } from "@kicad-web/client";
import { commands as generatedCommands, KiCadApiError } from "@kicad-web/client";
import { writeDsn, dsnLayers } from "./specctra/dsn";
import { parseSes, sesToItems } from "./specctra/ses";
import type { Autorouter, RouteConnection, RouteInput, RouteOptions, RouteProgress, RouteResult } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = resolve(HERE, "..", "vendor");
export const FREEROUTING_VERSION = "2.4.1";
/** Where `bench/fetch-freerouting.ts` puts the jar; override with `FREEROUTING_JAR`. */
export const DEFAULT_JAR = join(VENDOR_DIR, `freerouting-${FREEROUTING_VERSION}.jar`);
/** Freerouting 2.2+ needs Java 25; a local Temurin lives in vendor/jdk (`fetch-freerouting.ts --jdk`). Override with `FREEROUTING_JAVA`. */
export const DEFAULT_JAVA_CANDIDATES = [
  process.env.FREEROUTING_JAVA,
  join(VENDOR_DIR, "jdk", "Contents", "Home", "bin", "java"),
  join(VENDOR_DIR, "jdk", "bin", "java"),
  "/usr/bin/java",
  "java",
].filter((x): x is string => !!x);

export type FreeroutingMode = "auto" | "kicad" | "builtin";

export interface FreeroutingOptions {
  jar?: string;
  java?: string;
  /** Extra JVM flags (`-Xmx4g`, ...). */
  jvmArgs?: string[];
  /** Extra Freerouting CLI flags. */
  extraArgs?: string[];
  mode?: FreeroutingMode;
  /** Keep the working directory with the DSN/SES/log instead of deleting it. */
  keepFiles?: boolean;
  /** Working directory for the DSN/SES files (default: a fresh temp dir). */
  workDir?: string;
  /** Default `-mp` when `RouteOptions.effort` is not given. Freerouting's own default is 100. */
  passes?: number;
}

/** Names of the two API commands this adapter needs in `kicad` mode. */
export const SPECCTRA_COMMANDS = { export: "RunBoardJobExportSpecctra", import: "ImportSpecctraSession" } as const;

/** The board handle the kicad mode works on; the builtin mode needs none. */
export interface FreeroutingContext {
  board?: Board;
}

/** A parsed Freerouting log line of interest. */
export interface FreeroutingEvent {
  kind: "pass" | "optimizer" | "stage" | "finished" | "saved" | "error" | "other";
  pass?: number;
  unrouted?: number;
  violations?: number;
  score?: number;
  state?: string;
  line: string;
}

const PASS_RE = /(Auto-routing|Optimizer) pass #(\d+) .*?score (?:of )?([\d.]+) \((\d+) unrouted and (\d+) violations\)/;
const STAGE_RE = /(Auto-routing|Optimization) stage (started|completed).*?(\d+) unrouted/;
const FINISHED_RE = /finished with state: ([A-Z_]+)/;
const SAVED_RE = /Successfully saved output file/;
const ERROR_RE = /\b(ERROR|Exception|error:)\b/;

/** Classifies one stdout line. Exported for the unit tests. */
export function parseFreeroutingLine(line: string): FreeroutingEvent {
  let m = PASS_RE.exec(line);
  if (m) {
    return {
      kind: m[1] === "Optimizer" ? "optimizer" : "pass",
      pass: Number(m[2]),
      score: Number(m[3]),
      unrouted: Number(m[4]),
      violations: Number(m[5]),
      line,
    };
  }
  m = STAGE_RE.exec(line);
  if (m) return { kind: "stage", unrouted: Number(m[3]), line };
  m = FINISHED_RE.exec(line);
  if (m) return { kind: "finished", state: m[1], line };
  if (SAVED_RE.test(line)) return { kind: "saved", line };
  if (ERROR_RE.test(line)) return { kind: "error", line };
  return { kind: "other", line };
}

/** Finds a Java that can run the jar (`java -version` is not checked; the first existing path wins). */
export function findJava(candidates: readonly string[] = DEFAULT_JAVA_CANDIDATES): string | undefined {
  for (const c of candidates) {
    if (c === "java") {
      const w = Bun.which("java");
      if (w) return w;
    } else if (existsSync(c)) return c;
  }
  return undefined;
}

/** Whether the connected server implements both Specctra commands. */
export async function serverHasSpecctra(board: Board): Promise<boolean> {
  const client = board.client;
  return (await client.supports(SPECCTRA_COMMANDS.export)) && (await client.supports(SPECCTRA_COMMANDS.import));
}

type AnyCommands = Record<string, ((client: unknown, req: unknown) => Promise<unknown>) | undefined>;

/**
 * Exports the DSN through `RunBoardJobExportSpecctra` (inline output). Throws when the client
 * bindings predate the command (regenerate with `bun run gen` in packages/client).
 */
export async function exportDsnViaKicad(board: Board, outputPath: string): Promise<string> {
  const fn = (generatedCommands as unknown as AnyCommands)["runBoardJobExportSpecctra"];
  if (!fn)
    throw new Error(
      `client bindings have no runBoardJobExportSpecctra; run 'bun run gen' in packages/client against a KiCad with ${SPECCTRA_COMMANDS.export}`,
    );
  // The headless server reads the board file from disk for export jobs: save first.
  await board.save();
  const res = (await fn(board.client, {
    jobSettings: { document: board.specifier, outputPath, async: false, returnInline: true },
  })) as { status: number; outputs?: { path: string; data: Uint8Array }[]; outputPaths?: string[]; message?: string };
  const inline = res.outputs?.[0]?.data;
  if (inline && inline.length) return new TextDecoder().decode(inline);
  const path = res.outputPaths?.[0] ?? outputPath;
  return readFile(path, "utf8");
}

export interface SesImportSummary {
  tracksAdded: number;
  viasAdded: number;
  tracksRemoved: number;
  footprintsMoved: number;
  warnings: string[];
}

/** Imports a session through `ImportSpecctraSession` (contents inline). */
export async function importSesViaKicad(board: Board, ses: string, replaceExistingTracks = false): Promise<SesImportSummary> {
  const fn = (generatedCommands as unknown as AnyCommands)["importSpecctraSession"];
  if (!fn)
    throw new Error(
      `client bindings have no importSpecctraSession; run 'bun run gen' in packages/client against a KiCad with ${SPECCTRA_COMMANDS.import}`,
    );
  const res = (await fn(board.client, {
    board: board.specifier,
    path: "",
    contents: new TextEncoder().encode(ses),
    replaceExistingTracks,
  })) as { tracksAdded: number; viasAdded: number; tracksRemoved: number; footprintsMoved: number; warnings: string[] };
  return {
    tracksAdded: res.tracksAdded ?? 0,
    viasAdded: res.viasAdded ?? 0,
    tracksRemoved: res.tracksRemoved ?? 0,
    footprintsMoved: res.footprintsMoved ?? 0,
    warnings: res.warnings ?? [],
  };
}

export interface FreeroutingRunResult {
  ses: string;
  log: string[];
  exitCode: number;
  timedOut: boolean;
  lastEvent?: FreeroutingEvent;
}

/** Runs the jar on a DSN file; resolves with the session text (empty when Freerouting wrote none). */
export async function runFreerouting(
  dsnPath: string,
  sesPath: string,
  opts: { jar: string; java: string; passes: number; jvmArgs?: string[]; extraArgs?: string[]; maxTimeMs?: number; threads?: number },
  progress?: (p: RouteProgress) => void,
): Promise<FreeroutingRunResult> {
  const args = [
    ...(opts.jvmArgs ?? []),
    "-Djava.awt.headless=true",
    "-jar",
    opts.jar,
    "-de",
    dsnPath,
    "-do",
    sesPath,
    "-mp",
    String(opts.passes),
    ...(opts.threads ? ["-mt", String(opts.threads)] : []),
    "--gui.enabled=false",
    ...(opts.extraArgs ?? []),
  ];
  const proc = Bun.spawn([opts.java, ...args], { stdout: "pipe", stderr: "pipe", cwd: dirname(dsnPath) });
  const log: string[] = [];
  let lastEvent: FreeroutingEvent | undefined;
  let timedOut = false;
  const total = { unrouted: 0 };
  const consume = async (stream: ReadableStream<Uint8Array> | null | number | undefined) => {
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        log.push(line);
        const ev = parseFreeroutingLine(line);
        if (ev.kind === "other") continue;
        lastEvent = ev;
        if (ev.kind === "stage" && /stage started/.test(line) && ev.unrouted !== undefined)
          total.unrouted = Math.max(total.unrouted, ev.unrouted);
        if (ev.kind === "pass" || ev.kind === "optimizer") {
          const routed = total.unrouted - (ev.unrouted ?? 0);
          progress?.({
            phase: ev.kind === "pass" ? `pass ${ev.pass}` : `optimizer pass ${ev.pass}`,
            percent: ev.kind === "optimizer" ? 90 : total.unrouted ? Math.min(89, Math.round((routed / total.unrouted) * 89)) : undefined,
            routed,
            total: total.unrouted,
            message: `${ev.unrouted} unrouted, ${ev.violations} violations`,
          });
        } else if (ev.kind === "finished") progress?.({ phase: "finished", percent: 95, message: ev.state });
        else if (ev.kind === "saved") progress?.({ phase: "saved", percent: 98 });
      }
    }
    if (buf.trim()) log.push(buf.trimEnd());
  };
  const timer =
    opts.maxTimeMs && opts.maxTimeMs > 0
      ? setTimeout(() => {
          // Freerouting has no "stop and save" signal on the CLI; SIGTERM ends the run without a
          // session, so a timeout means "nothing routed". The bench passes -mp instead.
          timedOut = true;
          proc.kill("SIGTERM");
        }, opts.maxTimeMs)
      : undefined;
  await Promise.all([consume(proc.stdout), consume(proc.stderr)]);
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  let ses = "";
  if (existsSync(sesPath)) ses = await readFile(sesPath, "utf8");
  return { ses, log, exitCode, timedOut, lastEvent };
}

export class FreeroutingRouter implements Autorouter {
  readonly name: string;
  readonly jar: string;
  readonly java: string | undefined;
  readonly mode: FreeroutingMode;

  constructor(
    private readonly ctx: FreeroutingContext = {},
    private readonly fr: FreeroutingOptions = {},
  ) {
    this.jar = fr.jar ?? process.env.FREEROUTING_JAR ?? DEFAULT_JAR;
    this.java = fr.java ?? findJava();
    this.mode = fr.mode ?? "auto";
    this.name = `freerouting${this.mode === "auto" ? "" : `-${this.mode}`}`;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (!existsSync(this.jar))
      return { ok: false, reason: `Freerouting jar not found at ${this.jar} (bun run bench/fetch-freerouting.ts, or set FREEROUTING_JAR)` };
    if (!this.java) return { ok: false, reason: "no java found (set FREEROUTING_JAVA or run bench/fetch-freerouting.ts --jdk)" };
    const mode = await this.resolveMode();
    if (mode === "kicad" && !this.ctx.board) return { ok: false, reason: "kicad mode needs a Board in the context" };
    if (this.mode === "kicad" && this.ctx.board && !(await serverHasSpecctra(this.ctx.board)))
      return { ok: false, reason: `server lacks ${SPECCTRA_COMMANDS.export}/${SPECCTRA_COMMANDS.import}` };
    return { ok: true };
  }

  /** `auto` -> `kicad` when the server advertises both commands and the bindings have them, else `builtin`. */
  async resolveMode(): Promise<"kicad" | "builtin"> {
    if (this.mode !== "auto") return this.mode;
    const board = this.ctx.board;
    if (!board) return "builtin";
    const cmds = generatedCommands as unknown as AnyCommands;
    if (!cmds["runBoardJobExportSpecctra"] || !cmds["importSpecctraSession"]) return "builtin";
    try {
      return (await serverHasSpecctra(board)) ? "kicad" : "builtin";
    } catch {
      return "builtin";
    }
  }

  async route(input: RouteInput, opts: RouteOptions = {}, progress?: (p: RouteProgress) => void): Promise<RouteResult> {
    const t0 = performance.now();
    const log: string[] = [];
    const avail = await this.available();
    if (!avail.ok) throw new Error(`Freerouting unavailable: ${avail.reason}`);
    const mode = await this.resolveMode();
    const name = `freerouting-${mode}`;
    log.push(`mode: ${mode}; jar: ${this.jar}; java: ${this.java}`);
    const workDir = this.fr.workDir ?? (await mkdtemp(join(tmpdir(), "kicad-web-freerouting-")));
    const dsnPath = join(workDir, "board.dsn");
    const sesPath = join(workDir, "board.ses");
    const layers = dsnLayers(input, opts);
    if (opts.layers && layers.length !== input.copperLayers.length && mode === "kicad")
      log.push("note: kicad mode exports every enabled copper layer; the `layers` option is ignored");
    if (opts.viaCost !== undefined) log.push("note: Freerouting's via costs are set in its GUI/profile, not on the CLI; `viaCost` ignored");
    if (opts.seed !== undefined) log.push("note: Freerouting is not seedable from the CLI; `seed` ignored");
    if (opts.nets?.length)
      log.push("note: Freerouting routes every unrouted net in the DSN; `nets` only filters which connections count as ours");

    progress?.({ phase: "export", percent: 0 });
    let dsn: string;
    if (mode === "kicad") {
      dsn = await exportDsnViaKicad(this.ctx.board!, dsnPath);
    } else {
      dsn = writeDsn(input, { layers });
    }
    await writeFile(dsnPath, dsn);
    log.push(`dsn: ${dsn.length} bytes, ${layers.length} layers`);

    const passes = opts.effort ?? this.fr.passes ?? 100;
    progress?.({ phase: "freerouting", percent: 1 });
    const run = await runFreerouting(
      dsnPath,
      sesPath,
      { jar: this.jar, java: this.java!, passes, jvmArgs: this.fr.jvmArgs, extraArgs: this.fr.extraArgs, maxTimeMs: opts.maxTimeMs },
      progress,
    );
    log.push(
      ...run.log
        .filter((l) => parseFreeroutingLine(l).kind !== "other" || /WARN|ERROR/.test(l))
        .map((l) => `freerouting: ${l.replace(/^\S+ \S+\s+/, "")}`),
    );
    if (run.timedOut) log.push(`timed out after ${opts.maxTimeMs} ms; Freerouting writes no session when killed`);
    if (run.exitCode !== 0) log.push(`freerouting exited with ${run.exitCode}`);

    let result: RouteResult;
    if (!run.ses) {
      result = {
        router: name,
        tracks: [],
        vias: [],
        unrouted: [...input.connections],
        totalConnections: input.connections.length,
        timedOut: run.timedOut,
        elapsedMs: 0,
        log,
      };
    } else if (mode === "kicad") {
      progress?.({ phase: "import", percent: 99 });
      let summary: SesImportSummary;
      try {
        summary = await importSesViaKicad(this.ctx.board!, run.ses, false);
      } catch (e) {
        if (KiCadApiError.is(e)) log.push(`ImportSpecctraSession failed: ${e.codeName} ${e.serverMessage}`);
        throw e;
      }
      log.push(
        `imported: ${summary.tracksAdded} tracks, ${summary.viasAdded} vias, ${summary.footprintsMoved} footprints moved` +
          (summary.warnings.length ? `; ${summary.warnings.length} warnings` : ""),
      );
      log.push(...summary.warnings.map((w) => `import warning: ${w}`));
      const session = parseSes(run.ses);
      const routedNets = new Set(session.nets);
      const unrouted: RouteConnection[] = input.connections.filter((c) => !routedNets.has(c.net));
      // Items were created by KiCad already: report none to create, keep the counts in `log`.
      result = {
        router: name,
        tracks: [],
        vias: [],
        unrouted,
        totalConnections: input.connections.length,
        timedOut: run.timedOut,
        elapsedMs: 0,
        log,
      };
      (result as RouteResult & { applied?: SesImportSummary }).applied = summary;
    } else {
      const session = parseSes(run.ses);
      const items = sesToItems(session, input);
      log.push(...items.warnings.map((w) => `ses: ${w}`));
      const unrouted: RouteConnection[] = input.connections.filter((c) => !items.routedNets.has(c.net));
      result = {
        router: name,
        tracks: items.tracks,
        vias: items.vias,
        unrouted,
        totalConnections: input.connections.length,
        timedOut: run.timedOut,
        elapsedMs: 0,
        log,
      };
    }
    result.elapsedMs = Math.round(performance.now() - t0);
    log.push(
      `${result.tracks.length} tracks, ${result.vias.length} vias to create; ${input.connections.length - result.unrouted.length}/${input.connections.length} connections in ${result.elapsedMs} ms`,
    );
    if (this.fr.keepFiles || this.fr.workDir) log.push(`files kept in ${workDir}`);
    else await rm(workDir, { recursive: true, force: true }).catch(() => {});
    progress?.({ phase: "done", percent: 100, routed: input.connections.length - result.unrouted.length, total: input.connections.length });
    return result;
  }
}

/** True when the result came from the kicad mode, i.e. KiCad already holds the items (nothing to apply). */
export function alreadyApplied(result: RouteResult): boolean {
  return result.router === "freerouting-kicad";
}
