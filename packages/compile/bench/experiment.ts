/**
 * The §6 de-risking experiment (fabdesk docs/fab-pcb-migration.md): drive the compile pipeline
 * step by step against a real fork `kicad-cli api-server`, timing each step and dumping KiCad's
 * import report verbatim, then run the same netlist through `applyNetlist` on a second project,
 * and finally ask the *stock* kicad-cli to read the fork-written board.
 *
 *   bun run experiment            # KICAD_CLI (fork), STOCK_KICAD_CLI, KICAD10_FOOTPRINT_DIR override the defaults
 *
 * Findings on 2026-09-07 (fork 280274cc3d, macOS) are recorded in fabdesk's docs/fab-pcb-migration.md §6.1:
 * the pipeline works end to end; a project-local fp-lib-table is sufficient library provisioning;
 * stock kicad-cli 10.0.4 cannot load the fork-written board while the fork's CLI can; the legacy
 * autoplacer ignores copper-to-edge clearance.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KiCad, NngIpcTransport, toMm, type Board } from "@fp-pcb/client";
import { KiCadObjectType } from "@fp-pcb/proto";
import { applyNetlist, ensureOutline, footprintIds, hasOutline } from "../src/apply";
import { emitKicadNetlist, validateNetlist } from "../src/netlist";
import type { Netlist } from "../src/types";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(REPO, "..", "kicad");
const KICAD_CLI = process.env.KICAD_CLI ?? `${KICAD_ROOT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
const STOCK_CLI = process.env.STOCK_KICAD_CLI ?? "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";
const FOOTPRINTS = process.env.KICAD10_FOOTPRINT_DIR ?? "/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints";

const NETLIST: Netlist = {
  components: [
    { ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" },
    { ref: "D1", value: "RED", footprint: "LED_SMD:LED_0603_1608Metric" },
  ],
  nets: [
    {
      name: "N1",
      nodes: [
        { ref: "R1", pin: "2" },
        { ref: "D1", pin: "1" },
      ],
    },
    {
      name: "N2",
      nodes: [
        { ref: "R1", pin: "1" },
        { ref: "D1", pin: "2" },
      ],
    },
  ],
  design: { source: "experiment", tool: "@fp-pcb/compile experiment" },
};

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s]`, ...a);
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const s = performance.now();
  try {
    const v = await fn();
    log(`✔ ${name} (${Math.round(performance.now() - s)} ms)`);
    return v;
  } catch (e) {
    log(`✘ ${name} (${Math.round(performance.now() - s)} ms): ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}
const block = (title: string, text: string) => console.log(`----- ${title} -----\n${text.trim() || "(empty)"}\n-----`);

async function spawnServer(root: string, opts: { footprintEnv?: boolean; tag?: string } = {}) {
  await mkdir("/tmp/kicad", { recursive: true });
  const socketPath = `/tmp/kicad/compile-exp-${process.pid}-${opts.tag ?? "main"}.sock`;
  await rm(socketPath, { force: true });
  const proc = Bun.spawn([KICAD_CLI, "api-server", "--socket", socketPath], {
    cwd: root,
    stdout: "ignore",
    stderr: "pipe",
    env: (() => {
      const { KICAD10_FOOTPRINT_DIR: _drop, ...rest } = process.env;
      return opts.footprintEnv === false ? rest : { ...rest, KICAD10_FOOTPRINT_DIR: FOOTPRINTS };
    })(),
  });
  const err: string[] = [];
  void (async () => {
    const r = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      err.push(new TextDecoder().decode(value));
    }
  })().catch(() => {});
  const deadline = Date.now() + 60_000;
  while (!existsSync(socketPath)) {
    if (proc.exitCode !== null) throw new Error(`kicad-cli exited ${proc.exitCode}:\n${err.join("")}`);
    if (Date.now() > deadline) throw new Error("no socket after 60 s");
    await Bun.sleep(50);
  }
  const transport = await NngIpcTransport.connect({ path: socketPath, defaultTimeoutMs: 120_000 });
  const kicad = await KiCad.connect(transport, { clientName: `fp-pcb/compile-experiment-${process.pid}`, readyTimeoutMs: 120_000 });
  return {
    kicad,
    stderr: () => err.join(""),
    async stop() {
      await transport.close().catch(() => {});
      proc.kill("SIGTERM");
      const k = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await proc.exited;
      clearTimeout(k);
      await rm(socketPath, { force: true });
    },
  };
}

async function projectDir(root: string, name: string, opts: { localTable?: boolean } = {}): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, ".fabdesk"), { recursive: true });
  if (opts.localTable === false) return dir;
  // Project-local footprint table pointing at the installed libraries, so the result does not
  // depend on the fork build knowing where the stock footprints live.
  await writeFile(
    join(dir, "fp-lib-table"),
    `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${FOOTPRINTS}/Resistor_SMD.pretty") (options "") (descr ""))\n  (lib (name "LED_SMD") (type "KiCad") (uri "${FOOTPRINTS}/LED_SMD.pretty") (options "") (descr ""))\n)\n`,
  );
  return dir;
}

/** `newProject` takes the `.kicad_pro` path; an extension-less path is treated as a directory to create (`<path>/<name>.kicad_pro`). */
async function newProjectIn(kicad: KiCad, dir: string, name: string): Promise<{ board: Board; pcbPath: string }> {
  const project = await kicad.newProject(join(dir, `${name}.kicad_pro`));
  const info = await project.info();
  const board = (await kicad.currentBoard()) ?? (await project.openBoard());
  return { board, pcbPath: info.kicadProPath.replace(/\.kicad_pro$/, ".kicad_pcb") };
}

function drcSummary(res: { markers: { severity: number; excluded: boolean; description: string }[] }): string {
  const by = new Map<string, number>();
  for (const m of res.markers)
    by.set(
      `${m.severity === 2 ? "error" : m.severity === 3 ? "warning" : `sev${m.severity}`}: ${m.description}`,
      (by.get(`${m.severity === 2 ? "error" : m.severity === 3 ? "warning" : `sev${m.severity}`}: ${m.description}`) ?? 0) + 1,
    );
  return [...by.entries()].map(([k, n]) => `${n}x ${k}`).join("\n") || "no markers";
}

async function footprintTable(board: Board): Promise<string> {
  const fps = await board.getFootprints();
  return fps
    .map((f) => `${f.reference.padEnd(4)} at (${toMm(f.position.x).toFixed(2)}, ${toMm(f.position.y).toFixed(2)}) mm  id=${f.id}`)
    .join("\n");
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "fp-pcb-compile-exp-"));
  log("workdir", root);
  log("fork cli", KICAD_CLI);

  // ================= Part 0: library provisioning matrix (A.7) =================
  for (const [tag, footprintEnv, localTable] of [
    ["no-env-no-table", false, false],
    ["local-table-only", false, true],
  ] as const) {
    const srv = await step(`[${tag}] spawn api-server`, () => spawnServer(root, { footprintEnv, tag }));
    try {
      const dir = await projectDir(root, tag, { localTable });
      const { board } = await newProjectIn(srv.kicad, dir, tag);
      const netPath = join(dir, ".fabdesk", "compile.net");
      await writeFile(netPath, emitKicadNetlist(NETLIST, { date: "2026-09-07T00:00:00.000Z" }));
      const dry = await step(`[${tag}] ImportNetlist dryRun`, () => board.importNetlist(netPath, { dryRun: true, matchMode: "reference" }));
      log(`[${tag}] dry run: errors=${dry.errorCount} warnings=${dry.warningCount} newFootprints=${dry.newFootprintCount}`);
      block(`[${tag}] dry-run report`, dry.report);
    } finally {
      await srv.stop();
    }
  }

  const server = await step("spawn bare api-server + connect", () => spawnServer(root));
  const { kicad } = server;
  log("server", await kicad.versionString());

  try {
    // ================= Part 1: the steps by hand =================
    const dirA = await projectDir(root, "manual");
    const { board, pcbPath } = await step("newProject + open board", () => newProjectIn(kicad, dirA, "manual"));
    log("board", board.toString(), "at", pcbPath, "revision", String(await board.revision()));

    const diagnostics = validateNetlist(NETLIST);
    log("validateNetlist diagnostics:", diagnostics.length ? JSON.stringify(diagnostics) : "none");
    const netPath = join(dirA, ".fabdesk", "compile.net");
    await writeFile(netPath, emitKicadNetlist(NETLIST, { date: "2026-09-07T00:00:00.000Z" }));
    block("emitted netlist", await readFile(netPath, "utf8"));

    const dry = await step("ImportNetlist dryRun", () =>
      board!.importNetlist(netPath, { dryRun: true, matchMode: "reference", updateFootprints: true, deleteExtraFootprints: true }),
    );
    log(`dry run: errors=${dry.errorCount} warnings=${dry.warningCount} newFootprints=${dry.newFootprintCount}`);
    block("dry-run report (verbatim)", dry.report);
    log("footprints after dry run:", (await footprintIds(board)).length, "(expect 0)");

    const revBefore = await board.revision();
    log("hasOutline before:", await hasOutline(board));
    const outlineDiag = await step("ensureOutline 20x10 mm", () => ensureOutline(board!, { widthMm: 20, heightMm: 10 }));
    log(
      "outline diagnostics:",
      JSON.stringify(outlineDiag),
      "hasOutline now:",
      await hasOutline(board),
      "revision",
      String(await board.revision()),
    );

    const before = new Set(await footprintIds(board));
    const imported = await step("ImportNetlist (real)", () =>
      board!.importNetlist(netPath, { matchMode: "reference", updateFootprints: true, deleteExtraFootprints: true }),
    );
    log(`import: errors=${imported.errorCount} warnings=${imported.warningCount} newFootprints=${imported.newFootprintCount}`);
    block("import report (verbatim)", imported.report);
    const added = (await footprintIds(board)).filter((id) => !before.has(id));
    log("added footprint ids:", added);
    log("revision after import", String(await board.revision()), "(before outline:", String(revBefore) + ")");
    block("footprint positions after import (spread from origin?)", await footprintTable(board));

    const placed = await step("AutoplaceFootprints(added, includeOffboard)", () => board!.autoplace(added, { includeOffboard: true }));
    log("autoplace:", JSON.stringify(placed));
    block("footprint positions after autoplace", await footprintTable(board));

    const rats = await board.ratsnest();
    log("ratsnest edges:", rats.edges.length, "unrouted:", JSON.stringify(await board.unroutedCount()));

    const drc = await step("DRC (refillZones)", () => board!.drc.run({ refillZones: true }));
    block("DRC markers", drcSummary(drc));

    await step("SaveDocument", () => board!.save());
    const head = (await readFile(pcbPath, "utf8")).split("\n").slice(0, 3).join("\n");
    block(`saved ${pcbPath} (header)`, head);

    // ================= Part 2: the package path =================
    const dirB = await projectDir(root, "pkg");
    const { board: boardB, pcbPath: pcbPathB } = await step("newProject #2 + open board", () => newProjectIn(kicad, dirB, "pkg"));
    log("second board", boardB.toString(), "at", pcbPathB, "(first board still", board.toString() + ")");
    const outcome = await step("applyNetlist (package)", () =>
      applyNetlist(boardB!, NETLIST, {
        netlistPath: join(dirB, ".fabdesk", "compile.net"),
        board: { widthMm: 20, heightMm: 10 },
        autoplace: true,
        date: "2026-09-07T00:00:00.000Z",
      }),
    );
    log("applyNetlist outcome:", JSON.stringify({ ...outcome, report: undefined }));
    block("applyNetlist report", outcome.report);
    block("package-path footprint positions", await footprintTable(boardB));
    await step("SaveDocument #2", () => boardB!.save());

    // ================= Part 3: stock kicad-cli reads the fork board? =================
    for (const [label, pcb] of [
      ["manual", pcbPath],
      ["pkg", pcbPathB],
    ] as const) {
      const out = join(root, `${label}-stock-drc.json`);
      const r = Bun.spawnSync([STOCK_CLI, "pcb", "drc", "--format", "json", "--severity-all", "-o", out, pcb], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(r.stderr);
      const stdout = new TextDecoder().decode(r.stdout);
      log(`stock kicad-cli pcb drc on ${label}: exit=${r.exitCode} json=${existsSync(out)}`);
      block(`stock drc stdout/stderr (${label})`, (stdout + "\n" + stderr).slice(0, 1200));
      if (existsSync(out)) {
        const j = JSON.parse(await readFile(out, "utf8")) as { violations?: unknown[]; unconnected_items?: unknown[] };
        log(`  stock DRC: violations=${j.violations?.length ?? "?"} unconnected=${j.unconnected_items?.length ?? "?"}`);
      }
      const svg = Bun.spawnSync([STOCK_CLI, "pcb", "export", "svg", "-o", join(root, `${label}.svg`), "--layers", "F.Cu,Edge.Cuts", pcb], {
        stdout: "pipe",
        stderr: "pipe",
      });
      log(`stock kicad-cli pcb export svg on ${label}: exit=${svg.exitCode}`);
    }
    log("DONE. workdir kept:", root);
  } finally {
    const err = server.stderr();
    if (err.trim()) block("kicad-cli stderr", err.slice(-2000));
    await server.stop();
  }
}

main().catch((e) => {
  console.error("EXPERIMENT FAILED:", e);
  process.exit(1);
});
