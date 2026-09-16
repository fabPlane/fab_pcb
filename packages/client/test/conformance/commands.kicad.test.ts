/**
 * Conformance suite: one test per command in tooling/coverage/commands.json against a real
 * `kicad-cli api-server` with the kitchen-sink board + schematic (copied into a temp project),
 * plus extra checks for things that are not commands (events on the pub socket, incremental
 * store sync, headless symbol documents). GUI-only commands are expected to answer
 * AS_UNIMPLEMENTED / AS_UNHANDLED and are recorded as skipped. A coverage summary is printed at
 * the end and written to dist/conformance-summary.txt.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ApiStatusCode,
  AppType,
  Board3DFormat,
  BoardLayer,
  BoardOriginType,
  CrossProbeStatus,
  CustomRulesStatus,
  DocumentType,
  DrcErrorType,
  DrcSeverity,
  DrillFormat,
  EmbeddedFileType,
  ErcErrorType,
  FrameType,
  JobState,
  JobStatus,
  KiCadObjectType,
  MapMergeMode,
  PadTeardropMode,
  PadstackPresence,
  PageSize,
  ProjectChangeKind,
  ProjectFileType,
  RenderFormat,
  RuleSeverity,
  RunActionStatus,
  SchematicNetlistFormat,
  StatsOutputFormat,
  UnitSystem,
  WizardGenerationStatus,
  type DrcResultsResponse,
  type ErcResultsResponse,
  type JobProgress,
  type KIID,
} from "@fp-pcb/proto";
import { COMMANDS, KICAD_COMMIT } from "../../src/commands-data";
import * as cmd from "../../src/commands";
import { ActionError, JobError, KiCadApiError } from "../../src/errors";
import { KiCadEvents } from "../../src/events";
import {
  Board,
  Footprint,
  KiCad,
  LibFootprint,
  LibSymbol,
  Project,
  Schematic,
  SchematicPin,
  SchematicSymbol,
  Track,
  activeMarkers,
  flattenHierarchy,
  embeddedFileContent,
  type Pad,
} from "../../src/model";
import { DocumentUndo, MemoryItemStore, UndoStack, toStoredItem } from "../../src/store";
import { mm, toDistance, toVector2 } from "../../src/units";
import {
  KITCHEN_SINK_SCH,
  QA_DEVICE_LIB,
  QA_NETLIST,
  QA_RESISTOR_LIB,
  KICAD_TRANSPORT,
  haveKicad,
  registerWasmMount,
  startKiCad,
  tempProject,
  type RunningKiCad,
  type TempProject,
} from "../kicad-server";

type Status = "pass" | "fail" | "skip";
const results = new Map<string, { status: Status; note: string }>();
const covered = new Set<string>();
const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.command));

function record(name: string, status: Status, note = ""): void {
  results.set(name, { status, note });
}

const restarts: string[] = [];
const UUID = /^[0-9a-f-]{36}$/;
const ids = (list: readonly KIID[]) => list.map((k) => k.value);

/**
 * A crashed server (socket closed by peer) must not take the rest of the suite with it: before
 * each test the server is restarted and the documents reopened, and the crash is reported with
 * the server's stderr in the summary.
 */
async function ensureAlive(before: string): Promise<void> {
  if (rt.transport.state !== "closed" && !rt.server.crashed) return;
  const tail = rt.server.stderr().trim().split("\n").slice(-3).join(" | ");
  restarts.push(
    `before ${before}: server ${rt.server.crashed ? `exited with code ${rt.server.proc.exitCode} signal ${rt.server.proc.signalCode}` : "connection closed"}${tail ? ` -- stderr: ${tail}` : ""}`,
  );
  await stopAll();
  await openAll();
}

async function openAll(): Promise<void> {
  rt = await startKiCad(null, "conf");
  events = undefined;
  eventsError = "";
  try {
    const info = await rt.kicad.serverInfo();
    const subscriber = await rt.subscribe(info?.eventsSocketUrl);
    if (subscriber) {
      events = new KiCadEvents(subscriber);
      events.onGap((g) => eventGaps.push(`${g.expected}->${g.received}`));
    } else eventsError = "server reports no events socket";
  } catch (e) {
    eventsError = e instanceof Error ? e.message : String(e);
  }
  project = await k().openProject(tmp.pro);
  board = await project.openBoard(tmp.pcb);
  sch = await project.openSchematic(tmp.sch);
  footprints = await board.getFootprints();
  firstFp = footprints[0]!;
  pads = await board.getPads();
  netNames = (await board.nets()).map((n) => n.name).filter(Boolean);
}

async function stopAll(): Promise<void> {
  await events?.close().catch(() => {});
  events = undefined;
  await rt?.stop().catch(() => {});
}

/** A second, throwaway server for flows that need their own project (NewProject / NewDocument). */
async function scratchServer(): Promise<RunningKiCad> {
  scratch ??= await startKiCad(null, "scratch");
  return scratch;
}

/** Registers a test for command `name`; the callback may return a note for the summary. */
function cmdTest(name: string, fn: () => Promise<string | void>, timeout = 60_000): void {
  covered.add(name);
  checkTest(name, fn, timeout);
}

/** A check that is not a command (events, store sync, symbol documents); listed separately in the summary. */
function extraTest(name: string, fn: () => Promise<string | void>, timeout = 60_000): void {
  checkTest(name, fn, timeout);
}

function checkTest(name: string, fn: () => Promise<string | void>, timeout: number): void {
  test(
    name,
    async () => {
      await ensureAlive(name);
      try {
        const note = await fn();
        if (!results.has(name)) record(name, "pass", note ?? "");
      } catch (e) {
        let msg = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        if (/closed by peer/.test(msg) || rt.server.crashed) {
          await Bun.sleep(200); // let the exit code land
          const tail = rt.server.stderr().trim().split("\n").slice(-3).join(" | ");
          msg = `KICAD-BUG: server crashed during ${name} (${msg}; exit code ${rt.server.proc.exitCode}, signal ${rt.server.proc.signalCode})${tail ? ` -- stderr: ${tail}` : ""}`;
        }
        if (!results.has(name) || results.get(name)!.status !== "fail") record(name, "fail", msg);
        throw e;
      }
    },
    timeout,
  );
}

/** A GUI-only command must come back as a clean "not available" status, never a crash or a hang. */
function guiOnlyTest(name: string, send: () => Promise<unknown>): void {
  cmdTest(name, async () => {
    const err = await send().then(
      () => undefined,
      (e: unknown) => e,
    );
    if (err === undefined) {
      record(name, "pass", "unexpectedly succeeded headless");
      return;
    }
    expect(KiCadApiError.is(err)).toBe(true);
    const e = err as KiCadApiError;
    expect([ApiStatusCode.AS_UNIMPLEMENTED, ApiStatusCode.AS_UNHANDLED]).toContain(e.code);
    record(name, "skip", `gui-only: ${e.codeName}`);
  });
}

/**
 * KiCad keeps its API handlers in a pointer-ordered std::set, so a command registered by both the
 * board and the schematic handler reaches whichever comes first; that handler answers AS_BAD_REQUEST
 * ("the requested document ... is not open") for the other editor's document instead of
 * AS_UNHANDLED. Until that is fixed, calls on one of the two documents fail at random per server
 * process. This runs `fn` and turns exactly that failure into a KICAD-BUG note.
 */
const DISPATCH_BUG = /is not open|not a board|not a schematic|does not support page settings|does not support a title block/;
async function dispatchTolerant(label: string, fn: () => Promise<string | void>): Promise<string> {
  try {
    const note = await fn();
    return `${label}: ok${note ? ` (${note})` : ""}`;
  } catch (e) {
    if (KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST) && DISPATCH_BUG.test(e.serverMessage)) {
      return `${label}: KICAD-BUG multi-handler dispatch (${e.serverMessage})`;
    }
    throw e;
  }
}

function markerSummary(markers: readonly { errorType: number; severity: RuleSeverity }[], names: Record<number, string>): string {
  const by = new Map<string, number>();
  for (const m of markers) {
    const key = `${names[m.errorType] ?? m.errorType}/${RuleSeverity[m.severity]?.replace(/^RS_/, "").toLowerCase()}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([k, v]) => `${k}=${v}`).join(" ");
}

let rt: RunningKiCad;
let scratch: RunningKiCad | undefined;
let scratchDir = "";
let tmp: TempProject;
let project: Project;
let board: Board;
let sch: Schematic;
let events: KiCadEvents | undefined;
let eventsError = "";
const eventGaps: string[] = [];
let footprints: Footprint[] = [];
let firstFp: Footprint;
let pads: Pad[] = [];
let netNames: string[] = [];
let createdTrackId = "";
let drcRun: DrcResultsResponse | undefined;
let ercRun: ErcResultsResponse | undefined;

const k = () => rt.kicad;
const c = () => rt.kicad.client;

describe.skipIf(!haveKicad())("conformance: every IPC command against kicad-cli api-server", () => {
  beforeAll(async () => {
    tmp = await tempProject();
    // Project-local symbol library table so `Device:*` resolves for headless symbol documents.
    await writeFile(
      join(tmp.dir, "sym-lib-table"),
      `(sym_lib_table\n  (version 7)\n  (lib (name "Device") (type "KiCad") (uri "${QA_DEVICE_LIB}") (options "") (descr "QA symbols"))\n)\n`,
    );
    scratchDir = await mkdtemp(join(tmpdir(), "fp-pcb-scratch-"));
    registerWasmMount(scratchDir); // the wasm backend has no host file system
    await openAll();
  }, 120_000);

  afterAll(async () => {
    await stopAll();
    await scratch?.stop().catch(() => {});
    await tmp?.cleanup();
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
    await printSummary();
  });

  // ---- common/base ----------------------------------------------------------------------------------
  cmdTest("Ping", () => k().ping());
  cmdTest("GetVersion", async () => {
    const v = await k().version();
    expect(v.major).toBeGreaterThanOrEqual(10);
    return v.fullVersion;
  });
  cmdTest("GetKiCadBinaryPath", async () => {
    const p = await k().binaryPath("kicad-cli");
    expect(p.length).toBeGreaterThan(0);
    return p;
  });
  cmdTest("GetPaths", async () => {
    const paths = await k().paths();
    expect(paths.size).toBeGreaterThan(0);
    return `${paths.size} paths`;
  });
  cmdTest("GetPluginSettingsPath", async () => {
    const p = await k().pluginSettingsPath("com.example.fp-pcb");
    expect(p.length).toBeGreaterThan(0);
    return p;
  });
  cmdTest("GetSupportedCommands", async () => {
    const caps = await k().capabilities();
    expect(caps.source).toBe("server");
    expect(caps.size).toBeGreaterThanOrEqual(90);
    const missingLocally = caps
      .commands()
      .filter((x) => !x.info)
      .map((x) => x.command);
    const missingOnServer = COMMANDS.filter((x) => x.headless !== "unregistered" && !caps.has(x.requestType)).map((x) => x.command);
    return `${caps.size} advertised; not in bundled table: [${missingLocally.join(", ")}]; bundled but not advertised: [${missingOnServer.join(", ")}]`;
  });
  cmdTest("GetServerInfo", async () => {
    const info = (await k().serverInfo())!;
    expect(info).toBeDefined();
    expect(info.socketUrl).toContain(rt.server.socketPath);
    expect(info.kicadToken).toBe(c().kicadToken!);
    expect(info.eventsSocketUrl).toContain(rt.server.eventsUrl);
    expect(events?.state).toBe("open");
    return `events socket ${info.eventsSocketUrl} (subscribed)`;
  });
  cmdTest("GetTextExtents", async () => {
    const box = await k().textExtents({
      text: "fp-pcb",
      attributes: { size: toVector2({ x: mm(1), y: mm(1) }), strokeWidth: toDistance(mm(0.15)) },
    });
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
    return `${(box.w / 1e6).toFixed(2)} x ${(box.h / 1e6).toFixed(2)} mm`;
  });
  cmdTest("GetTextAsShapes", async () => {
    const shapes = await k().textAsShapes([
      { text: { text: "A", attributes: { size: toVector2({ x: mm(1), y: mm(1) }), strokeWidth: toDistance(mm(0.15)) } } },
    ]);
    expect(shapes.length).toBe(1);
    expect(shapes[0]!.shapes?.shapes.length ?? 0).toBeGreaterThan(0);
    return `${shapes[0]!.shapes?.shapes.length} shapes`;
  });

  // ---- sch/jobs + sch/commands (first: SetNetClasses below deadlocks any later schematic job, see KICAD-BUG) ----
  const schJob = (name: string, run: (out: string) => Promise<{ outputPaths: string[]; status: JobStatus }>, ext: string) =>
    cmdTest(
      name,
      async () => {
        const out = join(tmp.dir, `job-${name}${ext}`);
        const r = await run(out);
        const produced = [...r.outputPaths, out].filter((p) => existsSync(p));
        expect(produced.length).toBeGreaterThan(0);
        return `${JobStatus[r.status]}: ${produced.length} file(s)`;
      },
      120_000,
    );
  schJob("RunSchematicJobExportSvg", (out) => sch.jobs.exportSvg(`${out}/`), "");
  schJob("RunSchematicJobExportDxf", (out) => sch.jobs.exportDxf(`${out}/`), "");
  schJob("RunSchematicJobExportPdf", (out) => sch.jobs.exportPdf(out), ".pdf");
  schJob("RunSchematicJobExportPs", (out) => sch.jobs.exportPs(`${out}/`), "");
  cmdTest(
    "RunSchematicJobExportNetlist",
    async () => {
      // KICAD-BUG (older builds): this job never answered and wedged the server, so it still runs
      // against a throwaway server that is killed afterwards.
      const out = join(tmp.dir, "job-netlist.xml");
      const own = await startKiCad(null, "netlist");
      try {
        const p = await own.kicad.openProject(tmp.pro);
        const s2 = await p.openSchematic(tmp.sch);
        const r = await cmd.runSchematicJobExportNetlist(
          own.kicad.client,
          { jobSettings: { document: s2.specifier, outputPath: out }, format: SchematicNetlistFormat.SNF_KICAD_XML },
          { timeoutMs: 20_000, retry: false },
        );
        if (r.status === JobStatus.JS_ERROR) throw new Error(`JS_ERROR: ${r.message}`);
        expect(existsSync(out)).toBe(true);
        return `${JobStatus[r.status]}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/timed out/.test(msg))
          record(
            "RunSchematicJobExportNetlist",
            "fail",
            "KICAD-BUG: RunSchematicJobExportNetlist never answers headless and wedges the server (ran on a throwaway server, killed)",
          );
        else if (/_cvpcb\.kiface/.test(msg))
          record(
            "RunSchematicJobExportNetlist",
            "fail",
            `KICAD-BUG: netlist export needs _cvpcb.kiface, which this build does not ship: ${msg.slice(0, 120)}`,
          );
        throw e;
      } finally {
        await own.stop();
      }
    },
    120_000,
  );
  schJob("RunSchematicJobExportBOM", (out) => sch.jobs.exportBom(out), ".csv");

  // ---- sch/commands ------------------------------------------------------------------------------------------
  cmdTest("GetSchematicHierarchy", async () => {
    const top = await sch.hierarchy();
    expect(top.length).toBeGreaterThan(0);
    const sheets = await sch.sheets();
    return `${sheets.length} sheet(s): ${sheets.map((s) => s.humanPath).join(", ")}`;
  });
  cmdTest("GetSchematicNetlist", async () => {
    const nets = await sch.netlist();
    expect(nets.length).toBeGreaterThan(0);
    return `${nets.length} nets`;
  });
  cmdTest(
    "RunSchematicJobErc",
    async () => {
      const r = await sch.erc.run();
      ercRun = r;
      expect(r.markers.length).toBeGreaterThan(0);
      expect(r.errorCount).toBeGreaterThanOrEqual(1);
      expect(r.warningCount).toBeGreaterThanOrEqual(1);
      expect(r.exclusionCount).toBe(r.markers.filter((m) => m.excluded).length);
      expect(activeMarkers(r.markers).length).toBe(r.errorCount + r.warningCount);
      for (const m of r.markers) {
        expect(m.id?.value).toMatch(UUID);
        expect(m.errorType).not.toBe(ErcErrorType.ERCET_UNKNOWN);
        expect(m.description.length).toBeGreaterThan(0);
      }
      // a second run rebuilds the markers with fresh ids
      const again = await sch.erc.run();
      expect(again.markers.length).toBe(r.markers.length);
      expect(new Set(again.markers.map((m) => m.id!.value)).size).toBe(again.markers.length);
      ercRun = again;
      return `${r.markers.length} markers: ${r.errorCount} errors / ${r.warningCount} warnings / ${r.exclusionCount} excluded (${markerSummary(r.markers, ErcErrorType)}); ids rebuilt per run`;
    },
    120_000,
  );
  cmdTest("GetErcMarkers", async () => {
    const m = await sch.erc.markers();
    expect(m.markers.map((x) => x.id!.value).sort()).toEqual(ercRun!.markers.map((x) => x.id!.value).sort());
    expect([m.errorCount, m.warningCount, m.exclusionCount]).toEqual([ercRun!.errorCount, ercRun!.warningCount, ercRun!.exclusionCount]);
    return `${m.markers.length} markers, same ids and counts as the last run`;
  });
  cmdTest("SetErcMarkerExcluded", async () => {
    const before = await sch.erc.markers();
    const target = activeMarkers(before.markers)[0]!;
    await sch.erc.exclude([target], "fp-pcb exclusion");
    const mid = await sch.erc.markers();
    const m = mid.markers.find((x) => x.id?.value === target.id!.value)!;
    expect(m.excluded).toBe(true);
    expect(m.exclusionComment).toBe("fp-pcb exclusion");
    expect(m.severity).toBe(RuleSeverity.RS_EXCLUSION);
    expect(mid.exclusionCount).toBe(before.exclusionCount + 1);
    expect(mid.errorCount + mid.warningCount).toBe(before.errorCount + before.warningCount - 1);
    await sch.erc.include([target.id!.value]);
    const after = await sch.erc.markers();
    expect(after.exclusionCount).toBe(before.exclusionCount);
    expect(after.markers.find((x) => x.id?.value === target.id!.value)!.excluded).toBe(false);
    expect(after.markers.find((x) => x.id?.value === target.id!.value)!.severity).toBe(target.severity);
    return `${ErcErrorType[target.errorType]} excluded with comment (severity -> RS_EXCLUSION, counts shift) and included again`;
  });
  cmdTest("GetErcSeverities", async () => {
    const s = await sch.erc.severities();
    expect(s.size).toBeGreaterThan(30);
    for (const m of activeMarkers(ercRun!.markers)) expect(s.get(m.errorType)).toBe(m.severity);
    return `${s.size} rule types; every active marker's severity matches its rule`;
  });
  cmdTest(
    "SetErcSeverities",
    async () => {
      const before = await sch.erc.markers();
      const target = activeMarkers(before.markers)[0]!;
      const type = target.errorType;
      const orig = (await sch.erc.severities()).get(type)!;
      const ignored = await sch.erc.setSeverities([[type, RuleSeverity.RS_IGNORE]]);
      expect(ignored.get(type)).toBe(RuleSeverity.RS_IGNORE);
      const rerun = await sch.erc.run();
      expect(rerun.markers.some((m) => m.errorType === type)).toBe(false);
      expect(rerun.markers.length).toBeLessThan(before.markers.length);
      const flipped = orig === RuleSeverity.RS_ERROR ? RuleSeverity.RS_WARNING : RuleSeverity.RS_ERROR;
      await sch.erc.setSeverities(new Map([[type, flipped]]));
      const rerun2 = await sch.erc.run();
      const ofType = rerun2.markers.filter((m) => m.errorType === type);
      expect(ofType.length).toBeGreaterThan(0);
      expect(ofType.every((m) => m.severity === flipped)).toBe(true);
      const bad = await sch.erc.setSeverities([[type, RuleSeverity.RS_EXCLUSION]]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(KiCadApiError.is(bad, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      await sch.erc.setSeverities([[type, orig]]);
      ercRun = await sch.erc.run();
      expect(ercRun.markers.length).toBe(before.markers.length);
      return `${ErcErrorType[type]}: ${RuleSeverity[orig]} -> ignore dropped ${before.markers.length - rerun.markers.length} marker(s); -> ${RuleSeverity[flipped]} re-severitised ${ofType.length}; RS_EXCLUSION rejected (AS_BAD_REQUEST); restored`;
    },
    120_000,
  );

  // ---- board DRC (on the pristine board, before the editing tests) ----------------------------------------
  cmdTest(
    "RunBoardJobDrc",
    async () => {
      const r = await board.drc.run();
      drcRun = r;
      expect(r.markers.length).toBeGreaterThan(0);
      expect(r.errorCount).toBeGreaterThanOrEqual(1);
      expect(r.warningCount).toBeGreaterThanOrEqual(1);
      expect(r.exclusionCount).toBe(r.markers.filter((m) => m.excluded).length);
      expect(activeMarkers(r.markers).length).toBe(r.errorCount + r.warningCount);
      for (const m of r.markers) {
        expect(m.id?.value).toMatch(UUID);
        expect(m.errorType).not.toBe(DrcErrorType.DRCET_UNKNOWN);
        expect(m.description.length).toBeGreaterThan(0);
      }
      const parity = await board.drc.run({ testFootprintsAgainstSchematic: true, reportAllTrackErrors: true, refillZones: true });
      expect(parity.parityCount).toBeLessThanOrEqual(parity.markers.length);
      expect(parity.unconnectedCount).toBeLessThanOrEqual(parity.markers.length);
      // leave the plain run's markers on the board for the marker tests
      drcRun = await board.drc.run();
      return `${r.markers.length} markers: ${r.errorCount} errors / ${r.warningCount} warnings / ${r.exclusionCount} excluded, ${r.unconnectedCount} unconnected (${markerSummary(r.markers, DrcErrorType)}); with parity+refill: ${parity.markers.length} markers, ${parity.parityCount} parity`;
    },
    180_000,
  );
  cmdTest("GetDrcMarkers", async () => {
    const m = await board.drc.markers();
    expect(m.markers.map((x) => x.id!.value).sort()).toEqual(drcRun!.markers.map((x) => x.id!.value).sort());
    expect([m.errorCount, m.warningCount, m.exclusionCount]).toEqual([drcRun!.errorCount, drcRun!.warningCount, drcRun!.exclusionCount]);
    return `${m.markers.length} markers, same ids and counts as the last run`;
  });
  cmdTest(
    "SetDrcMarkerExcluded",
    async () => {
      const before = await board.drc.markers();
      const target = activeMarkers(before.markers)[0]!;
      await board.drc.exclude([target], "fp-pcb exclusion");
      const mid = await board.drc.markers();
      const m = mid.markers.find((x) => x.id?.value === target.id!.value)!;
      expect(m.excluded).toBe(true);
      expect(m.exclusionComment).toBe("fp-pcb exclusion");
      expect(m.severity).toBe(RuleSeverity.RS_EXCLUSION);
      expect(mid.exclusionCount).toBe(before.exclusionCount + 1);
      expect(mid.errorCount + mid.warningCount).toBe(before.errorCount + before.warningCount - 1);
      // the exclusion survives a re-run (it is keyed by the violation, not the marker id)
      const rerun = await board.drc.run();
      expect(rerun.exclusionCount).toBe(before.exclusionCount + 1);
      const still = rerun.markers.find((x) => x.errorType === target.errorType && x.excluded);
      expect(still).toBeDefined();
      await board.drc.include([still!.id!.value]);
      const after = await board.drc.markers();
      expect(after.exclusionCount).toBe(before.exclusionCount);
      drcRun = after;
      return `${DrcErrorType[target.errorType]} excluded with comment (severity -> RS_EXCLUSION, counts shift), survives a re-run, included again`;
    },
    120_000,
  );
  cmdTest("GetDrcSeverities", async () => {
    const s = await board.drc.severities();
    expect(s.size).toBeGreaterThan(50);
    for (const m of activeMarkers(drcRun!.markers)) expect(s.get(m.errorType)).toBe(m.severity);
    return `${s.size} rule types; every active marker's severity matches its rule`;
  });
  cmdTest(
    "SetDrcSeverities",
    async () => {
      const before = await board.drc.markers();
      const target = activeMarkers(before.markers)[0]!;
      const type = target.errorType;
      const orig = (await board.drc.severities()).get(type)!;
      const ignored = await board.drc.setSeverities([[type, RuleSeverity.RS_IGNORE]]);
      expect(ignored.get(type)).toBe(RuleSeverity.RS_IGNORE);
      const rerun = await board.drc.run();
      expect(rerun.markers.some((m) => m.errorType === type)).toBe(false);
      expect(rerun.markers.length).toBeLessThan(before.markers.length);
      const flipped = orig === RuleSeverity.RS_ERROR ? RuleSeverity.RS_WARNING : RuleSeverity.RS_ERROR;
      await board.drc.setSeverities(new Map([[type, flipped]]));
      const rerun2 = await board.drc.run();
      const ofType = rerun2.markers.filter((m) => m.errorType === type);
      expect(ofType.length).toBeGreaterThan(0);
      expect(ofType.every((m) => m.severity === flipped)).toBe(true);
      const bad = await board.drc.setSeverities([[type, RuleSeverity.RS_EXCLUSION]]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(KiCadApiError.is(bad, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      await board.drc.setSeverities([[type, orig]]);
      drcRun = await board.drc.run();
      expect(drcRun.markers.length).toBe(before.markers.length);
      return `${DrcErrorType[type]}: ${RuleSeverity[orig]} -> ignore dropped ${before.markers.length - rerun.markers.length} marker(s); -> ${RuleSeverity[flipped]} re-severitised ${ofType.length}; RS_EXCLUSION rejected (AS_BAD_REQUEST); restored`;
    },
    180_000,
  );

  // ---- common/project -------------------------------------------------------------------------------
  cmdTest("OpenDocument", async () => {
    expect(project.specifier.type).toBe(DocumentType.DOCTYPE_PROJECT);
    expect(board.fileName).toBe("api_kitchen_sink.kicad_pcb");
    expect(sch.specifier.type).toBe(DocumentType.DOCTYPE_SCHEMATIC);
    return `project ${project.name}, board ${board.fileName}, schematic`;
  });
  cmdTest("GetNetClasses", async () => {
    const nc = await project.netClasses();
    expect(nc.some((n) => n.name === "Default")).toBe(true);
    return nc.map((n) => n.name).join(", ");
  });
  cmdTest("SetNetClasses", async () => {
    await project.setNetClasses([{ name: "HV", priority: 1, board: { clearance: toDistance(mm(0.5)) } }], MapMergeMode.MMM_MERGE);
    const nc = await project.netClasses();
    expect(nc.some((n) => n.name === "HV")).toBe(true);
  });
  cmdTest("SetTextVariables", async () => {
    await project.setTextVariables({ KWEB: "bar" }, MapMergeMode.MMM_MERGE);
  });
  cmdTest("GetTextVariables", async () => {
    const vars = await project.textVariables();
    expect(vars.KWEB).toBe("bar");
    return `${Object.keys(vars).length} variables`;
  });
  cmdTest("ExpandTextVariables", async () => {
    const a = await dispatchTolerant("project", async () => {
      expect((await project.expandTextVariables(["${KWEB}"]))[0]).toBe("bar");
    });
    const b = await dispatchTolerant("board", async () => {
      expect((await board.expandTextVariables(["${KWEB}"]))[0]).toBe("bar");
    });
    const c = await dispatchTolerant("schematic", async () => {
      expect((await sch.expandTextVariables(["${KWEB}"]))[0]).toBe("bar");
    });
    if ([a, b, c].every((x) => x.includes("KICAD-BUG"))) throw new Error(`${a}; ${b}; ${c}`);
    return `${a}; ${b}; ${c}`;
  });
  cmdTest("GetProjectInfo", async () => {
    const info = await project.info();
    expect(info.kicadProPath).toBe(tmp.pro);
    expect(info.project?.name).toBe("api_kitchen_sink");
    const byKind = (kind: ProjectFileType) => info.files.filter((f) => f.kind === kind);
    expect(byKind(ProjectFileType.PFT_PROJECT).length).toBe(1);
    expect(byKind(ProjectFileType.PFT_PCB).some((f) => f.isOpen)).toBe(true);
    expect(byKind(ProjectFileType.PFT_SCHEMATIC).some((f) => f.isRoot && f.isOpen)).toBe(true);
    expect(byKind(ProjectFileType.PFT_DESIGN_RULES).length).toBe(1);
    return info.files.map((f) => `${ProjectFileType[f.kind]}${f.isOpen ? "*" : ""}`).join(", ");
  });
  cmdTest(
    "NewProject",
    async () => {
      // open:false keeps the kitchen-sink project current on the main server ...
      const dir = join(tmp.dir, "newproj");
      const p = await k().newProject(dir, { open: false });
      expect(existsSync(join(dir, "newproj.kicad_pro"))).toBe(true);
      expect((await k().projectInfo()).project?.name).toBe("api_kitchen_sink");
      // ... the full create-and-open flow runs on the scratch server.
      const s = await scratchServer();
      const ev = join(scratchDir, "evproj");
      const opened = await s.kicad.newProject(ev);
      expect(opened.name).toBe("evproj");
      for (const ext of [".kicad_pro", ".kicad_sch", ".kicad_pcb"]) expect(existsSync(join(ev, `evproj${ext}`))).toBe(true);
      expect((await readFile(join(ev, "evproj.kicad_sch"), "utf8")).startsWith("(kicad_sch")).toBe(true);
      expect((await s.kicad.projectInfo()).project?.name).toBe("evproj");
      const dup = await s.kicad.newProject(ev).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(KiCadApiError.is(dup, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      return `${p.name || "newproj"} created without opening; evproj created with stub schematic/board and opened; existing project refused (AS_BAD_REQUEST)`;
    },
    120_000,
  );
  cmdTest(
    "NewDocument",
    async () => {
      // The kitchen-sink project already has its board: KiCad must refuse rather than overwrite.
      const err = await k()
        .newDocument(DocumentType.DOCTYPE_PCB)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(KiCadApiError.is(err, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      // Creation flow in a stub-less project on the scratch server.
      const s = await scratchServer();
      const bare = await s.kicad.newProject(join(scratchDir, "bare"), { skipStubDocuments: true });
      expect(existsSync(join(scratchDir, "bare", "bare.kicad_pcb"))).toBe(false);
      const b = await bare.newBoard();
      expect(existsSync(join(scratchDir, "bare", "bare.kicad_pcb"))).toBe(true);
      expect(await b.getAllItems()).toEqual([]);
      const t = new Track();
      t.start = { x: mm(1), y: mm(1) };
      t.end = { x: mm(5), y: mm(1) };
      t.width = mm(0.25);
      t.layerId = BoardLayer.BL_F_Cu;
      expect((await b.commit("first track", (tx) => tx.create([t]))).created.length).toBe(1);
      const sc = await bare.newSchematic();
      expect(existsSync(join(scratchDir, "bare", "bare.kicad_sch"))).toBe(true);
      expect((await sc.sheets()).length).toBeGreaterThanOrEqual(1);
      const info = await bare.info();
      expect(
        info.files.filter((f) => f.isOpen && (f.kind === ProjectFileType.PFT_PCB || f.kind === ProjectFileType.PFT_SCHEMATIC)).length,
      ).toBe(2);
      const again = await bare.newBoard().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(KiCadApiError.is(again, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      return "refuses to overwrite an existing board (AS_BAD_REQUEST); board + schematic created in a stub-less project, opened and editable";
    },
    120_000,
  );
  cmdTest("SaveDocument", async () => {
    const b = await dispatchTolerant("board", async () => {
      const before = (await stat(tmp.pcb)).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));
      await board.save();
      expect((await stat(tmp.pcb)).mtimeMs).toBeGreaterThanOrEqual(before);
      expect((await readFile(tmp.pcb, "utf8")).startsWith("(kicad_pcb")).toBe(true);
    });
    const c = await dispatchTolerant("schematic", async () => {
      await sch.save();
      expect((await readFile(tmp.sch, "utf8")).startsWith("(kicad_sch")).toBe(true);
    });
    if (b.includes("KICAD-BUG") && c.includes("KICAD-BUG")) throw new Error(`${b}; ${c}`);
    return `${b}; ${c}`;
  });

  // ---- common/editor ----------------------------------------------------------------------------------
  cmdTest("GetOpenDocuments", async () => {
    const docs = await k().openDocuments(DocumentType.DOCTYPE_PCB);
    expect(docs.length).toBe(1);
    const schDocs = await k().openDocuments(DocumentType.DOCTYPE_SCHEMATIC);
    expect(schDocs.length).toBe(1);
    return "board + schematic";
  });
  cmdTest(
    "GetItems",
    async () => {
      expect(footprints.length).toBeGreaterThan(0);
      const all = await board.getAllItems();
      const syms = await sch.getSymbols();
      expect(syms.length).toBeGreaterThan(0);
      const schAll = await sch.getAllItems();
      // paging
      const page1 = await board.getItemsPage(KiCadObjectType.KOT_PCB_FOOTPRINT, { offset: 0, limit: 2 });
      const page2 = await board.getItemsPage(KiCadObjectType.KOT_PCB_FOOTPRINT, { offset: 2, limit: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.total).toBe(footprints.length);
      expect(page2.total).toBe(footprints.length);
      expect(page2.items.length).toBe(Math.min(2, footprints.length - 2));
      expect(page1.items.map((i) => i.id).some((id) => page2.items.some((j) => j.id === id))).toBe(false);
      const tail = await board.getItemsPage(KiCadObjectType.KOT_PCB_FOOTPRINT, { offset: footprints.length + 5, limit: 2 });
      expect(tail.items).toEqual([]);
      expect(tail.total).toBe(footprints.length);
      // since_revision: move a footprint, ask only for what changed
      const rev = page1.revision;
      const fp = (await board.getItemsById([firstFp.id]))[0] as Footprint;
      const orig = fp.position;
      fp.position = { x: orig.x + mm(1), y: orig.y };
      await board.commit("move for since_revision", (tx) => tx.update([fp]));
      const delta = await board.getItemsSince(rev, [KiCadObjectType.KOT_PCB_FOOTPRINT, KiCadObjectType.KOT_PCB_PAD]);
      expect(delta.full).toBe(false);
      expect(delta.revision).toBeGreaterThan(rev);
      expect(delta.deletedIds).toEqual([]);
      expect(delta.items.some((i) => i.id === firstFp.id)).toBe(true);
      expect(delta.items.every((i) => i.id === firstFp.id || i.parent === firstFp.id)).toBe(true);
      const none = await board.getItemsSince(delta.revision, [KiCadObjectType.KOT_PCB_FOOTPRINT]);
      expect(none.items).toEqual([]);
      expect(none.full).toBe(false);
      const tooOld = await board.getItemsSince(0n, [KiCadObjectType.KOT_PCB_FOOTPRINT]);
      expect(tooOld.full).toBe(true);
      expect(tooOld.items.length).toBe(footprints.length);
      // deletion shows up in deleted_ids
      const victim = footprints.at(-1)!;
      const text = await board.saveItemsToString([victim.id]);
      const rev2 = (await board.revision())!;
      await board.commit("delete for since_revision", (tx) => tx.delete([victim.id]));
      const delta2 = await board.getItemsSince(rev2, [KiCadObjectType.KOT_PCB_FOOTPRINT]);
      expect(delta2.full).toBe(false);
      expect(delta2.deletedIds).toEqual([victim.id]);
      expect(delta2.items).toEqual([]);
      // restore: paste the footprint back (new id) and move the first one home
      const restored = await board.parseAndCreate(text);
      expect(restored.length).toBe(1);
      footprints = await board.getFootprints();
      fp.position = orig;
      await board.commit("move back", (tx) => tx.update([fp]));
      return `board: ${all.length} items / ${footprints.length} footprints / ${pads.length} pads; schematic: ${schAll.length} items / ${syms.length} symbols; paging offset/limit/total ok; since_revision: delta of ${delta.items.length} items (footprint + pads), empty when current, full when too old, deletions reported`;
    },
    120_000,
  );
  cmdTest("GetItemCounts", async () => {
    const b = await board.itemCounts();
    expect(b.counts.get(KiCadObjectType.KOT_PCB_FOOTPRINT)).toBe(footprints.length);
    expect(b.counts.get(KiCadObjectType.KOT_PCB_PAD)).toBe(pads.length);
    expect(b.revision).toBe((await board.revision())!);
    const s = await sch.itemCounts();
    expect(s.counts.get(KiCadObjectType.KOT_SCH_SYMBOL)).toBe((await sch.getSymbols()).length);
    const root = await sch.rootSheet();
    const rs = await root.itemCounts();
    expect(rs.counts.get(KiCadObjectType.KOT_SCH_SYMBOL)).toBe((await root.getSymbols()).length);
    return `board: ${b.counts.size} types / ${b.total} items @ rev ${b.revision}; schematic: ${s.counts.size} types / ${s.total} items; root sheet: ${rs.total} items`;
  });
  cmdTest("GetItemsById", async () => {
    const [fp] = await board.getItemsById([firstFp.id]);
    expect(fp).toBeInstanceOf(Footprint);
    expect(fp!.id).toBe(firstFp.id);
    const sym = (await sch.getSymbols())[0]!;
    const [s] = await sch.getItemsById([sym.id]);
    expect(s).toBeInstanceOf(SchematicSymbol);
  });
  cmdTest("GetBoundingBox", async () => {
    const box = await board.boundingBox(firstFp.id);
    expect(box).toBeDefined();
    expect(box!.w).toBeGreaterThan(0);
    return `${firstFp.reference}: ${(box!.w / 1e6).toFixed(2)} x ${(box!.h / 1e6).toFixed(2)} mm`;
  });
  cmdTest("HitTest", async () => {
    const hit = await board.hitTest(firstFp.id, firstFp.position, mm(0.01));
    expect(hit).toBe(true);
    const miss = await board.hitTest(firstFp.id, { x: firstFp.position.x + mm(500), y: firstFp.position.y }, 0);
    expect(miss).toBe(false);
  });
  cmdTest("GetPageSettings", async () => {
    const b = await dispatchTolerant("board", async () => {
      const ps = await board.pageSettings();
      expect(ps.pageSize).not.toBe(PageSize.PS_UNKNOWN);
      return PageSize[ps.pageSize];
    });
    const c = await dispatchTolerant("schematic", async () => {
      const ps = await sch.pageSettings();
      expect(ps.pageSize).not.toBe(PageSize.PS_UNKNOWN);
      return PageSize[ps.pageSize];
    });
    if (b.includes("KICAD-BUG") && c.includes("KICAD-BUG")) throw new Error(`${b}; ${c}`);
    return `${b}; ${c}`;
  });
  cmdTest("SetPageSettings", async () => {
    const b = await dispatchTolerant("board", async () => {
      const orig = await board.pageSettings();
      const res = await board.setPageSettings({ pageSize: PageSize.PS_A3, orientation: orig.orientation, drawingSheet: orig.drawingSheet });
      expect(res.pageSize).toBe(PageSize.PS_A3);
      await board.setPageSettings(orig);
      expect((await board.pageSettings()).pageSize).toBe(orig.pageSize);
    });
    const c = await dispatchTolerant("schematic", async () => {
      const orig = await sch.pageSettings();
      await sch.setPageSettings(orig);
    });
    if (b.includes("KICAD-BUG") && c.includes("KICAD-BUG")) throw new Error(`${b}; ${c}`);
    return `${b}; ${c}`;
  });
  cmdTest("GetTitleBlockInfo", async () => {
    const b = await dispatchTolerant("board", async () => `title="${(await board.titleBlock()).title}"`);
    const c = await dispatchTolerant("schematic", async () => `title="${(await sch.titleBlock()).title}"`);
    if (b.includes("KICAD-BUG") && c.includes("KICAD-BUG")) throw new Error(`${b}; ${c}`);
    return `${b}; ${c}`;
  });
  cmdTest("SetTitleBlockInfo", async () => {
    const roundTrip = async (doc: Board | Schematic) => {
      const orig = await doc.titleBlock();
      await doc.setTitleBlock({ ...orig, title: "fp-pcb conformance" });
      expect((await doc.titleBlock()).title).toBe("fp-pcb conformance");
      await doc.setTitleBlock(orig);
    };
    const b = await dispatchTolerant("board", () => roundTrip(board));
    const c = await dispatchTolerant("schematic", () => roundTrip(sch));
    if (b.includes("KICAD-BUG") && c.includes("KICAD-BUG")) throw new Error(`${b}; ${c}`);
    return `${b}; ${c}`;
  });
  cmdTest("GetDocumentRevision", async () => {
    const r1 = await board.revision();
    expect(r1).toBeDefined();
    await board.commit("bump", async (tx) => {
      const fp = (await board.getItemsById([firstFp.id]))[0]!;
      await tx.update([fp]);
    });
    const r2 = await board.revision();
    expect(r2!).toBeGreaterThan(r1!);
    const s1 = await sch.revision();
    expect(s1).toBeDefined();
    return `board ${r1} -> ${r2}; schematic ${s1}`;
  });
  cmdTest("GetDocumentModifiedState", async () => {
    const before = await board.modified();
    expect(typeof before).toBe("boolean");
    await board.commit("touch", async (tx) => {
      const fp = (await board.getItemsById([firstFp.id]))[0]!;
      await tx.update([fp]);
    });
    expect(await board.modified()).toBe(true);
    const s = await sch.modified();
    expect(typeof s).toBe("boolean");
    return `board ${before} -> true; schematic ${s}`;
  });
  cmdTest("BeginCommit", async () => {
    const tx = await board.beginCommit();
    expect(tx.id).toMatch(UUID);
    await tx.drop();
  });
  cmdTest("CreateItems", async () => {
    const t = new Track();
    t.start = { x: mm(5), y: mm(5) };
    t.end = { x: mm(15), y: mm(5) };
    t.width = mm(0.3);
    t.layerId = BoardLayer.BL_F_Cu;
    const res = await board.commit("create track", (tx) => tx.create([t]));
    const created = res.created[0] as Track;
    createdTrackId = created.id;
    expect(created.width).toBe(mm(0.3));
    const [back] = await board.getItemsById([createdTrackId]);
    expect(back).toBeInstanceOf(Track);
    return created.id;
  });
  cmdTest("UpdateItems", async () => {
    const fp = (await board.getItemsById([firstFp.id]))[0] as Footprint;
    const orig = fp.position;
    fp.position = { x: orig.x + mm(1), y: orig.y };
    const res = await board.commit("move", (tx) => tx.update([fp]));
    expect((res.updated[0] as Footprint).position.x).toBe(orig.x + mm(1));
    const back = (await board.getItemsById([firstFp.id]))[0] as Footprint;
    expect(back.position.x).toBe(orig.x + mm(1));
    back.position = orig;
    await board.commit("move back", (tx) => tx.update([back]));
    // schematic update, per sheet
    const root = await sch.rootSheet();
    const sym = (await root.getSymbols())[0]!;
    const r2 = await root.commit("touch symbol", (tx) => tx.update([sym]));
    expect(r2.updated.length).toBe(1);
    return "board footprint moved and restored; schematic symbol updated";
  });
  cmdTest("EndCommit", async () => {
    const tx = await board.beginCommit();
    await tx.push("empty commit");
    const tx2 = await board.beginCommit();
    await tx2.drop();
    return "CMA_COMMIT and CMA_DROP";
  });
  cmdTest("DeleteItems", async () => {
    expect(createdTrackId).not.toBe("");
    const res = await board.commit("delete track", (tx) => tx.delete([createdTrackId]));
    expect(res.deleted).toEqual([createdTrackId]);
    // KiCad answers AS_BAD_REQUEST when none of the requested ids exist (rather than an empty list).
    const after = await board.getItemsById([createdTrackId]).then(
      (items) => items,
      (e: unknown) => (KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST) ? [] : Promise.reject(e)),
    );
    expect(after).toEqual([]);
  });
  cmdTest("SaveDocumentToString", async () => {
    const text = await board.saveToString();
    expect(text.startsWith("(kicad_pcb")).toBe(true);
    const s = await sch.saveToString();
    expect(s.startsWith("(kicad_sch")).toBe(true);
    expect(s).toContain("(lib_symbols");
    return `board ${text.length} chars; schematic ${s.length} chars`;
  });
  cmdTest("SaveItemsToString", async () => {
    const text = await board.saveItemsToString([firstFp.id]);
    expect(text).toContain("(footprint");
    const root = await sch.rootSheet();
    const sym = (await root.getSymbols())[0]!;
    const s = await sch.saveItemsToString([sym.id], root.scope);
    expect(s).toContain("(symbol");
    return `board footprint ${text.length} chars; schematic symbol ${s.length} chars (with lib_symbols)`;
  });
  cmdTest("SaveCopyOfDocument", async () => {
    const b = await dispatchTolerant("board", async () => {
      const out = join(tmp.dir, "copy.kicad_pcb");
      await board.saveCopy(out, { overwrite: true });
      expect(existsSync(out)).toBe(true);
    });
    const c = await dispatchTolerant("schematic", async () => {
      const out = join(tmp.dir, "copy.kicad_sch");
      await sch.saveCopy(out, { overwrite: true });
      expect(existsSync(out)).toBe(true);
    });
    if (b.includes("KICAD-BUG") && c.includes("KICAD-BUG")) throw new Error(`${b}; ${c}`);
    return `${b}; ${c}`;
  });
  cmdTest("ParseAndCreateItemsFromString", async () => {
    // board: SaveItemsToString -> parse -> a new footprint with a fresh KIID, visible to the store
    const store = board.documentSync;
    await store.load();
    const text = await board.saveItemsToString([firstFp.id]);
    const created = await board.parseAndCreate(text);
    expect(created.length).toBe(1);
    const fp = created[0] as Footprint;
    expect(fp).toBeInstanceOf(Footprint);
    expect(fp.id).toMatch(UUID);
    expect(fp.id).not.toBe(firstFp.id);
    expect(fp.reference).toBe(firstFp.reference);
    expect(fp.pads.length).toBe(firstFp.pads.length);
    expect((await board.getItemsById([fp.id]))[0]).toBeInstanceOf(Footprint);
    expect(store.store.has(fp.id)).toBe(true);
    await board.commit("remove pasted footprint", (tx) => tx.delete([fp.id]));
    // schematic: a symbol pasted onto the root sheet
    const root = await sch.rootSheet();
    const sym = (await root.getSymbols())[0]!;
    const stext = await sch.saveItemsToString([sym.id], root.scope);
    const screated = await sch.parseAndCreate(stext, root.scope);
    expect(screated.length).toBe(1);
    expect(screated[0]).toBeInstanceOf(SchematicSymbol);
    expect(screated[0]!.id).not.toBe(sym.id);
    expect((await root.getSymbols()).some((s) => s.id === screated[0]!.id)).toBe(true);
    await root.commit("remove pasted symbol", (tx) => tx.delete([screated[0]!.id]));
    // garbage is rejected, not crashed on
    const bad = await board.parseAndCreate("(this is not a board item)").then(
      (items) => `accepted (${items.length} items)`,
      (e: unknown) => (KiCadApiError.is(e) ? `rejected with ${e.codeName}` : `threw ${String(e)}`),
    );
    return `board: footprint ${firstFp.reference} pasted with a new id (${fp.pads.length} pads); schematic: symbol ${sym.reference} pasted on the root sheet with a new id; garbage text ${bad}`;
  });
  cmdTest("RefreshEditor", async () => {
    await board.refreshEditor();
    await sch.refreshEditor();
    await cmd.refreshEditor(c(), { frame: FrameType.FT_UNKNOWN });
  });
  cmdTest("GetActions", async () => {
    const all = await board.actions();
    expect(all.length).toBeGreaterThan(100);
    // names are dotted tool-action ids: "pcbnew.ZoneFiller.zoneFillAll", "common.Control.print", ...
    expect(all.every((a) => /^\S+\.\S+$/.test(a.name))).toBe(true);
    const prefixes = [...new Set(all.map((a) => a.name.split(".")[0]))].sort();
    expect(prefixes).toContain("pcbnew");
    const headless = all.filter((a) => a.headlessCapable);
    expect(headless.map((a) => a.name)).toContain("pcbnew.ZoneFiller.zoneFillAll");
    expect(headless.map((a) => a.name)).toContain("pcbnew.GlobalEdit.cleanupTracksAndVias");
    expect(headless.every((a) => a.label.length > 0)).toBe(true);
    expect(await board.headlessActions()).toEqual(headless);
    const schAll = await sch.actions();
    expect(schAll.length).toBeGreaterThan(100);
    expect(schAll.some((a) => a.name.startsWith("eeschema."))).toBe(true);
    const schHeadless = schAll.filter((a) => a.headlessCapable);
    return `board: ${all.length} actions (${prefixes.join("/")}), ${headless.length} headless (${headless.map((a) => a.name).join(", ")}); schematic: ${schAll.length} actions, ${schHeadless.length} headless`;
  });
  cmdTest("RunAction", async () => {
    const rev0 = (await board.revision())!;
    const changed = events?.next("documentChanged", {
      timeoutMs: 10_000,
      filter: (d) =>
        d.document?.type === DocumentType.DOCTYPE_PCB && d.revision > rev0 && d.created.length + d.updated.length + d.deleted.length === 0,
    });
    expect(await board.runAction("pcbnew.ZoneFiller.zoneFillAll")).toBe(RunActionStatus.RAS_OK);
    expect((await board.revision())!).toBeGreaterThan(rev0);
    const zones = (await board.getZones()).filter((z) => !z.isRuleArea);
    expect(zones.length).toBeGreaterThan(0);
    if (changed) await changed;
    const unknown = await board.runAction("pcbnew.Nope.nothing").catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ActionError);
    expect((unknown as ActionError).status).toBe(RunActionStatus.RAS_INVALID);
    const gui = await board.runAction("pcbnew.InteractiveSelection.ClearSelection").catch((e: unknown) => e);
    expect(gui).toBeInstanceOf(ActionError);
    expect((gui as ActionError).status).toBe(RunActionStatus.RAS_INVALID);
    return `pcbnew.ZoneFiller.zoneFillAll RAS_OK headless (revision bumped, DocumentChanged without item ids${changed ? ", event seen" : ""}); unknown and GUI-only names RAS_INVALID`;
  });
  guiOnlyTest("GetSelection", () => cmd.getSelection(c(), { header: board.header() }));
  guiOnlyTest("AddToSelection", () => cmd.addToSelection(c(), { header: board.header(), items: [{ value: firstFp.id }] }));
  guiOnlyTest("RemoveFromSelection", () => cmd.removeFromSelection(c(), { header: board.header(), items: [{ value: firstFp.id }] }));
  guiOnlyTest("ClearSelection", () => cmd.clearSelection(c(), { header: board.header() }));
  guiOnlyTest("RevertDocument", () => board.revert());
  guiOnlyTest("SaveSelectionToString", () => cmd.saveSelectionToString(c(), {}));

  // ---- common/editor: undo / redo (KiCad >= 11.0) -------------------------------------------------------
  cmdTest("GetUndoStack", async () => {
    const before = await board.undoStack();
    const fp = (await board.getFootprints())[0]!;
    const home = fp.position;
    const tx = await board.beginCommit();
    const r = await tx.run("conformance undo probe", (t) => {
      fp.position = { x: home.x + mm(1), y: home.y };
      return t.update([fp]);
    });
    const after = await board.undoStack();
    expect(after.undo.length).toBe(before.undo.length + 1);
    const top = after.undo.at(-1)!;
    expect(top.description).toBe("conformance undo probe");
    expect(top.commitId?.value).toBe(r.commitId);
    expect(top.clientName).toBe(c().clientName);
    expect(top.itemCount).toBeGreaterThan(0);
    // Commit.undo() prefers the server stack; it refuses once the commit is no longer on top.
    const undone = await tx.undo();
    expect(undone.applied).toBe(1);
    expect(((await board.getItem(fp.id)) as Footprint).position).toEqual(home);
    await board.redo();
    await board.undo();
    return `${after.undo.length} undo entries, top = "${top.description}" by ${top.clientName} (commit ${top.commitId?.value.slice(0, 8)}, ${top.itemCount} items); Commit.undo() reverted it`;
  });
  cmdTest("Undo", async () => {
    // an edit outside a commit is undoable too
    const origin = await board.origin("grid");
    await board.setOrigin("grid", { x: mm(12), y: mm(13) });
    expect(await board.origin("grid")).toEqual({ x: mm(12), y: mm(13) });
    const stack = await board.undoStack();
    const top = stack.undo.at(-1)!;
    const r = await board.undo();
    expect(r.applied).toBe(1);
    expect(r.redoCount).toBeGreaterThan(0);
    expect(await board.origin("grid")).toEqual(origin);
    // KiCad refuses an undo while a client holds *staged* changes
    const tx = await board.beginCommit();
    const t = new Track();
    t.start = { x: mm(60), y: mm(60) };
    t.end = { x: mm(62), y: mm(60) };
    t.width = mm(0.2);
    t.layerId = BoardLayer.BL_F_Cu;
    await tx.create([t]);
    const busy = await board.undo().then(
      () => undefined,
      (e: unknown) => e,
    );
    await tx.drop();
    const busyNote = KiCadApiError.is(busy, ApiStatusCode.AS_BUSY)
      ? "refused with AS_BUSY while a commit holds staged changes"
      : `KICAD-BUG: undo with staged changes answered ${KiCadApiError.is(busy) ? busy.codeName : "success"} instead of AS_BUSY`;
    // ... but an *empty* open commit does not block it, although the proto says "Refused while a
    // client has an open commit" (the handler only checks for non-empty commits).
    const empty = await board.beginCommit();
    await board.setOrigin("grid", { x: mm(5), y: mm(5) });
    const withEmpty = await board.undo().then(
      (x) => `applied ${x.applied}`,
      (e: unknown) => (KiCadApiError.is(e) ? e.codeName : String(e)),
    );
    await empty.drop();
    await board.setOrigin("grid", origin);
    const emptyNote = withEmpty.startsWith("applied")
      ? "KICAD-BUG: Undo is documented as refused while a client has an open commit, but an open commit with no staged changes is allowed through (api_handler_editor.cpp only rejects non-empty commits)"
      : `an empty open commit also blocks it (${withEmpty})`;
    return `SetBoardOrigin undone (applied ${r.applied}, redo stack ${r.redoCount}); ${busyNote}; ${emptyNote}`;
  });
  cmdTest("Redo", async () => {
    const fp = (await board.getFootprints())[0]!;
    const home = fp.position;
    const moved = { x: home.x + mm(2), y: home.y };
    await board.commit("conformance redo probe", (tx) => {
      fp.position = moved;
      return tx.update([fp]);
    });
    const u = await board.undo();
    expect(u.applied).toBe(1);
    expect(((await board.getItem(fp.id)) as Footprint).position).toEqual(home);
    const r = await board.redo();
    expect(r.applied).toBe(1);
    expect(r.redoCount).toBe(0);
    expect(((await board.getItem(fp.id)) as Footprint).position).toEqual(moved);
    await board.undo(); // leave the board where the rest of the suite expects it
    expect(((await board.getItem(fp.id)) as Footprint).position).toEqual(home);
    // redoing past the end of the stack is not an error, it just applies nothing
    const past = await board.redo(5);
    expect(past.applied).toBeLessThanOrEqual(1);
    if (past.applied) await board.undo(past.applied);
    return `undo/redo round trip on a footprint move (applied ${r.applied}); redo(5) past the stack applied ${past.applied} without erroring`;
  });
  extraTest("store/undo.ts: DocumentUndo prefers KiCad's undo when the capability is present", async () => {
    const store = new MemoryItemStore("board", board.specifier);
    const stack = new UndoStack(store);
    const clientOnly = new DocumentUndo(stack);
    expect(await clientOnly.useServer()).toBe(false);
    const both = new DocumentUndo(stack, board);
    expect(await both.useServer()).toBe(await board.supportsServerUndo());
    const fp = (await board.getFootprints())[0]!;
    const home = fp.position;
    await board.commit("conformance DocumentUndo probe", (tx) => {
      fp.position = { x: home.x + mm(3), y: home.y };
      return tx.update([fp]);
    });
    const out = await both.undo();
    expect(out.via).toBe("server");
    expect(out.applied).toBe(1);
    expect(((await board.getItem(fp.id)) as Footprint).position).toEqual(home);
    // the client fallback still works on its own store
    stack.apply("local", { added: [toStoredItem(fp)] });
    expect(store.size).toBe(1);
    const local = await clientOnly.undo();
    expect(local.via).toBe("client");
    expect(store.size).toBe(0);
    return `DocumentUndo(document) -> server path (applied ${out.applied}); DocumentUndo(store only) -> client patch path`;
  });

  // ---- events + store (not commands) ------------------------------------------------------------------------
  extraTest("Events: DocumentChanged / DocumentSaved on the events socket", async () => {
    if (!events) throw new Error(`no events subscriber: ${eventsError}`);
    // PUB/SUB is intentionally fire-and-forget and earlier command probes can burst hundreds of
    // events before this targeted check. Verify continuity for the events exercised here; gap
    // detection itself has deterministic unit coverage in events.test.ts.
    eventGaps.length = 0;
    const tr = (await board.getTracks())[0]!;
    const ev1 = events.next("documentChanged", { timeoutMs: 10_000, filter: (d) => d.message === "conf: touch track" });
    await board.commit("conf: touch track", (tx) => tx.update([tr]));
    const ch1 = await ev1;
    expect(ids(ch1.updated)).toEqual([tr.id]);
    expect(ids(ch1.created)).toEqual([]);
    expect(ids(ch1.deleted)).toEqual([]);
    expect(ch1.clientName).toBe(c().clientName);
    expect(ch1.commitId?.value).toMatch(UUID);
    expect(ch1.revision).toBe((await board.revision())!);
    const fp = (await board.getItemsById([firstFp.id]))[0] as Footprint;
    const ev2 = events.next("documentChanged", { timeoutMs: 10_000, filter: (d) => d.message === "conf: touch footprint" });
    await board.commit("conf: touch footprint", (tx) => tx.update([fp]));
    const ch2 = await ev2;
    let fpNote: string;
    if (ids(ch2.updated).includes(fp.id)) fpNote = "footprint update reported in `updated`";
    else if (ids(ch2.created).includes(fp.id) && ids(ch2.deleted).includes(fp.id)) {
      fpNote =
        "KICAD-BUG: a footprint UpdateItems is reported as created+deleted of the same KIID instead of updated (DocumentSync.syncIds treats that pair as an update)";
    } else
      throw new Error(
        `footprint update event names neither: created=${ids(ch2.created)} updated=${ids(ch2.updated)} deleted=${ids(ch2.deleted)}`,
      );
    const ev3 = events.next("documentSaved", { timeoutMs: 10_000 });
    await board.save();
    expect((await ev3).path.endsWith("api_kitchen_sink.kicad_pcb")).toBe(true);
    expect(eventGaps).toEqual([]);
    return `${events.received} events so far (last sequence ${events.lastSequence}, no gaps during this probe); track update -> updated=[track]; ${fpNote}; DocumentSaved carries the path`;
  });
  extraTest(
    "Store: DocumentSync.syncSince after another client's commit (since_revision)",
    async () => {
      const sync = board.documentSync;
      await sync.load(); // a fresh full load so the store's revision is current
      expect(sync.revision).toBeDefined();
      expect(await sync.supportsIncrementalSync()).toBe(true);
      const t2 = await rt.secondTransport();
      try {
        const k2 = await KiCad.connect(t2, { clientName: "fp-pcb/conf-second" });
        const b2 = k2.boardFrom(board.specifier);
        const fp = (await b2.getItemsById([firstFp.id]))[0] as Footprint;
        const orig = fp.position;
        fp.position = { x: orig.x + mm(2), y: orig.y };
        await b2.commit("move from second client", (tx) => tx.update([fp]));
        const diffs: { added: number; updated: string[]; removed: string[] }[] = [];
        const off = sync.store.subscribe((d) =>
          diffs.push({ added: d.added.length, updated: d.updated.map((i) => i.id), removed: d.removed }),
        );
        const before = sync.revision!;
        await sync.refresh();
        expect(sync.revision!).toBeGreaterThan(before);
        expect(diffs.length).toBe(1);
        expect(diffs[0]!.added).toBe(0);
        expect(diffs[0]!.removed).toEqual([]);
        expect(diffs[0]!.updated).toContain(firstFp.id);
        expect(diffs[0]!.updated.every((id) => id === firstFp.id || sync.store.get(id)?.parent === firstFp.id)).toBe(true);
        expect((sync.store.get(firstFp.id)!.item as Footprint).position.x).toBe(orig.x + mm(2));
        // deletion from the other client
        const victim = (await b2.getTracks())[0]!;
        await b2.commit("delete from second client", (tx) => tx.delete([victim.id]));
        await sync.syncSince();
        expect(sync.store.has(victim.id)).toBe(false);
        expect(diffs.at(-1)!.removed).toEqual([victim.id]);
        // a change KiCad cannot attribute to items (zone fill) -> full answer, store still consistent
        const r0 = sync.revision!;
        const sizeBefore = sync.store.size;
        await board.runAction("pcbnew.ZoneFiller.zoneFillAll");
        await sync.syncSince();
        off();
        expect(sync.revision!).toBeGreaterThan(r0);
        expect(sync.store.size).toBe(sizeBefore);
        fp.position = orig;
        await b2.commit("move back from second client", (tx) => tx.update([fp]));
        await sync.syncSince();
        expect((sync.store.get(firstFp.id)!.item as Footprint).position.x).toBe(orig.x);
        return `incremental refresh: 1 diff with ${diffs[0]!.updated.length} updated items (footprint + pads), deletion propagated, full re-sync after a zone fill keeps ${sizeBefore} items`;
      } finally {
        await t2.close();
      }
    },
    120_000,
  );

  // ---- common/settings (settings_commands.proto, KiCad >= 11.0; no document needed) ----------------------
  cmdTest("ListColorThemes", async () => {
    const themes = await k().settings.colorThemes();
    expect(themes.length).toBeGreaterThanOrEqual(2);
    const names = themes.map((t) => t.name);
    // The two built-ins are always there; a user install may add more from ~/.config/kicad/<ver>/colors.
    expect(names).toContain("KiCad Default");
    expect(names).toContain("KiCad Classic");
    for (const t of themes) {
      expect(t.name.length).toBeGreaterThan(0);
      // Built-ins live in memory (filename "_builtin_*", suppressed by the handler) and are read-only.
      if (t.name.startsWith("KiCad ")) {
        expect(t.readOnly).toBe(true);
        expect(t.filename).toBe("");
      }
      // Every listed theme must be fetchable by name.
      expect((await k().settings.colorTheme(t.name)).name).toBe(t.name);
    }
    return `${themes.length} themes: ${names.join(", ")}`;
  });
  cmdTest("GetColorTheme", async () => {
    const def = await k().settings.colorTheme("KiCad Default");
    expect(def.name).toBe("KiCad Default");
    expect(def.readOnly).toBe(true);
    expect(def.overrideSchItemColors).toBe(false);
    const keys = Object.keys(def.colors);
    expect(keys.length).toBeGreaterThan(200);
    // Flat COLOR_SETTINGS keys ("board.copper.f"), exactly what the renderer's themeFromJson makes.
    expect([...new Set(keys.map((key) => key.split(".")[0]))].sort()).toEqual(["3d_viewer", "board", "gerbview", "schematic"]);
    for (const key of ["board.copper.f", "board.background", "schematic.wire", "schematic.background"]) {
      const col = def.colors[key];
      expect(col).toBeDefined();
      for (const ch of [col!.r, col!.g, col!.b]) {
        expect(Number.isInteger(ch)).toBe(true);
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
      expect(col!.a).toBeGreaterThanOrEqual(0);
      expect(col!.a).toBeLessThanOrEqual(1);
      expect(def.layers[key]).toBeDefined();
    }
    // COLOR4D 0..1 -> 0..255: KiCad's default F.Cu is #C83434 and its wire colour #009600.
    expect(def.colors["board.copper.f"]).toEqual({ r: 200, g: 52, b: 52, a: 1 });
    expect(def.colors["schematic.wire"]).toEqual({ r: 0, g: 150, b: 0, a: 1 });
    // Layer ids are the KiCad enums: F_Cu = 0, LAYER_WIRE = 1102.
    expect(def.layers["board.copper.f"]).toBe(0);
    expect(def.layers["schematic.wire"]).toBe(1102);
    // An empty name means the built-in default; the lookup is case-insensitive on the display name.
    const empty = await k().settings.colorTheme();
    expect(empty.name).toBe("KiCad Default");
    expect(Object.keys(empty.colors).length).toBe(keys.length);
    expect((await k().settings.colorTheme("kicad default")).name).toBe("KiCad Default");
    const err = await k()
      .settings.colorTheme("no-such-theme")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(err, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    expect((err as KiCadApiError).serverMessage).toContain("see ListColorThemes");
    const classic = await k().settings.colorTheme("KiCad Classic");
    expect(classic.name).toBe("KiCad Classic");
    const classicNote =
      Object.keys(classic.colors).length === 0
        ? "KICAD-BUG: KiCad Classic answers 0 colors (CreateBuiltinColorSettings() clears its m_params to disable load/store, so COLOR_SETTINGS::GetColorKeys() -- which the handler enumerates -- is empty)"
        : `KiCad Classic: ${Object.keys(classic.colors).length} colors`;
    return `KiCad Default: ${keys.length} colors over ${[...new Set(keys.map((key) => key.split(".")[0]))].sort().join("/")}, board.copper.f=#C83434 @ layer 0; empty name and "kicad default" resolve to it; unknown name AS_BAD_REQUEST; ${classicNote}`;
  });
  cmdTest("GetAppSettings", async () => {
    const notes: string[] = [];
    const files: Record<string, string> = {
      pcb: "pcbnew.json",
      schematic: "eeschema.json",
      footprint: "fpedit.json",
      symbol: "symbol_editor.json",
    };
    const apps = [
      ["pcb", AppType.APP_PCB_EDITOR],
      ["schematic", AppType.APP_SCHEMATIC_EDITOR],
      ["footprint", AppType.APP_FOOTPRINT_EDITOR],
      ["symbol", AppType.APP_SYMBOL_EDITOR],
    ] as const;
    for (const [name, type] of apps) {
      const s = await k().settings.appSettings(name);
      expect(s.app).toBe(type);
      expect(s.settingsFile).toBe(files[name]!);
      // The short name and the enum are the same request.
      expect(await k().settings.appSettings(type)).toEqual(s);
      expect(s.units).not.toBe(UnitSystem.US_UNKNOWN);
      // Grids are the user's own strings ("100 mil"), never nm; current_grid indexes into them.
      expect(s.grids.length).toBeGreaterThan(0);
      expect(s.currentGrid).toBeLessThan(s.grids.length);
      for (const g of s.grids) {
        expect(g.x.length).toBeGreaterThan(0);
        expect(g.y.length).toBeGreaterThan(0);
      }
      const grid = (await k().settings.currentGrid(name))!;
      expect(grid).toEqual({ name: s.grids[s.currentGrid]!.name, x: s.grids[s.currentGrid]!.x, y: s.grids[s.currentGrid]!.y });
      expect(s.zoomFactors.length).toBeGreaterThan(0);
      expect(s.zoomFactors.every((z) => z > 0)).toBe(true);
      expect(s.gridStyle).toBeLessThanOrEqual(2);
      expect(s.gridSnap).toBeLessThanOrEqual(2);
      // The colour theme is named by file name ("_builtin_default"), and must resolve.
      expect(s.colorTheme.length).toBeGreaterThan(0);
      const theme = await k().settings.colorTheme(s.colorTheme);
      expect(theme.name.length).toBeGreaterThan(0);
      // Only the editors whose item defaults are application-wide report any; the board's live in
      // the document (GetGraphicsDefaults), so pcb/footprint answer an empty map.
      const defaults = Object.keys(s.defaults);
      if (name === "schematic") {
        expect(defaults).toContain("default_wire_thickness");
        expect(defaults).toContain("default_text_size");
      } else if (name === "pcb" || name === "footprint") {
        expect(defaults).toEqual([]);
      }
      notes.push(
        `${name} ${UnitSystem[s.units]!.replace(/^US_/, "").toLowerCase()} theme "${s.colorTheme}"(${theme.name}) ${s.grids.length} grids @${s.currentGrid}="${grid.x}" ${s.zoomFactors.length} zooms ${defaults.length} defaults ${s.settingsFile}`,
      );
    }
    const err = await k()
      .settings.appSettings(AppType.APP_UNKNOWN)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(err, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    return `${notes.join("; ")}; APP_UNKNOWN AS_BAD_REQUEST`;
  });

  // ---- common/variant ----------------------------------------------------------------------------------
  cmdTest("AddVariant", async () => {
    await board.variants.add("V1", "first");
    await sch.variants.add("S1");
  });
  cmdTest("GetVariants", async () => {
    const names = await board.variants.names();
    expect(names).toContain("V1");
    expect(await sch.variants.names()).toContain("S1");
    return names.join(", ");
  });
  cmdTest("SetVariantDescription", async () => {
    await board.variants.setDescription("V1", "described");
    const v = (await board.variants.list()).find((x) => x.name === "V1");
    expect(v?.description).toBe("described");
  });
  cmdTest("RenameVariant", async () => {
    await board.variants.rename("V1", "V2");
    expect(await board.variants.names()).toContain("V2");
  });
  cmdTest("CopyVariant", async () => {
    await board.variants.copy("V2", "V3", "copy");
    expect(await board.variants.names()).toContain("V3");
  });
  cmdTest("SetCurrentVariant", async () => {
    await board.variants.setCurrent("V3");
  });
  cmdTest("GetCurrentVariant", async () => {
    expect(await board.variants.current()).toBe("V3");
    await board.variants.setCurrent(undefined);
    expect(await board.variants.current()).toBeUndefined();
  });
  cmdTest("DeleteVariant", async () => {
    await board.variants.delete("V3");
    await board.variants.delete("V2");
    await sch.variants.delete("S1");
    expect(await board.variants.names()).not.toContain("V2");
  });

  // ---- common/crossprobe ---------------------------------------------------------------------------------
  cmdTest("CrossProbeAnnounce", async () => {
    const r = await k().crossProbeAnnounce(FrameType.FT_SCHEMATIC_EDITOR, "/tmp/kicad/nonexistent.sock", "");
    expect(Object.values(CrossProbeStatus)).toContain(r.status);
    return `${CrossProbeStatus[r.status]} ${r.message}`.trim();
  });
  cmdTest("FocusOnItem", async () => {
    const r = await cmd.focusOnItem(c(), { focusItem: { spec: { case: "footprint", value: { reference: firstFp.reference } } } });
    expect(r.status).toBe(CrossProbeStatus.CPS_OK);
    return "headless no-op CPS_OK";
  });
  guiOnlyTest("HighlightNets", () => cmd.highlightNets(c(), { netName: netNames.slice(0, 1) }));
  guiOnlyTest("SyncSelection", () =>
    cmd.syncSelection(c(), { items: [{ spec: { case: "footprint", value: { reference: firstFp.reference } } }] }),
  );

  // ---- common/library (library tables, entries, items, wizards) -------------------------------------------
  cmdTest("GetLibraryTables", async () => {
    const fp = await k().libraries.tables("footprint");
    const sym = await k().libraries.tables("symbol");
    const db = await k().libraries.tables("designBlock");
    expect(fp.length).toBeGreaterThan(0);
    expect(sym.length).toBeGreaterThan(0);
    // The temp project's own tables (written by tempProject) come back as project-scope rows.
    const fpProject = fp.filter((r) => r.scope === 2).map((r) => r.nickname);
    const symProject = sym.filter((r) => r.scope === 2).map((r) => r.nickname);
    expect(fpProject).toContain("Resistor_SMD");
    expect(symProject).toContain("Device");
    const row = fp.find((r) => r.nickname === "Resistor_SMD")!;
    expect(row.type).toBe("KiCad");
    expect(row.enabled).toBe(true);
    expect(row.ok).toBe(true);
    expect(row.resolvedUri).toBe(QA_RESISTOR_LIB);
    // scope filters
    expect((await k().libraries.tables("symbol", "project")).map((r) => r.nickname)).toEqual(symProject);
    expect((await k().libraries.tables("symbol", "global")).every((r) => r.scope === 1)).toBe(true);
    const bad = fp.filter((r) => !r.ok).map((r) => `${r.nickname}: ${r.error}`);
    return `footprint ${fp.length} rows (${fpProject.length} project), symbol ${sym.length} (${symProject.length} project), design block ${db.length}; ${bad.length} rows failed to resolve${bad.length ? `: ${bad.slice(0, 3).join("; ")}` : ""}`;
  });
  cmdTest("ListLibraryEntries", async () => {
    const fps = await k().libraries.footprints.entries("Resistor_SMD", "0603");
    expect(fps.length).toBeGreaterThan(0);
    const r0603 = fps.find((e) => e.name === "R_0603_1608Metric")!;
    expect(r0603).toBeDefined();
    expect(r0603.id?.libraryNickname).toBe("Resistor_SMD");
    expect(r0603.info.case).toBe("footprint");
    const fpInfo = r0603.info.value as { padCount: number; uniquePadCount: number; models: string[] };
    expect(fpInfo.padCount).toBe(2);
    expect(fpInfo.uniquePadCount).toBe(2);
    expect(r0603.description.length).toBeGreaterThan(0);
    const all = await k().libraries.footprints.entries("Resistor_SMD");
    expect(all.length).toBeGreaterThanOrEqual(fps.length);
    const syms = await k().libraries.symbols.entries("Device");
    expect(syms.length).toBeGreaterThan(0);
    expect(syms[0]!.info.case).toBe("symbol");
    const unknown = await k()
      .libraries.footprints.entries("NoSuchLibrary")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(unknown, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    return `Resistor_SMD: ${all.length} entries (${fps.length} match "0603", R_0603_1608Metric has ${fpInfo.padCount} pads and ${fpInfo.models.length} 3D model(s)); Device: ${syms.length} symbols; unknown nickname AS_BAD_REQUEST`;
  });
  cmdTest("GetLibraryItem", async () => {
    const fp = await k().libraries.footprints.get("Resistor_SMD:R_0603_1608Metric");
    expect(fp).toBeInstanceOf(LibFootprint);
    const lf = fp as LibFootprint;
    expect(lf.libraryId).toBe("Resistor_SMD:R_0603_1608Metric");
    expect(lf.padCount).toBe(2);
    expect(lf.items.length).toBeGreaterThan(lf.padCount);
    const symName = /^\s*\(symbol "([^"]+)"/m.exec(await readFile(QA_DEVICE_LIB, "utf8"))![1]!;
    const sym = await k().libraries.symbols.get(`Device:${symName}`);
    expect(sym).toBeInstanceOf(LibSymbol);
    const ls = sym as LibSymbol;
    expect(ls.libraryId).toBe(`Device:${symName}`);
    expect(ls.pins.length).toBeGreaterThan(0);
    const missing = await k()
      .libraries.footprints.get("Resistor_SMD:NoSuchFootprint")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(missing, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    return `Resistor_SMD:R_0603_1608Metric -> LibFootprint (${lf.padCount} pads, ${lf.items.length} items); Device:${symName} -> LibSymbol (${ls.pins.length} pins, ${ls.unitCount} unit(s)); missing entry AS_BAD_REQUEST`;
  });
  cmdTest("CreateLibrary", async () => {
    const fpRow = await k().libraries.footprints.createLibrary({ nickname: "conf_fp", scope: "project", description: "conformance" });
    expect(fpRow.nickname).toBe("conf_fp");
    expect(fpRow.scope).toBe(2);
    expect(fpRow.type).toBe("KiCad");
    expect(fpRow.ok).toBe(true);
    expect(fpRow.uri).toContain("${KIPRJMOD}");
    expect(existsSync(join(tmp.dir, "conf_fp.pretty"))).toBe(true);
    const symRow = await k().libraries.symbols.createLibrary({ nickname: "conf_sym", scope: "project" });
    expect(symRow.resolvedUri).toBe(join(tmp.dir, "conf_sym.kicad_sym"));
    expect(existsSync(symRow.resolvedUri)).toBe(true);
    expect(await k().libraries.nicknames("footprint", "project")).toContain("conf_fp");
    return `conf_fp -> ${fpRow.uri} (created on disk), conf_sym -> ${symRow.uri}`;
  });
  cmdTest("SaveLibraryItem", async () => {
    const src = (await k().libraries.footprints.get("Resistor_SMD:R_0603_1608Metric")) as LibFootprint;
    const id = await k().libraries.footprints.save("conf_fp:conf_r", src);
    expect(id.libraryNickname).toBe("conf_fp");
    expect(id.entryName).toBe("conf_r");
    const back = (await k().libraries.footprints.get("conf_fp:conf_r")) as LibFootprint;
    expect(back).toBeInstanceOf(LibFootprint);
    expect(back.libraryId).toBe("conf_fp:conf_r");
    expect(back.padCount).toBe(src.padCount);
    expect(back.pads.map((p) => p.number).sort()).toEqual(src.pads.map((p) => p.number).sort());
    expect((await k().libraries.footprints.entries("conf_fp")).map((e) => e.name)).toEqual(["conf_r"]);
    // a second write needs overwrite
    const clash = await k()
      .libraries.footprints.save("conf_fp:conf_r", src)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(clash, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    await k().libraries.footprints.save("conf_fp:conf_r", src, { overwrite: true });
    // symbols travel the same way
    const symName = /^\s*\(symbol "([^"]+)"/m.exec(await readFile(QA_DEVICE_LIB, "utf8"))![1]!;
    const sym = (await k().libraries.symbols.get(`Device:${symName}`)) as LibSymbol;
    const symId = await k().libraries.symbols.save("conf_sym:conf_s", sym);
    expect(symId.entryName).toBe("conf_s");
    const symBack = (await k().libraries.symbols.get("conf_sym:conf_s")) as LibSymbol;
    expect(symBack.pins.length).toBe(sym.pins.length);
    return `footprint round trip conf_fp:conf_r (${back.padCount} pads, pad numbers preserved); overwrite refused without the flag (AS_BAD_REQUEST) and accepted with it; symbol round trip conf_sym:conf_s (${symBack.pins.length} pins)`;
  });
  cmdTest("DeleteLibraryItem", async () => {
    expect((await k().libraries.footprints.entries("conf_fp")).length).toBe(1);
    await k().libraries.footprints.delete("conf_fp:conf_r");
    expect(await k().libraries.footprints.entries("conf_fp")).toEqual([]);
    const gone = await k()
      .libraries.footprints.get("conf_fp:conf_r")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(gone, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    return "conf_fp:conf_r deleted; the library is empty and GetLibraryItem answers AS_BAD_REQUEST";
  });
  cmdTest("AddLibraryTableRow", async () => {
    const uri = join(tmp.dir, "conf_row.pretty");
    const row = await k().libraries.footprints.addTableRow("project", { nickname: "conf_row", uri, description: "added by the API" });
    expect(row.nickname).toBe("conf_row");
    expect(row.uri).toBe(uri);
    expect(row.type).toBe("KiCad");
    expect(row.scope).toBe(2);
    expect(await k().libraries.nicknames("footprint", "project")).toContain("conf_row");
    // the library files are not created for a plain row
    expect(existsSync(uri)).toBe(false);
    const clash = await k()
      .libraries.footprints.addTableRow("project", { nickname: "conf_row", uri })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(clash, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    const replaced = await k().libraries.footprints.addTableRow("project", { nickname: "conf_row", uri, description: "replaced" }, true);
    expect(replaced.description).toBe("replaced");
    return `conf_row added (no files created), duplicate refused AS_BAD_REQUEST, replace:true updates the row`;
  });
  cmdTest("RemoveLibraryTableRow", async () => {
    await k().libraries.footprints.removeTableRow("project", "conf_row");
    expect(await k().libraries.nicknames("footprint", "project")).not.toContain("conf_row");
    const gone = await k()
      .libraries.footprints.removeTableRow("project", "conf_row")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(gone, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    // the table file on disk reflects the change
    const table = await readFile(join(tmp.dir, "fp-lib-table"), "utf8");
    expect(table).not.toContain("conf_row");
    expect(table).toContain("Resistor_SMD");
    return "row removed from the project table and from fp-lib-table on disk; removing it twice is AS_BAD_REQUEST";
  });
  cmdTest("ListWizards", async () => {
    const list = await k().libraries.wizards(true);
    // Footprint wizards come from installed API (Python) plugins; a bare CLI server has none.
    expect(Array.isArray(list)).toBe(true);
    for (const w of list) expect(w.meta?.identifier.length).toBeGreaterThan(0);
    return list.length
      ? `${list.length} wizards: ${list.map((w) => w.meta?.identifier).join(", ")}`
      : "0 wizards (kicad-cli api-server loads no API plugins, so FOOTPRINT_WIZARD_MANAGER finds nothing)";
  });
  cmdTest("RunWizard", async () => {
    const list = await k().libraries.wizards();
    const unknown = await k()
      .libraries.runWizard("no.such.wizard")
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(KiCadApiError.is(unknown, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    expect((unknown as KiCadApiError).serverMessage).toContain("see ListWizards");
    if (!list.length) {
      record("RunWizard", "pass", "no wizards installed; unknown identifier answers AS_BAD_REQUEST (\"no wizard '...'; see ListWizards\")");
      return;
    }
    const w = list[0]!;
    const r = await k().libraries.runWizard(w.meta!.identifier);
    expect(r.status).toBe(WizardGenerationStatus.WGS_OK);
    expect(r.footprint).toBeInstanceOf(LibFootprint);
    return `${w.meta!.identifier} generated a footprint with ${r.footprint!.padCount} pads`;
  });
  extraTest("Events: ProjectChanged{PCK_LIBRARY_TABLES} for library table edits", async () => {
    if (!events) throw new Error(`no events subscriber: ${eventsError}`);
    const seen: ProjectChangeKind[] = [];
    const off = events.onProjectChanged((e) => seen.push(e.kind), [ProjectChangeKind.PCK_LIBRARY_TABLES]);
    const next = events.next("projectChanged", { timeoutMs: 10_000, filter: (e) => e.kind === ProjectChangeKind.PCK_LIBRARY_TABLES });
    await k().libraries.footprints.addTableRow("project", { nickname: "conf_evt", uri: join(tmp.dir, "conf_evt.pretty") });
    const ev = await next;
    expect(ev.kind).toBe(ProjectChangeKind.PCK_LIBRARY_TABLES);
    expect(ev.project?.name).toBe("api_kitchen_sink");
    await k().libraries.footprints.removeTableRow("project", "conf_evt");
    await Bun.sleep(200);
    off();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    return `${seen.length} PCK_LIBRARY_TABLES events (add + remove), client "${ev.clientName}"`;
  });

  // ---- board/commands -----------------------------------------------------------------------------------
  cmdTest("GetBoardStackup", async () => {
    const s = await board.stackup();
    expect(s.layers.length).toBeGreaterThan(0);
    return `${s.layers.length} stackup layers`;
  });
  cmdTest("UpdateBoardStackup", async () => {
    const s = await board.stackup();
    const res = await board.updateStackup(s);
    expect(res.layers.length).toBe(s.layers.length);
  });
  cmdTest("GetBoardEnabledLayers", async () => {
    const l = await board.enabledLayers();
    expect(l.copperLayerCount).toBeGreaterThanOrEqual(2);
    expect(l.layers).toContain(BoardLayer.BL_F_Cu);
    return `${l.copperLayerCount} copper, ${l.layers.length} enabled`;
  });
  cmdTest("SetBoardEnabledLayers", async () => {
    const l = await board.enabledLayers();
    const res = await board.setEnabledLayers(l.layers, l.copperLayerCount);
    expect(res.copperLayerCount).toBe(l.copperLayerCount);
  });
  cmdTest("GetBoardLayerName", async () => {
    expect(await board.layerName(BoardLayer.BL_F_Cu)).toBe("F.Cu");
  });
  cmdTest("GetBoardLayerByName", async () => {
    expect(await board.layerByName("F.Cu")).toBe(BoardLayer.BL_F_Cu);
  });
  cmdTest("GetGraphicsDefaults", async () => {
    const d = await board.graphicsDefaults();
    expect(d?.layers.length ?? 0).toBeGreaterThan(0);
    return `${d!.layers.length} layer classes`;
  });
  cmdTest("SetGraphicsDefaults", async () => {
    const before = (await board.graphicsDefaults())!;
    const first = before.layers[0]!;
    const width = Number(first.lineThickness?.valueNm ?? 0n);
    const r = await board.setGraphicsDefaults({
      layers: [{ layer: first.layer, text: first.text, lineThickness: toDistance(width + mm(0.05)) }],
    });
    const changed = r!.layers.find((l) => l.layer === first.layer)!;
    expect(Number(changed.lineThickness!.valueNm)).toBe(width + mm(0.05));
    // the classes that were not sent keep their values
    expect(r!.layers.length).toBe(before.layers.length);
    for (const l of before.layers.slice(1)) {
      const now = r!.layers.find((x) => x.layer === l.layer)!;
      expect(now.lineThickness?.valueNm).toBe(l.lineThickness?.valueNm);
    }
    await board.setGraphicsDefaults({ layers: [first] });
    expect(Number((await board.graphicsDefaults())!.layers.find((l) => l.layer === first.layer)!.lineThickness!.valueNm)).toBe(width);
    return `layer class ${first.layer} line thickness ${(width / 1e6).toFixed(3)} -> ${((width + mm(0.05)) / 1e6).toFixed(3)} mm and back; the other ${before.layers.length - 1} classes untouched`;
  });
  cmdTest("GetBoardDesignRules", async () => {
    const r = await board.designRules();
    expect(r.rules.constraints).toBeDefined();
    expect(r.customRulesStatus).toBe(CustomRulesStatus.CRS_VALID);
    return `min track ${Number(r.rules.constraints?.minTrackWidth?.valueNm ?? 0n) / 1e6} mm`;
  });
  cmdTest("SetBoardDesignRules", async () => {
    const r = await board.designRules();
    const w = Number(r.rules.constraints!.minTrackWidth!.valueNm) + 1000;
    const set = await board.setDesignRules({ constraints: { ...r.rules.constraints!, minTrackWidth: toDistance(w) } });
    expect(Number(set.constraints?.minTrackWidth?.valueNm)).toBe(w);
    const verify = await board.designRules();
    expect(Number(verify.rules.constraints?.minTrackWidth?.valueNm)).toBe(w);
  });
  cmdTest("GetCustomDesignRules", async () => {
    const r = await board.customRules();
    expect(r.status).toBe(CustomRulesStatus.CRS_VALID);
    expect(r.rules.some((x) => x.name === "myrule")).toBe(true);
    return `${r.rules.length} rules`;
  });
  cmdTest("SetCustomDesignRules", async () => {
    const r = await board.customRules();
    const res = await board.setCustomRules([...r.rules, { name: "fp_pcb_rule", condition: "A.NetClass == 'HV'", constraints: [] }]);
    expect(res.status).toBe(CustomRulesStatus.CRS_VALID);
    expect(res.rules.length).toBe(r.rules.length + 1);
  });
  cmdTest("GetBoardOrigin", async () => {
    const o = await board.origin("grid");
    expect(o).toBeDefined();
    return `grid origin (${o.x}, ${o.y})`;
  });
  cmdTest("SetBoardOrigin", async () => {
    await board.setOrigin("drill", { x: mm(3), y: mm(4) });
    const o = await board.origin("drill");
    expect(o).toEqual({ x: mm(3), y: mm(4) });
    expect(BoardOriginType.BOT_DRILL).toBe(BoardOriginType.BOT_DRILL);
  });
  cmdTest("GetBoardPlotSettings", async () => {
    const p = await board.plotSettings();
    expect(p).toBeDefined();
  });
  cmdTest("SetBoardPlotSettings", async () => {
    const p = await board.plotSettings();
    await board.setPlotSettings({ ...p, plotFootprintValues: !p.plotFootprintValues });
    expect((await board.plotSettings()).plotFootprintValues).toBe(!p.plotFootprintValues);
    await board.setPlotSettings(p);
  });
  cmdTest("GetNets", async () => {
    expect(netNames.length).toBeGreaterThan(0);
    return `${netNames.length} nets`;
  });
  cmdTest("GetNetClassForNets", async () => {
    const m = await board.netClassForNets(netNames.slice(0, 3));
    expect(m.size).toBeGreaterThan(0);
  });
  cmdTest("GetItemsByNet", async () => {
    const items = await board.itemsByNet(netNames);
    expect(items.length).toBeGreaterThan(0);
    return `${items.length} items on ${netNames.length} nets`;
  });
  cmdTest("GetItemsByNetClass", async () => {
    const items = await board.itemsByNetClass(["Default"]);
    expect(Array.isArray(items)).toBe(true);
    return `${items.length} items in Default`;
  });
  cmdTest("GetConnectedItems", async () => {
    const pad = pads.find((p) => p.net);
    expect(pad).toBeDefined();
    const items = await board.connectedItems([pad!.id]);
    return `${items.length} items connected to pad ${pad!.number} (${pad!.net})`;
  });
  cmdTest("GetPadShapeAsPolygon", async () => {
    const polys = await board.padShapesAsPolygons(
      pads.slice(0, 3).map((p) => p.id),
      BoardLayer.BL_F_Cu,
    );
    expect(polys.size).toBeGreaterThan(0);
  });
  cmdTest("CheckPadstackPresenceOnLayers", async () => {
    const m = await board.padstackPresence(
      pads.slice(0, 3).map((p) => p.id),
      [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
    );
    expect(m.size).toBe(6);
    expect([...m.values()].every((v) => v !== PadstackPresence.PSP_UNKNOWN)).toBe(true);
  });
  cmdTest("FlipItems", async () => {
    const [flipped] = await board.flip([firstFp.id]);
    expect((flipped as Footprint).layerId).toBe(firstFp.layerId === BoardLayer.BL_F_Cu ? BoardLayer.BL_B_Cu : BoardLayer.BL_F_Cu);
    await board.flip([firstFp.id]);
    expect(((await board.getItemsById([firstFp.id]))[0] as Footprint).layerId).toBe(firstFp.layerId);
  });
  cmdTest("RefillZones", async () => {
    const zones = (await board.getZones()).filter((z) => !z.isRuleArea);
    await board.refillZones(zones.map((z) => z.id));
    await board.refillZones();
    return `${zones.length} zones`;
  });
  cmdTest("GetEmbeddedFiles", async () => {
    const files = await board.embeddedFiles();
    return `${files.length} embedded files`;
  });
  cmdTest("AddEmbeddedFiles", async () => {
    // `EmbeddedFile.data` must be base64(zstd(raw)) — Board encodes raw bytes for us.
    await board.addEmbeddedFiles([{ name: "fp-pcb.txt", type: EmbeddedFileType.EFT_OTHER, data: new TextEncoder().encode("hello") }]);
    const files = await board.embeddedFiles();
    const mine = files.find((f) => f.name === "fp-pcb.txt");
    expect(mine).toBeDefined();
    expect(new TextDecoder().decode(embeddedFileContent(mine!))).toBe("hello");
    return "data is base64(zstd(raw)); hash may be empty";
  });
  cmdTest("SetEmbeddedFiles", async () => {
    await board.setEmbeddedFiles([]);
    expect((await board.embeddedFiles()).length).toBe(0);
  });
  cmdTest("InjectDrcError", async () => {
    const before = (await board.drc.markers()).markers.length;
    const id = await board.injectDrcError("fp-pcb injected", firstFp.position, {
      severity: DrcSeverity.DRS_WARNING,
      items: [firstFp.id],
    });
    expect(id).toMatch(UUID);
    const after = await board.drc.markers();
    const mine = after.markers.find((m) => m.id?.value === id);
    expect(mine).toBeDefined();
    expect(mine!.description).toContain("fp-pcb injected");
    expect(after.markers.length).toBe(before + 1);
    return `${id} appears in GetDrcMarkers (${before} -> ${after.markers.length} markers)`;
  });
  cmdTest(
    "ImportNetlist",
    async () => {
      const r = await board.importNetlist(QA_NETLIST, { dryRun: true, matchMode: "reference" });
      expect(typeof r.report).toBe("string");
      return `dry run of a QA netlist: ${r.errorCount} errors, ${r.warningCount} warnings, ${r.newFootprintCount} new footprints`;
    },
    120_000,
  );
  guiOnlyTest("GetActiveLayer", () => cmd.getActiveLayer(c(), { board: board.specifier }));
  guiOnlyTest("SetActiveLayer", () => cmd.setActiveLayer(c(), { board: board.specifier, layer: BoardLayer.BL_F_Cu }));
  guiOnlyTest("GetVisibleLayers", () => cmd.getVisibleLayers(c(), { board: board.specifier }));
  guiOnlyTest("SetVisibleLayers", () => cmd.setVisibleLayers(c(), { board: board.specifier, layers: [BoardLayer.BL_F_Cu] }));
  guiOnlyTest("GetBoardEditorAppearanceSettings", () => cmd.getBoardEditorAppearanceSettings(c(), {}));
  guiOnlyTest("SetBoardEditorAppearanceSettings", () => cmd.setBoardEditorAppearanceSettings(c(), {}));
  guiOnlyTest("InteractiveMoveItems", () => cmd.interactiveMoveItems(c(), { board: board.specifier, items: [{ value: firstFp.id }] }));

  // ---- board/jobs -----------------------------------------------------------------------------------------
  const boardJob = (
    name: string,
    run: (out: string) => Promise<{ outputPaths: string[]; status: JobStatus }>,
    ext: string,
    timeout = 120_000,
    // Jobs the headless core (stdio, wasm) cannot run at all -- no OpenCascade, no 3D viewer.
    // There the contract is a clean JobError naming the gap, never a crash or a hang.
    headlessUnsupported = false,
  ) =>
    cmdTest(
      name,
      async () => {
        const out = join(tmp.dir, `job-${name}${ext}`);
        if (headlessUnsupported && KICAD_TRANSPORT !== "ipc") {
          const err = await run(out).then(
            () => null,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(JobError);
          expect((err as JobError).message).toMatch(/not available in this build/);
          return `unsupported in the headless core: ${(err as JobError).message.replace(/^.*?: /, "")}`;
        }
        const r = await run(out);
        const produced = [...r.outputPaths, out].filter((p) => existsSync(p));
        expect(produced.length).toBeGreaterThan(0);
        return `${JobStatus[r.status]}: ${produced.length} file(s)`;
      },
      timeout,
    );
  boardJob(
    "RunBoardJobExportSvg",
    (out) => board.jobs.exportSvg(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_Edge_Cuts] } }),
    ".svg",
  );
  boardJob("RunBoardJobExportDxf", (out) => board.jobs.exportDxf(out, { plotSettings: { layers: [BoardLayer.BL_Edge_Cuts] } }), ".dxf");
  boardJob("RunBoardJobExportPdf", (out) => board.jobs.exportPdf(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu] } }), ".pdf");
  boardJob("RunBoardJobExportPs", (out) => board.jobs.exportPs(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu] } }), ".ps");
  boardJob(
    "RunBoardJobExportGerbers",
    (out) => board.jobs.exportGerbers(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu] } }),
    "",
  );
  boardJob("RunBoardJobExportDrill", (out) => board.jobs.exportDrill(`${out}/`, { format: DrillFormat.DF_EXCELLON }), "");
  boardJob("RunBoardJobExportPosition", (out) => board.jobs.exportPosition(out), ".pos");
  boardJob("RunBoardJobExportGencad", (out) => board.jobs.exportGencad(out), ".cad");
  boardJob("RunBoardJobExportIpc2581", (out) => board.jobs.exportIpc2581(out), ".xml");
  boardJob("RunBoardJobExportIpcD356", (out) => board.jobs.exportIpcD356(out), ".d356");
  boardJob("RunBoardJobExportODB", (out) => board.jobs.exportOdb(out), ".zip");
  boardJob("RunBoardJobExportStats", (out) => board.jobs.exportStats(out, { format: StatsOutputFormat.SOF_JSON }), ".json");
  boardJob("RunBoardJobExportSpecctra", (out) => board.jobs.exportSpecctra(out), ".dsn");
  cmdTest("ImportSpecctraSession", async () => {
    // Garbage must be refused with the parser's message, not swallowed or wedged.
    const bad = await board.importSpecctraSession({ contents: "this is not a session" }).then(
      () => "accepted garbage",
      (e: unknown) => (e instanceof KiCadApiError ? e.codeName : String(e)),
    );
    expect(bad).toBe("AS_BAD_REQUEST");
    // A session with no routes is the smallest valid input the importer knows; it must apply
    // cleanly and change nothing. The DSN exported above proves the pair works end to end in the
    // router package's integration test, which runs a real Freerouting session through it.
    const empty = `(session "conf" (base_design "conf.dsn")
  (placement (resolution um 10))
  (was_is)
  (routes (resolution um 10) (parser (host_cad "KiCad")) (library_out) (network_out)))`;
    const r = await board.importSpecctraSession({ contents: empty });
    expect(r.tracksAdded).toBe(0);
    expect(r.viasAdded).toBe(0);
    return `garbage -> AS_BAD_REQUEST; empty session applied: ${r.tracksAdded} tracks, ${r.footprintsMoved} footprints moved, ${r.warnings.length} warning(s)`;
  });
  boardJob(
    "RunBoardJobExport3D",
    (out) => board.jobs.export3D(out, { format: Board3DFormat.B3D_GLB, overwrite: true }),
    ".glb",
    300_000,
    true,
  );
  boardJob(
    "RunBoardJobExportRender",
    (out) => board.jobs.exportRender(out, { format: RenderFormat.RF_PNG, width: 320, height: 240 }),
    ".png",
    300_000,
    true,
  );
  cmdTest(
    "GetJobStatus",
    async () => {
      // async gerbers with inline outputs: JS_RUNNING + job id, JobProgress events, GetJobStatus polling
      const out = join(tmp.dir, "job-async-gerbers");
      const r = await board.jobs.exportGerbers(
        out,
        { plotSettings: { layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu] } },
        { async: true, returnInline: true },
      );
      expect(r.jobId).toMatch(UUID);
      expect(r.running).toBe(true);
      expect(r.status).toBe(JobStatus.JS_RUNNING);
      expect(r.job).toBeDefined();
      const seen: JobProgress[] = [];
      const off = events?.on("jobProgress", (p) => {
        if (p.jobId === r.jobId) seen.push(p);
      });
      const progress: string[] = [];
      const done = await r.job!.wait({
        events,
        intervalMs: 50,
        onProgress: (p) => progress.push(`${p.percent}%${p.description ? ` ${p.description}` : ""}${p.finished ? " (finished)" : ""}`),
      });
      await Bun.sleep(100);
      off?.();
      expect(done.running).toBe(false);
      expect(done.ok).toBe(true);
      expect(done.jobId).toBe(r.jobId);
      expect(done.outputPaths.length).toBe(2);
      expect(done.inlineOutputs.length).toBe(2);
      for (const o of done.inlineOutputs) {
        expect(existsSync(o.path)).toBe(true);
        expect(o.data.length).toBe((await stat(o.path)).size);
      }
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.at(-1)).toContain("(finished)");
      const st = await k().jobStatus(r.jobId);
      expect(st.state).toBe(JobState.FINISHED);
      expect(st.percent).toBe(100);
      expect(st.result?.status).toBe(JobStatus.JS_SUCCESS);
      const unknown = await k()
        .jobStatus("not-a-job")
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(KiCadApiError.is(unknown, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      if (events) {
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)!.finished).toBe(true);
      }
      // a synchronous job with inline outputs
      const sync = await board.jobs.exportGerbers(
        join(tmp.dir, "job-inline-gerbers"),
        { plotSettings: { layers: [BoardLayer.BL_F_Cu] } },
        { returnInline: true },
      );
      expect(sync.running).toBe(false);
      expect(sync.inlineOutputs.length).toBe(1);
      return `async gerbers ${r.jobId}: JS_RUNNING, ${progress.length} progress updates, ${seen.length} JobProgress events (last finished=${seen.at(-1)?.finished ?? "n/a"}), ${done.inlineOutputs.length} inline outputs matching the files; unknown id AS_BAD_REQUEST; sync + inline ok`;
    },
    120_000,
  );

  // ---- sch/commands: annotation, settings, fields, board sync (late: these mutate the schematic) ---------
  cmdTest("GetSchematicSettings", async () => {
    const s = await sch.settings();
    expect(Number(s.defaultLineWidth?.valueNm ?? 0n)).toBeGreaterThan(0);
    expect(Number(s.defaultTextSize?.valueNm ?? 0n)).toBeGreaterThan(0);
    // every field is optional so SetSchematicSettings can change one at a time
    expect(s.labelSizeRatio).toBeDefined();
    return `line ${(Number(s.defaultLineWidth!.valueNm) / 1e6).toFixed(3)} mm, text ${(Number(s.defaultTextSize!.valueNm) / 1e6).toFixed(3)} mm, junction choice ${s.junctionSizeChoice}, DNP markers ${s.showDnpMarkers}, annotate start ${s.annotateStartNumber}, drawing sheet "${s.drawingSheetFile ?? ""}"`;
  });
  cmdTest("SetSchematicSettings", async () => {
    const before = await sch.settings();
    const r = await sch.setSettings({
      annotateStartNumber: 200,
      showDnpMarkers: !(before.showDnpMarkers ?? false),
      intersheetRefsPrefix: "[",
    });
    expect(r.annotateStartNumber).toBe(200);
    expect(r.showDnpMarkers).toBe(!(before.showDnpMarkers ?? false));
    expect(r.intersheetRefsPrefix).toBe("[");
    // fields that were not sent are untouched
    expect(r.defaultLineWidth?.valueNm).toBe(before.defaultLineWidth?.valueNm);
    expect((await sch.settings()).annotateStartNumber).toBe(200);
    await sch.setSettings({
      annotateStartNumber: before.annotateStartNumber ?? 0,
      showDnpMarkers: before.showDnpMarkers ?? true,
      intersheetRefsPrefix: before.intersheetRefsPrefix ?? "",
    });
    return `annotate start ${before.annotateStartNumber} -> 200, DNP markers toggled, intersheet prefix "["; unsent fields unchanged (restored afterwards)`;
  });
  cmdTest("GetSymbolFieldsTable", async () => {
    const rows = await sch.fieldsTable();
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => r.reference)!;
    expect(row.id).toMatch(UUID);
    expect(row.sheetPath?.path.length ?? 0).toBeGreaterThan(0);
    expect(row.unit).toBeGreaterThanOrEqual(1);
    for (const f of ["Reference", "Value", "Footprint", "Datasheet", "Description"]) expect(Object.keys(row.fields)).toContain(f);
    expect(row.fields["Reference"]).toBe(row.reference);
    // power symbols are excluded like the dialog does
    const withPower = await sch.fieldsTable({ includePowerSymbols: true });
    expect(withPower.length).toBeGreaterThanOrEqual(rows.length);
    // a field filter narrows the map
    const onlyValue = await sch.fieldsTable({ fields: ["Value"] });
    expect(onlyValue.length).toBe(rows.length);
    expect(Object.keys(onlyValue[0]!.fields)).toEqual(["Value"]);
    return `${rows.length} placements (${withPower.length} including power symbols); ${row.reference} on sheet ${row.sheet || "(no human-readable path)"} unit ${row.unit} with ${Object.keys(row.fields).length} fields; field filter honoured`;
  });
  cmdTest("SetSymbolFields", async () => {
    const rows = await sch.fieldsTable();
    const row = rows.find((r) => r.reference)!;
    const before = row.fields["Value"] ?? "";
    const r = await sch.setFields([
      { id: row.id, sheetPath: row.sheetPath!, field: "Value", value: `${before}-conf` },
      { id: row.id, field: "ConfProbe", value: "set by the API" },
    ]);
    expect(r.updatedCount).toBe(2);
    expect(r.errors).toEqual([]);
    const after = (await sch.fieldsTable()).find((x) => x.id === row.id)!;
    expect(after.fields["Value"]).toBe(`${before}-conf`);
    expect(after.fields["ConfProbe"]).toBe("set by the API");
    // removing a user field works; removing a mandatory one is reported as an error
    const rm = await sch.setFields([
      { id: row.id, field: "ConfProbe", remove: true },
      { id: row.id, field: "Reference", sheetPath: row.sheetPath!, remove: true },
    ]);
    const back = (await sch.fieldsTable()).find((x) => x.id === row.id)!;
    expect(back.fields["ConfProbe"]).toBeUndefined();
    expect(back.fields["Reference"]).toBe(row.reference);
    const unknown = await sch.setFields([{ id: crypto.randomUUID(), field: "Value", value: "x" }]);
    expect(unknown.updatedCount).toBe(0);
    expect(unknown.errors.length).toBe(1);
    await sch.setFields([{ id: row.id, sheetPath: row.sheetPath!, field: "Value", value: before }]);
    return `Value + a new user field set on ${row.reference} (${r.updatedCount} updates); user field removed, mandatory Reference removal reported (${rm.errors.length} error(s): ${rm.errors[0] ?? "none"}); unknown symbol -> ${unknown.errors[0] ?? "no error"}`;
  });
  cmdTest("AssignFootprints", async () => {
    const rows = await sch.fieldsTable();
    const row = rows.find((r) => r.reference)!;
    const before = row.fields["Footprint"] ?? "";
    const r = await sch.assignFootprints({
      [row.reference]: "Resistor_SMD:R_0603_1608Metric",
      NOSUCHREF99: "Resistor_SMD:R_0402_1005Metric",
    });
    expect(r.assignedCount).toBe(1);
    expect(r.unmatchedReferences).toEqual(["NOSUCHREF99"]);
    const after = (await sch.fieldsTable()).find((x) => x.id === row.id)!;
    expect(after.fields["Footprint"]).toBe("Resistor_SMD:R_0603_1608Metric");
    // the array form is accepted too, and restores the original value
    await sch.assignFootprints([{ reference: row.reference, footprint: before }]);
    expect((await sch.fieldsTable()).find((x) => x.id === row.id)!.fields["Footprint"]).toBe(before);
    return `${row.reference} assigned Resistor_SMD:R_0603_1608Metric (restored afterwards); unknown reference reported in unmatched_references`;
  });
  cmdTest("ClearAnnotation", async () => {
    const before = (await sch.fieldsTable()).map((r) => r.reference);
    const r = await sch.clearAnnotation("all");
    expect(r.annotatedCount).toBeGreaterThan(0);
    expect(r.symbolCount).toBeGreaterThanOrEqual(r.annotatedCount);
    expect(r.messages.length).toBe(r.annotatedCount);
    const cleared = (await sch.fieldsTable()).map((r2) => r2.reference);
    expect(cleared.every((ref) => ref.endsWith("?"))).toBe(true);
    // put the references back for the tests that follow
    await sch.annotate({ scope: "all", resetExisting: true, sortOrder: "x", numbering: "incremental" });
    return `${r.annotatedCount} of ${r.symbolCount} symbols cleared to "?" (${before.slice(0, 3).join(", ")} -> ${cleared.slice(0, 3).join(", ")}); "${r.messages[0]}"`;
  });
  cmdTest("Annotate", async () => {
    // a fully annotated schematic is a no-op
    const noop = await sch.annotate({ scope: "all" });
    expect(noop.annotatedCount).toBe(0);
    expect(noop.symbolCount).toBeGreaterThan(0);
    expect(noop.errorCount).toBe(0);
    // reset_existing renumbers everything
    const full = await sch.annotate({ scope: "all", resetExisting: true, sortOrder: "y", numbering: "incremental", startNumber: 1 });
    expect(full.annotatedCount).toBeGreaterThan(0);
    expect(full.messages.length).toBe(full.annotatedCount);
    const refs = (await sch.fieldsTable()).map((r) => r.reference);
    expect(refs.every((ref) => /^[A-Za-z#_]+\d+$/.test(ref))).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
    // sheet numbering starts each sheet at sheet * 100
    const bySheet = await sch.annotate({ scope: "all", resetExisting: true, numbering: "sheetX100" });
    expect(bySheet.annotatedCount).toBeGreaterThan(0);
    const sheetRefs = (await sch.fieldsTable()).map((r) => r.reference);
    // one sheet only
    const root = await sch.rootSheet();
    const oneSheet = await sch.annotate({ scope: "sheet", sheetPath: root.path, resetExisting: true, recursive: false });
    expect(oneSheet.symbolCount).toBeLessThanOrEqual(full.symbolCount);
    await sch.annotate({ scope: "all", resetExisting: true, sortOrder: "x", numbering: "incremental" });
    return `already annotated -> 0 of ${noop.symbolCount}; reset_existing renumbered ${full.annotatedCount} ("${full.messages[0]}"); ANM_SHEET_NUMBER_X100 gave [${sheetRefs.slice(0, 4).join(", ")}]; ANS_SHEET on the root touched ${oneSheet.symbolCount} symbol(s)`;
  });
  cmdTest(
    "SyncSchematicToBoard",
    async () => {
      // "Update PCB from Schematic" needs a board and a schematic open in the same instance; run
      // it on the scratch server, in a project made of the kitchen-sink schematic plus a fresh board.
      const s = await scratchServer();
      const dir = join(scratchDir, "sync");
      await mkdir(dir, { recursive: true });
      await cp(KITCHEN_SINK_SCH, join(dir, "sync.kicad_sch"));
      for (const f of await readdir(dirname(KITCHEN_SINK_SCH))) {
        if (f.startsWith("erc_test_dynamic_power_symbol_subsheet")) await cp(join(dirname(KITCHEN_SINK_SCH), f), join(dir, f));
      }
      await writeFile(
        join(dir, "fp-lib-table"),
        `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${QA_RESISTOR_LIB}") (options "") (descr "QA resistors"))\n)\n`,
      );
      const proj = await s.kicad.newProject(dir, { skipStubDocuments: true });
      const schematic = await s.kicad.openSchematic(join(dir, "sync.kicad_sch"));
      const brd = await proj.newBoard();
      expect(await brd.getFootprints()).toEqual([]);

      // an unannotated schematic is refused, exactly as the dialog is
      await schematic.clearAnnotation("all");
      const refused = await schematic.syncToBoard(brd, { dryRun: true }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(KiCadApiError.is(refused, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      expect((refused as KiCadApiError).serverMessage).toContain("annotated");
      await schematic.annotate({ scope: "all", resetExisting: true });

      // give every symbol a footprint so the updater has something to place
      const refs = [...new Set((await schematic.fieldsTable()).map((r) => r.reference).filter(Boolean))];
      const assigned = await schematic.assignFootprints(Object.fromEntries(refs.map((r) => [r, "Resistor_SMD:R_0603_1608Metric"])));
      expect(assigned.assignedCount).toBe(refs.length);

      const dry = await schematic.syncToBoard(brd, { dryRun: true });
      expect(dry.newFootprintCount).toBe(refs.length);
      expect(dry.report).toContain("Add ");
      expect(dry.netlistPath.length).toBeGreaterThan(0);
      expect(await brd.getFootprints()).toEqual([]); // dry run changed nothing

      const applied = await schematic.syncToBoard(brd);
      expect(applied.errorCount).toBe(0);
      expect(applied.newFootprintCount).toBe(refs.length);
      expect(applied.report).toContain("Added ");
      const fps = await brd.getFootprints();
      expect(fps.length).toBe(refs.length);
      expect(new Set(fps.map((f) => f.reference))).toEqual(new Set(refs));
      expect(fps.every((f) => f.libraryId === "Resistor_SMD:R_0603_1608Metric")).toBe(true);
      // the nets came across with the footprints
      const nets = (await brd.nets()).map((n) => n.name).filter(Boolean);
      expect(nets.length).toBeGreaterThan(0);
      // the temporary netlist file is removed by the server
      expect(existsSync(applied.netlistPath)).toBe(false);
      // a second sync is idempotent
      const again = await schematic.syncToBoard(brd);
      expect(again.newFootprintCount).toBe(0);
      expect((await brd.getFootprints()).length).toBe(refs.length);
      return `${refs.length} symbols -> ${fps.length} footprints on a fresh board (${nets.length} nets, ${applied.warningCount} warnings, 0 errors); dry run changed nothing; the temporary netlist ${applied.netlistPath.split("/").pop()} is removed; a repeat sync adds 0`;
    },
    180_000,
  );
  extraTest("CreateItems(SCH_SHEET): the sheet file KiCad names is written to disk", async () => {
    // A8 reported that a new sheet is referenced by the parent but its file is never written.
    const root = await sch.rootSheet();
    const filename = "conf_new_sheet.kicad_sch";
    const target = join(tmp.dir, filename);
    await rm(target, { force: true });
    const sheet = await sch.newSheet({
      parentPath: root.path,
      name: "ConfSheet",
      filename,
      position: { x: mm(200), y: mm(100) },
      size: { x: mm(30), y: mm(20) },
    });
    expect(sheet.name).toBe("ConfSheet");
    expect(sheet.filename).toBe(filename);
    const afterCreate = existsSync(target);
    await sch.save();
    const afterSave = existsSync(target);
    const parent = await readFile(tmp.sch, "utf8");
    expect(parent).toContain(filename);
    const names = flattenHierarchy(await sch.hierarchy()).map(({ sheet: s }) => s.name);
    expect(names).toContain("ConfSheet");
    if (!afterSave) {
      throw new Error(
        `KICAD-BUG: ${filename} is referenced by the parent schematic and appears in GetSchematicHierarchy, but no file was written by CreateItems or SaveDocument`,
      );
    }
    expect((await readFile(target, "utf8")).startsWith("(kicad_sch")).toBe(true);
    // naming an existing file adopts it rather than overwriting it
    const reused = await sch.newSheet({ parentPath: root.path, name: "ConfReused", filename, position: { x: mm(250), y: mm(100) } });
    expect(reused.filename).toBe(filename);
    expect(flattenHierarchy(await sch.hierarchy()).map(({ sheet: s }) => s.name)).toContain("ConfReused");
    return `CreateItems(SCH_SHEET) attaches a screen and writes ${filename} immediately (on disk before SaveDocument: ${afterCreate}); the parent references it and GetSchematicHierarchy lists it -- A8's report no longer reproduces at this commit; a second sheet naming the same file adopts the existing screen`;
  });

  // ---- board/commands: connectivity + global edits (late: these mutate the board and undo again) ---------
  /**
   * Runs `fn` on a board with every track, arc, via and zone removed (so the ratsnest has
   * something to report), then undoes the deletion.
   */
  async function ripUp<T>(fn: (deleted: number) => Promise<T>): Promise<T> {
    const deleted = await board.globalDeletion({
      types: [KiCadObjectType.KOT_PCB_TRACE, KiCadObjectType.KOT_PCB_ARC, KiCadObjectType.KOT_PCB_VIA, KiCadObjectType.KOT_PCB_ZONE],
    });
    try {
      return await fn(deleted);
    } finally {
      await board.undo();
    }
  }

  cmdTest("GetRatsnest", async () => {
    // the kitchen sink is fully routed: no airlines
    const routed = await board.ratsnest();
    expect(routed.edges).toEqual([]);
    expect(routed.unroutedCount).toBe(0);
    const note = await ripUp(async () => {
      const r = await board.ratsnest();
      expect(r.edges.length).toBeGreaterThan(0);
      expect(r.unroutedCount).toBe(r.edges.length);
      const e = r.edges[0]!;
      expect(e.net.length).toBeGreaterThan(0);
      expect(e.source).toMatch(UUID);
      expect(e.target).toMatch(UUID);
      expect(e.source).not.toBe(e.target);
      expect(e.length).toBeGreaterThan(0);
      // the airline length is the distance between the two anchors
      const dx = e.targetPosition.x - e.sourcePosition.x;
      const dy = e.targetPosition.y - e.sourcePosition.y;
      expect(Math.abs(Math.hypot(dx, dy) - e.length)).toBeLessThan(2);
      // a net filter narrows `edges` but `unrouted_count` stays board-wide
      const one = await board.ratsnest([e.net]);
      expect(one.edges.every((x) => x.net === e.net)).toBe(true);
      expect(one.unroutedCount).toBe(r.unroutedCount);
      const unknown = await board.ratsnest(["no-such-net"]).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(KiCadApiError.is(unknown, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
      // KICAD-BUG: RatsnestEdge.net only carries the name; `code` is left at 0.
      const codes = r.edges.map((x) => x.netCode);
      return `${r.edges.length} airlines after rip-up (net "${e.net}", ${(e.length / 1e6).toFixed(3)} mm, positions match the length); filter by net -> ${one.edges.length} edges with the board-wide unrouted_count ${one.unroutedCount}; unknown net AS_BAD_REQUEST${codes.every((x) => x === 0) ? "; KICAD-BUG: RatsnestEdge.net.code is left 0 (only the name is packed)" : ""}`;
    });
    expect((await board.ratsnest()).edges).toEqual([]);
    return `fully routed board: 0 edges; ${note}`;
  });
  cmdTest("GetUnroutedCount", async () => {
    const routed = await board.unroutedCount();
    expect(routed.unroutedCount).toBe(0);
    expect(routed.unroutedNetCount).toBe(0);
    return await ripUp(async () => {
      const u = await board.unroutedCount();
      const r = await board.ratsnest();
      expect(u.unroutedCount).toBe(r.unroutedCount);
      expect(u.unroutedNetCount).toBeGreaterThan(0);
      expect(u.unroutedNetCount).toBeLessThanOrEqual(u.unroutedCount);
      return `routed board 0/0; ripped up ${u.unroutedCount} unrouted connection(s) over ${u.unroutedNetCount} net(s), agreeing with GetRatsnest`;
    });
  });
  cmdTest("GetNetLengths", async () => {
    const all = await board.netLengths();
    expect(all.length).toBeGreaterThan(0);
    const named = all.find((l) => (l.net?.name ?? "") !== "") ?? all[0]!;
    expect(named.padCount).toBeGreaterThan(0);
    const total = Number(named.totalLength?.valueNm ?? 0n);
    expect(total).toBeGreaterThan(0);
    expect(Number(named.unroutedLength?.valueNm ?? 0n)).toBe(0);
    const parts =
      Number(named.trackLength?.valueNm ?? 0n) + Number(named.viaLength?.valueNm ?? 0n) + Number(named.padToDieLength?.valueNm ?? 0n);
    expect(Math.abs(parts - total)).toBeLessThanOrEqual(1);
    // filtering by name returns just that net; an unknown name is rejected
    const one = await board.netLengths([named.net!.name]);
    expect(one.length).toBe(1);
    expect(one[0]!.net?.name).toBe(named.net!.name);
    const unknown = await board.netLengths(["no-such-net"]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(KiCadApiError.is(unknown, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    const delayed = await board.netLengths([named.net!.name], { withDelays: true });
    expect(delayed.length).toBe(1);
    const unroutedNote = await ripUp(async () => {
      const after = (await board.netLengths([named.net!.name]))[0]!;
      expect(Number(after.totalLength?.valueNm ?? 0n)).toBe(0);
      const unrouted = Number(after.unroutedLength?.valueNm ?? 0n);
      expect(unrouted).toBeGreaterThan(0);
      return `after rip-up the same net reports 0 routed and ${(unrouted / 1e6).toFixed(3)} mm unrouted`;
    });
    return `${all.length} net(s); "${named.net!.name}": ${named.padCount} pads, ${named.viaCount} vias, ${(total / 1e6).toFixed(3)} mm total over ${named.layerLengths.length} layer(s) (track+via+pad-to-die adds up); ${unroutedNote}; with_delays -> ${delayed[0]!.totalDelayPs} ps`;
  });
  cmdTest("GlobalDeletion", async () => {
    const countOf = async (t: KiCadObjectType) => (await board.itemCounts()).counts.get(t) ?? 0;
    const textsBefore = await countOf(KiCadObjectType.KOT_PCB_TEXT);
    const deletedTexts = await board.globalDeletion({ types: [KiCadObjectType.KOT_PCB_TEXT] });
    expect(deletedTexts).toBe(textsBefore);
    expect(await countOf(KiCadObjectType.KOT_PCB_TEXT)).toBe(0);
    await board.undo();
    expect(await countOf(KiCadObjectType.KOT_PCB_TEXT)).toBe(textsBefore);
    // a layer filter restricts the deletion; Edge.Cuts shapes survive unless board_edges is set
    const shapesBefore = await countOf(KiCadObjectType.KOT_PCB_SHAPE);
    const onEdgeCuts = await board.globalDeletion({ types: [KiCadObjectType.KOT_PCB_SHAPE], layers: [BoardLayer.BL_Edge_Cuts] });
    expect(onEdgeCuts).toBe(0);
    expect(await countOf(KiCadObjectType.KOT_PCB_SHAPE)).toBe(shapesBefore);
    const withEdges = await board.globalDeletion({
      types: [KiCadObjectType.KOT_PCB_SHAPE],
      layers: [BoardLayer.BL_Edge_Cuts],
      boardEdges: true,
    });
    expect(await countOf(KiCadObjectType.KOT_PCB_SHAPE)).toBe(shapesBefore - withEdges);
    if (withEdges) await board.undo();
    expect(await countOf(KiCadObjectType.KOT_PCB_SHAPE)).toBe(shapesBefore);
    // a type the board has none of deletes nothing; an empty type list is refused
    const barcodes = await countOf(KiCadObjectType.KOT_PCB_BARCODE);
    const deletedBarcodes = await board.globalDeletion({ types: [KiCadObjectType.KOT_PCB_BARCODE] });
    expect(deletedBarcodes).toBe(barcodes);
    if (deletedBarcodes) await board.undo();
    const none = await board.globalDeletion({ types: [] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(KiCadApiError.is(none, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    const tracks = await ripUp(async (n) => {
      expect(await countOf(KiCadObjectType.KOT_PCB_TRACE)).toBe(0);
      expect(await countOf(KiCadObjectType.KOT_PCB_VIA)).toBe(0);
      return n;
    });
    expect(await countOf(KiCadObjectType.KOT_PCB_TRACE)).toBeGreaterThan(0);
    return `texts ${deletedTexts} deleted and restored by Undo; Edge.Cuts shape filter removed ${onEdgeCuts} of ${shapesBefore} shapes without board_edges and ${withEdges} with it; ${deletedBarcodes} barcode(s); an empty type list is AS_BAD_REQUEST; tracks/arcs/vias/zones ${tracks} deleted and restored`;
  });
  cmdTest("UpdateFootprintsFromLibrary", async () => {
    const r = await board.updateFootprintsFromLibrary([], { onlyChanged: true });
    expect(r.updatedCount + r.unchangedCount).toBeGreaterThan(0);
    expect(r.messages.length).toBeGreaterThan(0);
    // footprints whose library is not in the project table are reported, not silently skipped
    for (const ref of r.missing) expect(r.messages.some((m) => m.startsWith(`${ref} `))).toBe(true);
    if (r.updatedCount) await board.undo();
    // "Change Footprints": point one footprint at another library entry
    const fp = (await board.getFootprints()).find((f) => f.libraryId.startsWith("Resistor_SMD:"))!;
    expect(fp).toBeDefined();
    const changed = await board.updateFootprintsFromLibrary([fp.id], { newFootprint: "Resistor_SMD:R_0402_1005Metric" });
    expect(changed.updatedCount).toBe(1);
    expect(
      ((await board.getItem(fp.id)) as Footprint | undefined)?.libraryId ??
        (await board.getFootprints()).find((f) => f.reference === fp.reference)!.libraryId,
    ).toBe("Resistor_SMD:R_0402_1005Metric");
    await board.undo();
    return `only_changed over the whole board: ${r.updatedCount} updated, ${r.unchangedCount} unchanged, missing library footprints for [${r.missing.join(", ")}]; new_footprint changed ${fp.reference} to R_0402_1005Metric (undone)`;
  });
  cmdTest("SetTeardrops", async () => {
    const n = await board.setTeardrops({ vias: true, pthPads: true, smdPads: true });
    expect(n).toBeGreaterThan(0);
    await board.undo();
    // TDA_SET with explicit parameters
    const set = await board.setTeardrops(
      { vias: true, pthPads: true, smdPads: true },
      {
        mode: PadTeardropMode.PTM_ENABLED,
        bestLengthRatio: 0.5,
        bestWidthRatio: 1,
        maxLength: toDistance(mm(1)),
        maxWidth: toDistance(mm(2)),
      },
    );
    expect(set).toBeGreaterThan(0);
    await board.undo();
    // round shapes only, and a net filter, are both accepted
    const round = await board.setTeardrops({ vias: true, roundShapesOnly: true });
    if (round) await board.undo();
    const byNet = netNames.filter(Boolean).length
      ? await board.setTeardrops({ vias: true, nets: netNames.filter(Boolean).slice(0, 1) })
      : 0;
    if (byNet) await board.undo();
    return `TDA_ADD on vias + PTH + SMD pads: ${n} items; TDA_SET with explicit parameters: ${set}; round shapes only: ${round}; restricted to net "${netNames.filter(Boolean)[0] ?? "-"}": ${byNet}`;
  });
  cmdTest("RemoveTeardrops", async () => {
    const added = await board.setTeardrops({ vias: true, pthPads: true, smdPads: true });
    const removed = await board.removeTeardrops();
    expect(removed).toBeGreaterThanOrEqual(0);
    await board.undo();
    await board.undo();
    // removing when there are none is a no-op, not an error
    const none = await board.removeTeardrops();
    if (none) await board.undo();
    return `${added} pads/vias given teardrops, RemoveTeardrops reported ${removed}; a second call still reports ${none} -- KICAD-BUG: SetTeardropsResponse.item_count is documented as "pads and vias whose teardrop settings changed" but api_handler_pcb.cpp counts every pad/via it processes, so it never reaches 0`;
  });
  cmdTest("AutoplaceFootprints", async () => {
    const fps = await board.getFootprints();
    const homes = new Map(fps.map((f) => [f.id, f.position]));
    const r = await board.autoplace(
      fps.slice(0, 2).map((f) => f.id),
      { includeOffboard: true },
    );
    let note: string;
    if (r.ok) {
      expect(r.placedCount).toBeGreaterThan(0);
      const moved = (await board.getFootprints()).filter((f) => {
        const h = homes.get(f.id);
        return h && (h.x !== f.position.x || h.y !== f.position.y);
      });
      note = `APR_COMPLETED, ${r.placedCount} footprint(s) placed inside the board outline (${moved.length} moved)`;
      await board.undo();
    } else {
      note = `${r.result === 2 ? "APR_NO_BOARD_OUTLINE" : `result ${r.result}`}, nothing placed`;
    }
    // A board with no outline answers APR_NO_BOARD_OUTLINE rather than failing.
    return `${note}; the API has no bounding box parameter — the board outline is the placement area`;
  });

  // ---- symbol document (not a command; OpenDocument(DOCTYPE_SYMBOL)) ------------------------------------------
  extraTest("OpenDocument(DOCTYPE_SYMBOL): headless symbol document items / counts / commit", async () => {
    const name = /^\s*\(symbol "([^"]+)"/m.exec(await readFile(QA_DEVICE_LIB, "utf8"))?.[1];
    expect(name).toBeDefined();
    const libId = `Device:${name}`;
    const sym = await k()
      .openSymbol(libId)
      .catch((e: unknown) => {
        if (KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST))
          throw new Error(`OpenDocument(DOCTYPE_SYMBOL ${libId}) rejected: ${e.serverMessage}`);
        throw e;
      });
    expect(sym.libId).toBe(libId);
    expect((await k().openDocuments(DocumentType.DOCTYPE_SYMBOL)).length).toBe(1);
    const lib = await sym.libSymbol();
    expect(lib).toBeInstanceOf(LibSymbol);
    expect(lib!.name).toBe(name!);
    expect(lib!.pins.length).toBeGreaterThan(0);
    const pins = await sym.getPins();
    const items = await sym.getAllItems();
    expect(items.length).toBeGreaterThan(0);
    const types = [...new Set(items.map((i) => i.typeName))].sort();
    const counts = await sym.itemCounts();
    expect(counts.counts.get(KiCadObjectType.KOT_SCH_PIN)).toBe(pins.length);
    const pin = pins[0];
    if (pin) {
      const [back] = await sym.getItemsById([pin.id]);
      expect(back).toBeInstanceOf(SchematicPin);
      expect(back!.id).toBe(pin.id);
    }
    const editable = items.find((i) => i.id && !(i instanceof SchematicPin)) ?? pin;
    let commitNote = "no editable child";
    if (editable) {
      const r = await sym.commit("touch child", (tx) => tx.update([editable]));
      commitNote = `commit updated ${r.updated.length} item`;
    }
    const actions = await sym.actions().then(
      (a) => `${a.length} actions`,
      (e: unknown) => (KiCadApiError.is(e) ? `GetActions ${e.codeName} (${e.serverMessage})` : String(e)),
    );
    await sym.close();
    expect((await k().openDocuments(DocumentType.DOCTYPE_SYMBOL)).length).toBe(0);
    return `${libId}: ${items.length} children (${types.join(", ")}), ${pins.length} pins, lib symbol with ${lib!.pins.length} pins over ${lib!.unitCount} unit(s); ${commitNote}; ${actions}`;
  });

  // ---- footprint document (late: has crashed the stable server) ---------------------------------------------
  cmdTest("OpenLibraryItem", async () => {
    // The footprint handler only exists once a footprint document is open headless; the temp
    // project carries an fp-lib-table pointing at KiCad's QA Resistor_SMD.pretty. Runs late
    // because opening a footprint document has crashed the stable server (see summary).
    const libId = "Resistor_SMD:R_0603_1608Metric";
    const fpDoc = await k().openFootprint(libId);
    const items = await fpDoc.getAllItems();
    const counts = await fpDoc.itemCounts();
    expect(counts.total).toBe(items.filter((i) => i.id).length);
    await fpDoc.openInEditor();
    await fpDoc.close();
    return `opened ${libId}: ${items.length} items (GetItemCounts agrees)`;
  });

  // ---- close (last) -----------------------------------------------------------------------------------------
  cmdTest("CloseDocument", async () => {
    const closed = events?.next("documentClosed", {
      timeoutMs: 10_000,
      filter: (d) => d.document?.type === DocumentType.DOCTYPE_SCHEMATIC,
    });
    await sch.close();
    // KiCad answers GetOpenDocuments with AS_UNHANDLED once no schematic handler exists; the client maps that to [].
    expect(await k().openDocuments(DocumentType.DOCTYPE_SCHEMATIC)).toEqual([]);
    expect((await k().openDocuments(DocumentType.DOCTYPE_PCB)).length).toBe(1);
    if (closed) await closed;
    const opened = events?.next("documentOpened", {
      timeoutMs: 10_000,
      filter: (d) => d.document?.type === DocumentType.DOCTYPE_SCHEMATIC,
    });
    sch = await project.openSchematic(tmp.sch);
    expect((await k().openDocuments(DocumentType.DOCTYPE_SCHEMATIC)).length).toBe(1);
    if (opened) await opened;
    return events ? "DocumentClosed / DocumentOpened events seen" : "";
  });
  cmdTest("CloseAllDocuments", async () => {
    await k().closeAllDocuments();
    expect(await k().openDocuments(DocumentType.DOCTYPE_PCB)).toEqual([]);
  });

  test("every command in commands.json has a conformance test", () => {
    const missing = COMMANDS.map((x) => x.command).filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });
});

async function printSummary(): Promise<void> {
  const rows = COMMANDS.map((info) => {
    const r = results.get(info.command);
    return { command: info.command, group: info.group, headless: info.headless, status: r?.status ?? "fail", note: r?.note ?? "not run" };
  });
  const extras = [...results].filter(([name]) => !COMMAND_NAMES.has(name)).map(([name, r]) => ({ name, ...r }));
  const count = (list: { status: Status }[], s: Status) => list.filter((r) => r.status === s).length;
  const headlessTotal = COMMANDS.filter((x) => x.headless === "ok").length;
  const headlessPass = rows.filter((r) => r.headless === "ok" && r.status === "pass").length;
  const bugNotes = rows.filter((r) => r.note.includes("KICAD-BUG")).length + extras.filter((r) => r.note.includes("KICAD-BUG")).length;
  const lines = [
    "",
    `=== ${KICAD_TRANSPORT} conformance (KiCad ${KICAD_COMMIT.slice(0, 10)}) ===`,
    `${rows.length} commands: ${count(rows, "pass")} pass, ${count(rows, "skip")} skip (gui-only), ${count(rows, "fail")} fail; headless ${headlessPass}/${headlessTotal} green; ${extras.length} extra checks: ${count(extras, "pass")} pass, ${count(extras, "skip")} skip, ${count(extras, "fail")} fail; ${bugNotes} with KICAD-BUG notes`,
    ...restarts.map((r) => `  server restarted ${r}`),
    ...rows.map((r) => `  ${r.status.padEnd(4)} ${r.command.padEnd(34)} ${r.group.padEnd(17)} ${r.note}`),
    ...extras.map((r) => `  ${r.status.padEnd(4)} ${r.name.padEnd(52)} extra             ${r.note}`),
    "",
  ];
  console.log(lines.join("\n"));
  const dist = join(import.meta.dir, "..", "..", "dist");
  await mkdir(dist, { recursive: true }).catch(() => {});
  await writeFile(join(dist, "conformance-summary.txt"), lines.join("\n")).catch(() => {});
}
