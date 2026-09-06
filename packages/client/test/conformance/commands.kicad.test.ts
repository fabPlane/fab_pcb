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
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiStatusCode,
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
  PadstackPresence,
  PageSize,
  ProjectFileType,
  RenderFormat,
  RuleSeverity,
  RunActionStatus,
  SchematicNetlistFormat,
  StatsOutputFormat,
  type DrcResultsResponse,
  type ErcResultsResponse,
  type JobProgress,
  type KIID,
} from "@kicad-web/proto";
import { COMMANDS, KICAD_COMMIT } from "../../src/commands-data";
import * as cmd from "../../src/commands";
import { ActionError, KiCadApiError } from "../../src/errors";
import { KiCadEvents } from "../../src/events";
import {
  Board,
  Footprint,
  KiCad,
  LibSymbol,
  Project,
  Schematic,
  SchematicPin,
  SchematicSymbol,
  Track,
  activeMarkers,
  embeddedFileContent,
  type Pad,
} from "../../src/model";
import { NngIpcSubscriber, NngIpcTransport } from "../../src/transport";
import { mm, toDistance, toVector2 } from "../../src/units";
import { QA_DEVICE_LIB, QA_NETLIST, haveKicad, startKiCad, tempProject, type RunningKiCad, type TempProject } from "../kicad-server";

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
    if (info?.eventsSocketUrl) {
      events = new KiCadEvents(await NngIpcSubscriber.connect({ path: info.eventsSocketUrl }));
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
    scratchDir = await mkdtemp(join(tmpdir(), "kicad-web-scratch-"));
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
    const p = await k().pluginSettingsPath("com.example.kicad-web");
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
    expect(info.eventsSocketUrl).toMatch(/-events\.sock$/);
    expect(events?.state).toBe("open");
    return `events socket ${info.eventsSocketUrl} (subscribed)`;
  });
  cmdTest("GetTextExtents", async () => {
    const box = await k().textExtents({
      text: "kicad-web",
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
    await sch.erc.exclude([target], "kicad-web exclusion");
    const mid = await sch.erc.markers();
    const m = mid.markers.find((x) => x.id?.value === target.id!.value)!;
    expect(m.excluded).toBe(true);
    expect(m.exclusionComment).toBe("kicad-web exclusion");
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
      await board.drc.exclude([target], "kicad-web exclusion");
      const mid = await board.drc.markers();
      const m = mid.markers.find((x) => x.id?.value === target.id!.value)!;
      expect(m.excluded).toBe(true);
      expect(m.exclusionComment).toBe("kicad-web exclusion");
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
      await doc.setTitleBlock({ ...orig, title: "kicad-web conformance" });
      expect((await doc.titleBlock()).title).toBe("kicad-web conformance");
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

  // ---- events + store (not commands) ------------------------------------------------------------------------
  extraTest("Events: DocumentChanged / DocumentSaved on the events socket", async () => {
    if (!events) throw new Error(`no events subscriber: ${eventsError}`);
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
    return `${events.received} events so far (last sequence ${events.lastSequence}, no gaps); track update -> updated=[track]; ${fpNote}; DocumentSaved carries the path`;
  });
  extraTest(
    "Store: DocumentSync.syncSince after another client's commit (since_revision)",
    async () => {
      const sync = board.documentSync;
      await sync.load(); // a fresh full load so the store's revision is current
      expect(sync.revision).toBeDefined();
      expect(await sync.supportsIncrementalSync()).toBe(true);
      const t2 = await NngIpcTransport.connect({ path: rt.server.socketPath, defaultTimeoutMs: 60_000 });
      try {
        const k2 = await KiCad.connect(t2, { clientName: "kicad-web/conf-second" });
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
    const res = await board.setCustomRules([...r.rules, { name: "kicad_web_rule", condition: "A.NetClass == 'HV'", constraints: [] }]);
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
    await board.addEmbeddedFiles([{ name: "kicad-web.txt", type: EmbeddedFileType.EFT_OTHER, data: new TextEncoder().encode("hello") }]);
    const files = await board.embeddedFiles();
    const mine = files.find((f) => f.name === "kicad-web.txt");
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
    const id = await board.injectDrcError("kicad-web injected", firstFp.position, {
      severity: DrcSeverity.DRS_WARNING,
      items: [firstFp.id],
    });
    expect(id).toMatch(UUID);
    const after = await board.drc.markers();
    const mine = after.markers.find((m) => m.id?.value === id);
    expect(mine).toBeDefined();
    expect(mine!.description).toContain("kicad-web injected");
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
  ) =>
    cmdTest(
      name,
      async () => {
        const out = join(tmp.dir, `job-${name}${ext}`);
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
  boardJob("RunBoardJobExport3D", (out) => board.jobs.export3D(out, { format: Board3DFormat.B3D_GLB, overwrite: true }), ".glb", 300_000);
  boardJob(
    "RunBoardJobExportRender",
    (out) => board.jobs.exportRender(out, { format: RenderFormat.RF_PNG, width: 320, height: 240 }),
    ".png",
    300_000,
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
    `=== IPC conformance (KiCad ${KICAD_COMMIT.slice(0, 10)}) ===`,
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
