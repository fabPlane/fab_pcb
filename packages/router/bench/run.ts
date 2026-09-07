#!/usr/bin/env bun
/**
 * Router benchmark (docs/06-routing.md "Comparison"): for each practice board, open the unrouted
 * variant on a fresh `kicad-cli api-server`, run each router with identical rules, then
 * `RefillZones` + `RunBoardJobDrc`, and record completion, vias, track length, DRC counts, wall
 * time and an SVG. Results go to bench/results/<board>-<router>.json (+ .svg) and the table to
 * docs/router-comparison.md.
 *
 *   bun run bench/run.ts                                    # every board, routers js + freerouting
 *   bun run bench/run.ts --boards ecc83,pic_programmer --routers js
 *   bun run bench/run.ts --time 300 --passes 100            # per-run budget (s) and Freerouting -mp
 *   bun run bench/run.ts --report                           # only rebuild docs/router-comparison.md from the JSON
 *   KEEP_BENCH_DIRS=1 ...                                   # keep the temp board copies
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { BoardLayer, DrcErrorType, RuleSeverity } from "@kicad-web/proto";
import { nm, toMm, type Board } from "@kicad-web/client";
import {
  applyRouteResult,
  extractRouteInput,
  FreeroutingRouter,
  JsRouter,
  alreadyApplied,
  serverHasSpecctra,
  type Autorouter,
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

export interface BenchResult {
  board: string;
  router: string;
  /** `freerouting-kicad` / `freerouting-builtin` / `js` — the adapter's own name. */
  routerImpl: string;
  kicadVersion: string;
  date: string;
  connections: { before: number; after: number; routed: number; completion: number };
  vias: number;
  /** Sum of `GetNetLengths.trackLength`, mm. */
  trackLengthMm: number;
  viaLengthMm: number;
  tracksCreated: number;
  viasCreated: number;
  drcBefore: DrcCounts;
  drcAfter: DrcCounts;
  /** Wall time of route + apply, ms. */
  wallMs: number;
  routeMs: number;
  timedOut: boolean;
  svg: string;
  log: string[];
  options: RouteOptions;
  error?: string;
}

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    boards: get("--boards")?.split(",").filter(Boolean),
    routers: (get("--routers") ?? "js,freerouting").split(",").filter(Boolean),
    timeSec: Number(get("--time") ?? 600),
    passes: Number(get("--passes") ?? 100),
    effort: Number(get("--effort") ?? 1),
    out: get("--out") ?? join(REPO, "packages", "router", "bench", "results"),
    doc: get("--doc") ?? join(REPO, "docs", "router-comparison.md"),
    reportOnly: argv.includes("--report"),
    freeroutingMode: (get("--freerouting-mode") ?? "auto") as "auto" | "kicad" | "builtin",
  };
}

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

export async function benchOne(fixture: FixtureBoard, routerName: string, cfg: ReturnType<typeof parseArgs>): Promise<BenchResult> {
  const t = performance.now();
  const run = await openFixture(fixture, { prefix: `bench-${routerName}` });
  const { board, kicad } = run;
  const options: RouteOptions = { maxTimeMs: cfg.timeSec * 1000, effort: routerName.startsWith("freerouting") ? cfg.passes : cfg.effort };
  const result: BenchResult = {
    board: fixture.name,
    router: routerName,
    routerImpl: routerName,
    kicadVersion: await kicad.versionString().catch(() => "?"),
    date: new Date().toISOString(),
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
    options,
  };
  try {
    console.log(`\n▶ ${fixture.name} × ${routerName}  (${basename(run.pcb)}, server up in ${Math.round(performance.now() - t)} ms)`);
    // The unrouted variants ship without zone fills; refill first so "before" counts only what
    // tracks have to connect.
    await board.refillZones();
    const before = await measure(board);
    result.connections.before = before.unrouted;
    result.drcBefore = drcCounts(await board.drc.run());
    console.log(
      `  before: ${before.unrouted} unrouted, ${before.vias} vias, DRC ${result.drcBefore.errors} errors (${result.drcBefore.otherErrors} not unconnected) / ${result.drcBefore.warnings} warnings`,
    );

    // Router names: `js`, `freerouting` (KiCad's DSN export / SES import when the server has the
    // commands, else builtin), `freerouting-builtin` (always our DSN writer + SES reader).
    const router: Autorouter =
      routerName === "freerouting"
        ? new FreeroutingRouter({ board }, { mode: cfg.freeroutingMode, passes: cfg.passes })
        : routerName === "freerouting-builtin"
          ? new FreeroutingRouter({ board }, { mode: "builtin", passes: cfg.passes })
          : new JsRouter();
    const avail = (await router.available?.()) ?? { ok: true };
    if (!avail.ok) throw new Error(avail.reason ?? "router unavailable");
    if (routerName.startsWith("freerouting")) {
      const has = await serverHasSpecctra(board).catch(() => false);
      result.log.push(`server has Specctra API: ${has}`);
    }

    const t0 = performance.now();
    const input = await extractRouteInput(board, { warn: (m) => result.log.push(`extract: ${m}`) });
    result.log.push(
      `extract: ${input.pads.length} pads, ${input.connections.length} connections, ${input.copperLayers.length} copper layers, ${input.zones.length} zones, ${input.obstacles.length} copper graphics`,
    );
    let lastLine = "";
    const onProgress = (p: RouteProgress) => {
      const line = `  ${p.phase}${p.percent !== undefined ? ` ${p.percent}%` : ""}${p.routed !== undefined ? ` ${p.routed}/${p.total}` : ""}${p.message ? ` — ${p.message}` : ""}`;
      if (line !== lastLine) {
        lastLine = line;
        process.stdout.write(`\r${line.padEnd(100)}`);
      }
    };
    const routed = await router.route(input, options, onProgress);
    process.stdout.write("\n");
    result.routeMs = routed.elapsedMs;
    result.routerImpl = routed.router;
    result.timedOut = routed.timedOut;
    result.log.push(...routed.log);
    if (!alreadyApplied(routed) && (routed.tracks.length || routed.vias.length)) {
      const applied = await applyRouteResult(board, routed, { strict: false });
      result.tracksCreated = applied.created.filter((i) => i.constructor.name === "Track").length;
      result.viasCreated = applied.created.filter((i) => i.constructor.name === "Via").length;
    } else if (alreadyApplied(routed)) {
      const applied = (routed as { applied?: { tracksAdded: number; viasAdded: number } }).applied;
      result.tracksCreated = applied?.tracksAdded ?? 0;
      result.viasCreated = applied?.viasAdded ?? 0;
    }
    result.wallMs = Math.round(performance.now() - t0);

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
      `  after: ${result.connections.routed}/${before.unrouted} routed (${(result.connections.completion * 100).toFixed(1)}%), ${after.vias} vias, ${after.trackLengthMm.toFixed(1)} mm track, DRC ${result.drcAfter.errors} errors (${result.drcAfter.otherErrors} not unconnected) / ${result.drcAfter.warnings} warnings, ${result.wallMs} ms`,
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

export function renderReport(results: BenchResult[], boards: FixtureBoard[], routers: string[]): string {
  const lines: string[] = [];
  lines.push("# Router comparison");
  lines.push("");
  lines.push("Generated by `bun run --filter @kicad-web/router bench` (`packages/router/bench/run.ts`). Each row: the board's");
  lines.push("`*.unrouted.kicad_pcb` variant opened on a fresh `kicad-cli api-server`, routed with the board's own net-class");
  lines.push('rules, then `RefillZones` + `RunBoardJobDrc`. "DRC errors" excludes `unconnected_items` (that is the completion');
  lines.push("column) and shows the count on the unrouted board in parentheses, so pre-existing problems are visible.");
  lines.push("Raw JSON and SVG renders: `packages/router/bench/results/`.");
  lines.push("");
  lines.push(
    "| Board | Router | Routed / total | Completion | Vias | Track length | DRC errors (before) | DRC warnings (before) | Wall time | Render |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const b of boards) {
    for (const r of routers) {
      const res = results.find((x) => x.board === b.name && x.router === r);
      if (!res) {
        lines.push(`| ${b.name} | ${r} | — | — | — | — | — | — | — | not run |`);
        continue;
      }
      if (res.error) {
        lines.push(`| ${b.name} | ${res.routerImpl} | — | — | — | — | — | — | — | failed: ${res.error.slice(0, 80)} |`);
        continue;
      }
      const c = res.connections;
      const render = res.svg ? `[svg](../${res.svg})` : "—";
      lines.push(
        `| ${b.name} | ${res.routerImpl} | ${c.routed} / ${c.before} | ${fmt(c.completion * 100)}% | ${res.vias} | ${fmt(res.trackLengthMm)} mm | ${res.drcAfter.otherErrors} (${res.drcBefore.otherErrors}) | ${res.drcAfter.warnings} (${res.drcBefore.warnings}) | ${fmt(res.wallMs / 1000)} s${res.timedOut ? " (timed out)" : ""} | ${render} |`,
      );
    }
  }
  lines.push("");
  const dated = results.filter((r) => !r.error);
  if (dated.length) {
    lines.push(
      `KiCad ${dated[0]!.kicadVersion}; runs from ${dated.map((r) => r.date.slice(0, 10)).sort()[0]} to ${dated
        .map((r) => r.date.slice(0, 10))
        .sort()
        .pop()}.`,
    );
    lines.push("");
  }
  lines.push("## Notes per run");
  lines.push("");
  for (const res of results) {
    lines.push(`### ${res.board} × ${res.routerImpl}`);
    lines.push("");
    if (res.error) lines.push(`Failed: ${res.error}`);
    else {
      lines.push(
        `Options: \`${JSON.stringify(res.options)}\`. Created ${res.tracksCreated} tracks and ${res.viasCreated} vias in ${res.wallMs} ms (router ${res.routeMs} ms).`,
      );
      const types = Object.entries(res.drcAfter.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k.replace(/^DRCET_/, "").toLowerCase()} ${v}`)
        .join(", ");
      lines.push(`DRC after: ${types || "clean"}.`);
    }
    const notes = res.log.filter((l) => /^note:|^extract:|^ses:|^import warning|^mode:|^srj:|tracks,|timed out|failed/.test(l));
    if (notes.length) {
      lines.push("");
      for (const n of notes) lines.push(`- ${n}`);
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
    for (const b of boards) for (const r of cfg.routers) await benchOne(b, r, cfg);
  }
  const results = await loadResults(cfg.out);
  const doc = renderReport(results, all.length ? all : boards, ["js", "freerouting", "freerouting-builtin"]);
  await writeFile(cfg.doc, doc);
  console.log(`\nwrote ${relative(REPO, cfg.doc)} (${results.length} results)`);
}
