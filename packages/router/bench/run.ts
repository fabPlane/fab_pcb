#!/usr/bin/env bun
/**
 * Router benchmark (docs/06-routing.md "Comparison"): for each practice board, open the unrouted
 * variant on a fresh `kicad-cli api-server` and run the **bridge job** on it — the same code path
 * the app's Autoroute dialog uses (`createRouteJobs` from src/bridge-job.ts: RefillZones ->
 * SaveDocument -> extractRouteInput -> route -> applyRouteResult as one commit, the routed count
 * re-measured with GetRatsnest), followed over its SSE stream like the browser does. Around the
 * job the bench measures what the job does not: `RefillZones` + `RunBoardJobDrc` before and after,
 * via count, `GetNetLengths`, wall time and an SVG render. Results go to
 * bench/results/<board>-<router>.json (+ .svg) and the table to docs/router-comparison.md.
 *
 * Router names (the second word of a result file):
 *   js                    TensorFleet js_autorouter through the bridge, effort `--effort` (default 1)
 *   freerouting           Freerouting in the app's `kicad-dsn` mode (KiCad's DSN exporter, our SES reader,
 *                         our commit), `--passes` (default 20, the app's default)
 *   freerouting-kicad     Freerouting through KiCad's own importer (`kicad` mode) — what the first
 *                         bench (2026-09-06) measured; `--routers freerouting-kicad --passes 100` reproduces it
 *   freerouting-builtin   Freerouting with the package's own DSN writer (`builtin` mode)
 *
 *   bun run bench/run.ts                                    # every board, routers js + freerouting
 *   bun run bench/run.ts --boards ecc83,pic_programmer --routers js
 *   bun run bench/run.ts --passes 100 --effort 2            # Freerouting -mp / JS router effort
 *   bun run bench/run.ts --time 300 --freerouting-time 600  # JS router budget (s, default 600) and a Freerouting
 *                                                           # limit (default 0 = none: a limit kills it with nothing routed)
 *   bun run bench/run.ts --report                           # only rebuild docs/router-comparison.md from the JSON
 *   KEEP_BENCH_DIRS=1 ...                                   # keep the temp board copies
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { basename, join, relative } from "node:path";
import { BoardLayer, DrcErrorType, RuleSeverity } from "@fp-pcb/proto";
import { nm, toMm, type Board } from "@fp-pcb/client";
import {
  FREEROUTING_VERSION,
  createRouteJobs,
  resolveFreerouting,
  type FreeroutingMode,
  type RouteJobInfo,
  type RouteJobRequest,
  type RouteOptions,
  type RouteProgress,
} from "../src/index";
import { FIXTURE_BOARDS, REPO, fixtureBoards, haveKicad, openFixture, type FixtureBoard } from "./kicad";

export interface DrcCounts {
  errors: number;
  warnings: number;
  /** `DRCET_UNCONNECTED_ITEMS` markers (the ratsnest as DRC sees it). */
  unconnected: number;
  /** Errors other than unconnected items. */
  otherErrors: number;
  byType: Record<string, number>;
}

/** What the run was measured with; printed as the report's "Measured with" line. */
export interface MeasuredWith {
  /** `GetVersion` of the server, e.g. `10.99.0-3711-g8cc9377988` (the commit is the `g` suffix). */
  kicad: string;
  freerouting: string;
  /** Present on historical M7 results produced before the js_autorouter migration. */
  capacityAutorouter?: string;
  /** Runtime module used by the current bridge adapter. */
  jsAutorouter?: string;
  /** First line of `java -version`, or "n/a" for JS-only runs. */
  java: string;
  bun: string;
  os: string;
  cpu: string;
  memoryGb: number;
}

/** The bridge job's own account of the run (`RouteJobInfo`), the part the app shows. */
export interface BenchJob {
  state: RouteJobInfo["state"];
  error?: string;
  /** Connections routed as `GetRatsnest` sees it right after the apply (before the bench's refill). */
  routed: number;
  /** The router's own count (a net counts once it got a wire; overstates on multi-pad nets). */
  routerRouted: number;
  total: number;
  /** Commit message — the History entry; empty when nothing was applied. */
  message: string;
}

export interface BenchResult {
  board: string;
  router: string;
  /** The adapter's own name: `js`, `freerouting-kicad-dsn`, `freerouting-kicad`, `freerouting-builtin`. */
  routerImpl: string;
  /** `"job"`: measured through the bridge job. Missing on results of the first, direct-adapter harness. */
  harness?: "job";
  kicadVersion: string;
  date: string;
  measuredWith?: MeasuredWith;
  /**
   * `before`/`after`: `GetUnroutedCount` with zones refilled, before the job and after it (the
   * bench refills once more after the apply, so pads a pour reaches count for both routers alike);
   * `routed` = before - after — the ratsnest-measured column of the report.
   */
  connections: { before: number; after: number; routed: number; completion: number };
  job?: BenchJob;
  vias: number;
  /** Sum of `GetNetLengths.trackLength`, mm. */
  trackLengthMm: number;
  viaLengthMm: number;
  tracksCreated: number;
  viasCreated: number;
  drcBefore: DrcCounts;
  drcAfter: DrcCounts;
  /** Wall time of the whole job (refill, save, extract, route, apply, re-measure), ms. */
  wallMs: number;
  /** The router alone, ms. */
  routeMs: number;
  timedOut: boolean;
  svg: string;
  log: string[];
  options: RouteOptions;
  /** Freerouting mode and `-mp` passes, when it was the router. */
  freerouting?: { mode: FreeroutingMode; passes: number };
  /** Set when the bench itself failed (server, measurement); a job failure is in `job.error`. */
  error?: string;
}

export const ROUTER_ORDER = ["js", "freerouting", "freerouting-kicad", "freerouting-builtin"] as const;

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    boards: get("--boards")?.split(",").filter(Boolean),
    routers: (get("--routers") ?? "js,freerouting").split(",").filter(Boolean),
    /** JS router budget, seconds (it returns what it has). */
    timeSec: Number(get("--time") ?? 600),
    /** Freerouting budget, seconds; 0 = none (the app's default). A limit kills the jar: nothing is routed. */
    freeroutingTimeSec: Number(get("--freerouting-time") ?? 0),
    passes: Number(get("--passes") ?? 20),
    effort: Number(get("--effort") ?? 1),
    out: get("--out") ?? join(REPO, "packages", "router", "bench", "results"),
    doc: get("--doc") ?? join(REPO, "docs", "router-comparison.md"),
    reportOnly: argv.includes("--report"),
  };
}
type Config = ReturnType<typeof parseArgs>;

function drcCounts(res: {
  markers: { errorType: DrcErrorType; severity: RuleSeverity; excluded: boolean }[];
  errorCount: number;
  warningCount: number;
}): DrcCounts {
  const byType: Record<string, number> = {};
  let unconnected = 0;
  let otherErrors = 0;
  for (const m of res.markers) {
    if (m.excluded) continue;
    const name = DrcErrorType[m.errorType] ?? String(m.errorType);
    byType[name] = (byType[name] ?? 0) + 1;
    if (m.severity === RuleSeverity.RS_ERROR) {
      if (m.errorType === DrcErrorType.DRCET_UNCONNECTED_ITEMS) unconnected++;
      else otherErrors++;
    }
  }
  return { errors: res.errorCount, warnings: res.warningCount, unconnected, otherErrors, byType };
}

async function measure(board: Board): Promise<{ vias: number; trackLengthMm: number; viaLengthMm: number; unrouted: number }> {
  const [vias, lengths, rats] = await Promise.all([board.getVias(), board.netLengths(), board.unroutedCount()]);
  let track = 0;
  let via = 0;
  for (const l of lengths) {
    track += nm(l.trackLength);
    via += nm(l.viaLength);
  }
  return { vias: vias.length, trackLengthMm: toMm(track), viaLengthMm: toMm(via), unrouted: rats.unroutedCount };
}

async function copperLayers(board: Board): Promise<BoardLayer[]> {
  const { layers } = await board.enabledLayers();
  return layers.filter((l) => l >= BoardLayer.BL_F_Cu && l <= BoardLayer.BL_B_Cu);
}

/** The job body for a bench router name — the same fields the dialog sends (`buildJobRequest` in the app). */
export function jobRequest(routerName: string, cfg: Pick<Config, "timeSec" | "freeroutingTimeSec" | "passes" | "effort">): RouteJobRequest {
  if (!routerName.startsWith("freerouting")) {
    return {
      router: "js",
      options: { effort: cfg.effort, ...(cfg.timeSec > 0 ? { maxTimeMs: cfg.timeSec * 1000 } : {}) },
      refillZones: true,
    };
  }
  const mode: FreeroutingMode =
    routerName === "freerouting-kicad" ? "kicad" : routerName === "freerouting-builtin" ? "builtin" : "kicad-dsn";
  return {
    router: "freerouting",
    options: { effort: cfg.passes, ...(cfg.freeroutingTimeSec > 0 ? { maxTimeMs: cfg.freeroutingTimeSec * 1000 } : {}) },
    freerouting: { mode, passes: cfg.passes },
    refillZones: true,
  };
}

let measuredWithCache: Omit<MeasuredWith, "kicad" | "java"> | undefined;
function measuredWith(kicad: string, java: string | undefined): MeasuredWith {
  if (!measuredWithCache) {
    const jsAutorouter = process.env.JS_AUTOROUTER_MODULE ?? "@tensorfleet/js-autorouter";
    let os = `${platform()} ${release()}`;
    if (platform() === "darwin") {
      const v = Bun.spawnSync(["sw_vers", "-productVersion"]);
      if (v.success) os = `macOS ${v.stdout.toString().trim()}`;
    }
    measuredWithCache = {
      freerouting: FREEROUTING_VERSION,
      jsAutorouter,
      bun: Bun.version,
      os,
      cpu: cpus()[0]?.model ?? "?",
      memoryGb: Math.round(totalmem() / 2 ** 30),
    };
  }
  let javaVersion = "n/a";
  if (java) {
    const v = Bun.spawnSync([java, "-version"]);
    const line = (v.stderr.toString() + v.stdout.toString()).split("\n").find((l) => /version/.test(l));
    javaVersion = line?.trim() ?? java;
  }
  return { kicad, java: javaVersion, ...measuredWithCache };
}

/** Minimal SSE reader for the job stream: yields `{event, data}` per block. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const val = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

export async function benchOne(fixture: FixtureBoard, routerName: string, cfg: Config): Promise<BenchResult> {
  const t = performance.now();
  const run = await openFixture(fixture, { prefix: `bench-${routerName}` });
  const { board, kicad } = run;
  const request = jobRequest(routerName, cfg);
  const kicadVersion = await kicad.versionString().catch(() => "?");
  const freerouting = resolveFreerouting();
  const result: BenchResult = {
    board: fixture.name,
    router: routerName,
    routerImpl: routerName,
    harness: "job",
    kicadVersion,
    date: new Date().toISOString(),
    measuredWith: measuredWith(kicadVersion, request.router === "freerouting" ? freerouting.java : undefined),
    connections: { before: 0, after: 0, routed: 0, completion: 0 },
    vias: 0,
    trackLengthMm: 0,
    viaLengthMm: 0,
    tracksCreated: 0,
    viasCreated: 0,
    drcBefore: { errors: 0, warnings: 0, unconnected: 0, otherErrors: 0, byType: {} },
    drcAfter: { errors: 0, warnings: 0, unconnected: 0, otherErrors: 0, byType: {} },
    wallMs: 0,
    routeMs: 0,
    timedOut: false,
    svg: "",
    log: [],
    options: request.options ?? {},
    ...(request.freerouting ? { freerouting: { mode: request.freerouting.mode!, passes: request.freerouting.passes! } } : {}),
  };
  try {
    console.log(`\n▶ ${fixture.name} × ${routerName}  (${basename(run.pcb)}, server up in ${Math.round(performance.now() - t)} ms)`);
    // The unrouted variants ship without zone fills; refill first so "before" counts only what
    // tracks have to connect (the job refills again, which is then a no-op).
    await board.refillZones();
    const before = await measure(board);
    result.connections.before = before.unrouted;
    result.drcBefore = drcCounts(await board.drc.run());
    console.log(
      `  before: ${before.unrouted} unrouted, ${before.vias} vias, DRC ${result.drcBefore.errors} errors (${result.drcBefore.otherErrors} not unconnected) / ${result.drcBefore.warnings} warnings`,
    );
    if (request.router === "freerouting" && !freerouting.ok) throw new Error(freerouting.reason ?? "Freerouting unavailable");

    // The job, exactly as the bridge mounts it, on this server's transport; followed over SSE
    // like the browser does so every progress event and log line is seen.
    const jobs = createRouteJobs({ freerouting, log: (m) => result.log.push(`job: ${m}`) });
    const session = { id: `bench-${fixture.name}`, transport: run.transport, clientName: `fp-pcb/bench-${routerName}-${process.pid}` };
    const info = jobs.start(session, request);
    const seen = new Set<string>();
    const remember = (lines: string[] | undefined) => {
      for (const l of lines ?? [])
        if (!seen.has(l)) {
          seen.add(l);
          result.log.push(l);
        }
    };
    let lastLine = "";
    const show = (state: string, p: RouteProgress | undefined) => {
      const line = `  ${state}${p ? ` · ${p.phase}${p.percent !== undefined ? ` ${p.percent}%` : ""}${p.routed !== undefined ? ` ${p.routed}/${p.total}` : ""}${p.message ? ` — ${p.message}` : ""}` : ""}`;
      if (line !== lastLine) {
        lastLine = line;
        process.stdout.write(`\r${line.slice(0, 118).padEnd(118)}`);
      }
    };
    const res = await jobs.handle(
      new Request(`http://bench/sessions/${session.id}/route/${info.id}`, { headers: { accept: "text/event-stream" } }),
      session,
      info.id,
    );
    if (res.body)
      for await (const ev of sseEvents(res.body)) {
        const data = JSON.parse(ev.data) as Partial<RouteJobInfo> & {
          state?: RouteJobInfo["state"];
          progress?: RouteProgress;
          log?: string[];
        };
        remember(data.log);
        show(data.state ?? info.state, data.progress);
        if (ev.event === "done" || ev.event === "error") break;
      }
    const final = await jobs.wait(info.id);
    process.stdout.write("\n");
    remember(final.summary?.log ?? final.log);
    const s = final.summary;
    result.routerImpl = final.router;
    result.job = {
      state: final.state,
      ...(final.error ? { error: final.error } : {}),
      routed: s?.routed ?? 0,
      routerRouted: s?.routerRouted ?? 0,
      total: s?.total ?? before.unrouted,
      message: s?.message ?? "",
    };
    result.wallMs = s?.wallMs ?? Math.max(0, Date.parse(final.finishedAt ?? final.startedAt) - Date.parse(final.startedAt));
    result.routeMs = s?.elapsedMs ?? 0;
    result.timedOut = s?.timedOut ?? /timed out/i.test(final.error ?? "");
    result.tracksCreated = s?.tracks ?? 0;
    result.viasCreated = s?.vias ?? 0;
    if (final.state !== "done") console.log(`  job ${final.state}: ${final.error}`);

    // Zones are refilled before measuring so that pads a copper pour connects (which Freerouting,
    // seeing the zone as a plane, does not route) count for both routers alike.
    await board.refillZones();
    const after = await measure(board);
    result.connections.after = after.unrouted;
    result.connections.routed = before.unrouted - after.unrouted;
    result.connections.completion = before.unrouted ? result.connections.routed / before.unrouted : 1;
    result.vias = after.vias;
    result.trackLengthMm = after.trackLengthMm;
    result.viaLengthMm = after.viaLengthMm;
    result.drcAfter = drcCounts(await board.drc.run());

    await mkdir(cfg.out, { recursive: true });
    const svg = join(cfg.out, `${fixture.name}-${routerName}.svg`);
    await board.save(); // export jobs read the file from disk
    const layers = await copperLayers(board);
    const job = await board.jobs.exportSvg(svg, { plotSettings: { layers: [...layers, BoardLayer.BL_Edge_Cuts] }, fitPageToBoard: true });
    result.svg = job.ok ? relative(REPO, svg) : "";
    if (!job.ok) result.log.push(`svg export: ${job.message}`);
    console.log(
      `  after: ${result.connections.routed}/${before.unrouted} routed (${(result.connections.completion * 100).toFixed(1)}%; the router said ${result.job.routerRouted}, GetRatsnest after the apply ${result.job.routed}), ${after.vias} vias, ${after.trackLengthMm.toFixed(1)} mm track, DRC ${result.drcAfter.errors} errors (${result.drcAfter.otherErrors} not unconnected) / ${result.drcAfter.warnings} warnings, ${result.wallMs} ms`,
    );
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error(`  failed: ${result.error}`);
  } finally {
    await run.stop();
  }
  await mkdir(cfg.out, { recursive: true });
  await writeFile(join(cfg.out, `${fixture.name}-${routerName}.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}

async function loadResults(out: string): Promise<BenchResult[]> {
  if (!existsSync(out)) return [];
  const files = (await readdir(out)).filter((f) => f.endsWith(".json")).sort();
  const results: BenchResult[] = [];
  for (const f of files) results.push(JSON.parse(await readFile(join(out, f), "utf8")) as BenchResult);
  return results;
}

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "—");
const fmtTime = (ms: number) =>
  ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${fmt(ms / 1000)} s`;

/** Short account of how a row was produced: passes/effort and, for pre-job results, the harness. */
function rowNotes(res: BenchResult): string {
  const parts: string[] = [];
  if (res.freerouting) parts.push(`${res.freerouting.mode} mode, ${res.freerouting.passes} passes`);
  else if (res.router.startsWith("freerouting"))
    parts.push(`${res.routerImpl.replace(/^freerouting-?/, "") || "auto"} mode, ${res.options.effort ?? 100} passes`);
  else parts.push(`effort ${res.options.effort ?? 1}`);
  if (res.harness !== "job") parts.push(`**earlier harness** (direct adapter, ${res.date.slice(0, 10)})`);
  if (res.job && res.job.state !== "done") parts.push(`job **${res.job.state}**: ${(res.job.error ?? "").slice(0, 90)}`);
  else if (res.timedOut) parts.push("timed out");
  return parts.join("; ");
}

export function renderReport(results: BenchResult[], boards: FixtureBoard[], routers?: readonly string[]): string {
  const present = new Set(results.map((r) => r.router));
  const cols = (routers ?? ROUTER_ORDER).filter((r) => present.has(r));
  const lines: string[] = [];
  lines.push("# Router comparison");
  lines.push("");
  lines.push("Generated by `bun run --filter @fp-pcb/router bench` (`packages/router/bench/run.ts`). Each row: the board's");
  lines.push("`*.unrouted.kicad_pcb` variant opened on a fresh `kicad-cli api-server`, then the **bridge job** — the code path");
  lines.push("the app's Autoroute dialog runs (`packages/router/src/bridge-job.ts`: `RefillZones` -> `SaveDocument` ->");
  lines.push("`extractRouteInput` -> route -> `applyRouteResult` as one commit) — with the board's own net-class rules, followed");
  lines.push("by `RefillZones` + `RunBoardJobDrc`.");
  lines.push("");
  lines.push('"Routed / total" is measured with KiCad\'s connectivity: `GetUnroutedCount` before the job minus after it, zones');
  lines.push('refilled both times. "Router said" is the router\'s own count of the same connections — a net counts as routed for');
  lines.push("the router as soon as it got a wire, which overstates on multi-pad nets; the app shows both when they differ.");
  lines.push('"DRC errors" excludes `unconnected_items` (that is the completion column) and shows the count on the unrouted board');
  lines.push("in parentheses, so pre-existing problems are visible. Wall time is the whole job (refill, save, extract, route, apply,");
  lines.push("re-measure); the router alone is in the notes. Raw JSON and SVG renders: `packages/router/bench/results/`.");
  lines.push("");
  lines.push(
    "| Board | Router | Routed / total | Router said | Completion | Vias | Track length | DRC errors (before) | DRC warnings (before) | Wall time | Render | Notes |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const b of boards) {
    for (const r of cols) {
      const res = results.find((x) => x.board === b.name && x.router === r);
      if (!res) {
        lines.push(`| ${b.name} | ${r} | — | — | — | — | — | — | — | — | — | not run |`);
        continue;
      }
      if (res.error) {
        lines.push(`| ${b.name} | ${res.routerImpl} | — | — | — | — | — | — | — | — | — | bench failed: ${res.error.slice(0, 80)} |`);
        continue;
      }
      const c = res.connections;
      const render = res.svg ? `[svg](../${res.svg})` : "—";
      const said = res.job ? String(res.job.routerRouted) : "—";
      lines.push(
        `| ${b.name} | ${res.routerImpl} | ${c.routed} / ${c.before} | ${said} | ${fmt(c.completion * 100)}% | ${res.vias} | ${fmt(res.trackLengthMm)} mm | ${res.drcAfter.otherErrors} (${res.drcBefore.otherErrors}) | ${res.drcAfter.warnings} (${res.drcBefore.warnings}) | ${fmtTime(res.wallMs)} | ${render} | ${rowNotes(res)} |`,
      );
    }
  }
  lines.push("");
  const jobRuns = results.filter((r) => !r.error && r.harness === "job" && r.measuredWith);
  const older = results.filter((r) => !r.error && r.harness !== "job");
  if (jobRuns.length) {
    const newest = [...jobRuns].sort((a, b) => a.date.localeCompare(b.date)).pop()!;
    const w = newest.measuredWith!;
    const dates = jobRuns.map((r) => r.date.slice(0, 10)).sort();
    const kicads = [...new Set(jobRuns.map((r) => r.kicadVersion))];
    const javas = [...new Set(jobRuns.map((r) => r.measuredWith?.java).filter((j) => j && j !== "n/a"))];
    lines.push(
      `**Measured with:** KiCad ${kicads.join(" / ")} (\`kicad-cli api-server\` from the fork; the commit is the \`g…\` suffix); ` +
        `Freerouting ${w.freerouting}${javas.length ? ` on ${javas.join(" / ")}` : ""}; ${w.jsAutorouter ? `js_autorouter \`${w.jsAutorouter}\`` : `historical \`@tscircuit/capacity-autorouter\` ${w.capacityAutorouter ?? "?"}`}; ` +
        `Bun ${w.bun}; ${w.cpu}, ${w.memoryGb} GB, ${w.os}. ${dates[0] === dates[dates.length - 1] ? `Runs of ${dates[0]}` : `Runs from ${dates[0]} to ${dates[dates.length - 1]}`}.`,
    );
    lines.push("");
  }
  if (older.length) {
    const dates = older.map((r) => r.date.slice(0, 10)).sort();
    lines.push(
      `Rows marked **earlier harness** are kept from the first bench (${dates[0]}${dates[0] !== dates[dates.length - 1] ? ` to ${dates[dates.length - 1]}` : ""}, ` +
        `KiCad ${[...new Set(older.map((r) => r.kicadVersion))].join(" / ")}), which called the adapters directly — no save, no job, ` +
        `no GetRatsnest re-measure, Freerouting at 100 passes — and were not re-run. That bench's \`freerouting\` rows went through ` +
        `KiCad's own session importer (\`kicad\` mode); \`bun run bench/run.ts --routers freerouting-kicad --passes 100\` reproduces them.`,
    );
    lines.push("");
  }
  lines.push("## Notes per run");
  lines.push("");
  for (const res of results) {
    lines.push(`### ${res.board} × ${res.routerImpl}`);
    lines.push("");
    if (res.error) lines.push(`Bench failed: ${res.error}`);
    else {
      const opts = { ...res.options, ...(res.freerouting ? { freerouting: res.freerouting } : {}) };
      lines.push(
        `Options: \`${JSON.stringify(opts)}\`${res.harness === "job" ? "" : " (earlier harness)"}. Created ${res.tracksCreated} tracks and ${res.viasCreated} vias; ${fmtTime(res.wallMs)} wall, router ${fmtTime(res.routeMs)}.`,
      );
      if (res.job) {
        lines.push(
          res.job.state === "done"
            ? `Job done: History entry "${res.job.message || "(nothing applied)"}"; the router counted ${res.job.routerRouted} / ${res.job.total} routed, ` +
                `GetRatsnest after the apply ${res.job.routed}, after the bench's refill ${res.connections.routed}.`
            : `Job ${res.job.state}: ${res.job.error ?? ""} — the board was left untouched.`,
        );
      }
      const types = Object.entries(res.drcAfter.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k.replace(/^DRCET_/, "").toLowerCase()} ${v}`)
        .join(", ");
      lines.push(`DRC after: ${types || "clean"}.`);
    }
    const notes = res.log.filter((l) =>
      /^note:|^extract:|^ses:|^import warning|^mode:|^srj:|tracks,|timed out|failed|^GetRatsnest|^nets left|^retrying|finished with state/.test(
        l,
      ),
    );
    if (notes.length) {
      lines.push("");
      for (const n of notes) lines.push(`- ${n.replace(/^freerouting: INFO\s+\[[^\]]+\]\s*/, "freerouting: ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const cfg = parseArgs(process.argv.slice(2));
  const all = await fixtureBoards();
  const boards = cfg.boards ? all.filter((b) => cfg.boards!.includes(b.name)) : all;
  if (!cfg.reportOnly) {
    if (!haveKicad()) {
      console.error("kicad-cli not found; set KICAD_CLI");
      process.exit(1);
    }
    if (!boards.length) {
      console.error(`no fixture boards with *.unrouted.kicad_pcb under ${FIXTURE_BOARDS}`);
      process.exit(1);
    }
    for (const r of cfg.routers)
      if (!(ROUTER_ORDER as readonly string[]).includes(r)) {
        console.error(`unknown router "${r}"; one of ${ROUTER_ORDER.join(", ")}`);
        process.exit(1);
      }
    for (const b of boards) for (const r of cfg.routers) await benchOne(b, r, cfg);
  }
  const results = await loadResults(cfg.out);
  const doc = renderReport(results, all.length ? all : boards);
  await writeFile(cfg.doc, doc);
  console.log(`\nwrote ${relative(REPO, cfg.doc)} (${results.length} results)`);
}
