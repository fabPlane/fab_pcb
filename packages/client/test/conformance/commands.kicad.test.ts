/**
 * Conformance suite: one test per command in tooling/coverage/commands.json against a real
 * `kicad-cli api-server` with the kitchen-sink board + schematic (copied into a temp project).
 * GUI-only commands are expected to answer AS_UNIMPLEMENTED / AS_UNHANDLED and are recorded as
 * skipped. A coverage summary is printed at the end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ApiStatusCode,
  BoardLayer,
  BoardOriginType,
  CrossProbeStatus,
  CustomRulesStatus,
  DocumentType,
  DrcSeverity,
  EmbeddedFileType,
  FrameType,
  JobStatus,
  KiCadObjectType,
  MapMergeMode,
  PadstackPresence,
  PageSize,
  ProjectFileType,
  SchematicNetlistFormat,
  DrillFormat,
  Board3DFormat,
  RenderFormat,
  StatsOutputFormat,
  BoardOriginType as _BOT,
} from "@kicad-web/proto";
import { COMMANDS, KICAD_COMMIT } from "../../src/commands-data";
import * as cmd from "../../src/commands";
import { KiCadApiError } from "../../src/errors";
import { Board, Footprint, Pad, Project, Schematic, SchematicSymbol, Track, Zone, embeddedFileContent, type Item } from "../../src/model";
import { mm, toDistance, toVector2 } from "../../src/units";
import { QA_NETLIST, haveKicad, startKiCad, tempProject, type RunningKiCad, type TempProject } from "../kicad-server";

type Status = "pass" | "fail" | "skip";
const results = new Map<string, { status: Status; note: string }>();
const covered = new Set<string>();

function record(name: string, status: Status, note = ""): void {
  results.set(name, { status, note });
}

const restarts: string[] = [];

/**
 * A crashed server (socket closed by peer) must not take the rest of the suite with it: before
 * each test the server is restarted and the documents reopened, and the crash is reported with
 * the server's stderr in the summary.
 */
async function ensureAlive(before: string): Promise<void> {
  if (rt.transport.state !== "closed" && !rt.server.crashed) return;
  const tail = rt.server.stderr().trim().split("\n").slice(-3).join(" | ");
  restarts.push(`before ${before}: server ${rt.server.crashed ? `exited with code ${rt.server.proc.exitCode} signal ${rt.server.proc.signalCode}` : "connection closed"}${tail ? ` -- stderr: ${tail}` : ""}`);
  await rt.stop().catch(() => {});
  await openAll();
}

async function openAll(): Promise<void> {
  rt = await startKiCad(null, "conf");
  project = await k().openProject(tmp.pro);
  board = await project.openBoard(tmp.pcb);
  sch = await project.openSchematic(tmp.sch);
  footprints = await board.getFootprints();
  firstFp = footprints[0]!;
  pads = await board.getPads();
  netNames = (await board.nets()).map((n) => n.name).filter(Boolean);
}

/** Registers a test for command `name`; the callback may return a note for the summary. */
function cmdTest(name: string, fn: () => Promise<string | void>, timeout = 60_000): void {
  covered.add(name);
  test(name, async () => {
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
  }, timeout);
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
 * A command added to the API after the stable server was built: `AS_UNHANDLED` / `AS_UNIMPLEMENTED`
 * is recorded as a skip with the reason; anything else runs the real assertions. The full exercise
 * of these commands against the development binary lives in newer.kicad.test.ts.
 */
function newerCmdTest(name: string, fn: () => Promise<string | void>): void {
  cmdTest(name, async () => {
    try {
      return await fn();
    } catch (e) {
      if (KiCadApiError.is(e) && e.isUnsupported) {
        record(name, "skip", `server predates the command (${e.codeName}); exercised in newer.kicad.test.ts against the dev binary`);
        return;
      }
      throw e;
    }
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

let rt: RunningKiCad;
let tmp: TempProject;
let project: Project;
let board: Board;
let sch: Schematic;
let footprints: Footprint[] = [];
let firstFp: Footprint;
let pads: Pad[] = [];
let netNames: string[] = [];
let createdTrackId = "";

const k = () => rt.kicad;
const c = () => rt.kicad.client;

describe.skipIf(!haveKicad())("conformance: every IPC command against kicad-cli api-server", () => {
  beforeAll(async () => {
    tmp = await tempProject();
    await openAll();
  }, 120_000);

  afterAll(async () => {
    await rt?.stop();
    await tmp?.cleanup();
    printSummary();
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
    const missingLocally = caps.commands().filter((x) => !x.info).map((x) => x.command);
    const missingOnServer = COMMANDS.filter((x) => x.headless !== "unregistered" && !caps.has(x.requestType)).map((x) => x.command);
    return `${caps.size} advertised; not in bundled table: [${missingLocally.join(", ")}]; bundled but not advertised: [${missingOnServer.join(", ")}]`;
  });
  newerCmdTest("GetServerInfo", async () => {
    const info = await cmd.getServerInfo(c(), {});
    expect(info.socketUrl).toContain(rt.server.socketPath);
    expect(info.kicadToken).toBe(c().kicadToken!);
    return `events socket: ${info.eventsSocketUrl || "(none)"}`;
  });
  cmdTest("GetTextExtents", async () => {
    const box = await k().textExtents({ text: "kicad-web", attributes: { size: toVector2({ x: mm(1), y: mm(1) }), strokeWidth: toDistance(mm(0.15)) } });
    expect(box.w).toBeGreaterThan(0);
    expect(box.h).toBeGreaterThan(0);
    return `${(box.w / 1e6).toFixed(2)} x ${(box.h / 1e6).toFixed(2)} mm`;
  });
  cmdTest("GetTextAsShapes", async () => {
    const shapes = await k().textAsShapes([{ text: { text: "A", attributes: { size: toVector2({ x: mm(1), y: mm(1) }), strokeWidth: toDistance(mm(0.15)) } } }]);
    expect(shapes.length).toBe(1);
    expect(shapes[0]!.shapes?.shapes.length ?? 0).toBeGreaterThan(0);
    return `${shapes[0]!.shapes?.shapes.length} shapes`;
  });

  // ---- sch/jobs + sch/commands (first: SetNetClasses below deadlocks any later schematic job, see KICAD-BUG) ----
  // ---- sch/jobs ---------------------------------------------------------------------------------------------
  const schJob = (name: string, run: (out: string) => Promise<{ outputPaths: string[]; status: JobStatus }>, ext: string) =>
    cmdTest(name, async () => {
      const out = join(tmp.dir, `job-${name}${ext}`);
      const r = await run(out);
      const produced = [...r.outputPaths, out].filter((p) => existsSync(p));
      expect(produced.length).toBeGreaterThan(0);
      return `${JobStatus[r.status]}: ${produced.length} file(s)`;
    }, 120_000);
  schJob("RunSchematicJobExportSvg", (out) => sch.jobs.exportSvg(`${out}/`), "");
  schJob("RunSchematicJobExportDxf", (out) => sch.jobs.exportDxf(`${out}/`), "");
  schJob("RunSchematicJobExportPdf", (out) => sch.jobs.exportPdf(out), ".pdf");
  schJob("RunSchematicJobExportPs", (out) => sch.jobs.exportPs(`${out}/`), "");
  cmdTest("RunSchematicJobExportNetlist", async () => {
    // KICAD-BUG: on the stable build this job never answers (the server stays wedged, every later
    // request times out), so it runs against a throwaway server that is killed afterwards.
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
      if (/timed out/.test(msg)) record("RunSchematicJobExportNetlist", "fail", "KICAD-BUG: RunSchematicJobExportNetlist never answers headless and wedges the server (ran on a throwaway server, killed)");
      else if (/_cvpcb\.kiface/.test(msg)) record("RunSchematicJobExportNetlist", "fail", `KICAD-BUG: netlist export needs _cvpcb.kiface, which this build does not ship: ${msg.slice(0, 120)}`);
      throw e;
    } finally {
      await own.stop();
    }
  }, 120_000);
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
  newerCmdTest("GetProjectInfo", async () => {
    const info = await project.info();
    expect(info.kicadProPath).toBe(tmp.pro);
    const kinds = info.files.map((f) => `${ProjectFileType[f.kind]}${f.isOpen ? "*" : ""}`);
    expect(info.files.some((f) => f.kind === ProjectFileType.PFT_PCB && f.isOpen)).toBe(true);
    return kinds.join(", ");
  });
  newerCmdTest("NewProject", async () => {
    // open:false keeps the kitchen-sink project current; the full open/stub flow runs in newer.kicad.test.ts.
    const dir = join(tmp.dir, "newproj");
    const p = await k().newProject(dir, { open: false });
    expect(existsSync(join(dir, "newproj.kicad_pro"))).toBe(true);
    return `created ${p.name || "newproj"} (not opened)`;
  });
  newerCmdTest("NewDocument", async () => {
    // The kitchen-sink project already has its board: KiCad must refuse rather than overwrite.
    const err = await k().newDocument(DocumentType.DOCTYPE_PCB).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (KiCadApiError.is(err) && err.isUnsupported) throw err;
    expect(KiCadApiError.is(err, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    return "refuses to overwrite the existing board (AS_BAD_REQUEST); creation flow in newer.kicad.test.ts";
  });
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
  cmdTest("GetItems", async () => {
    expect(footprints.length).toBeGreaterThan(0);
    const all = await board.getAllItems();
    const syms = await sch.getSymbols();
    expect(syms.length).toBeGreaterThan(0);
    const schAll = await sch.getAllItems();
    return `board: ${all.length} items / ${footprints.length} footprints / ${pads.length} pads; schematic: ${schAll.length} items / ${syms.length} symbols`;
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
    if (r1 === undefined) {
      record("GetDocumentRevision", "skip", "not supported by this server");
      return;
    }
    await board.commit("bump", async (tx) => {
      const fp = (await board.getItemsById([firstFp.id]))[0]!;
      await tx.update([fp]);
    });
    const r2 = await board.revision();
    expect(r2!).toBeGreaterThan(r1);
    return `${r1} -> ${r2}`;
  });
  cmdTest("BeginCommit", async () => {
    const tx = await board.beginCommit();
    expect(tx.id).toMatch(/^[0-9a-f-]{36}$/);
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
    return `${text.length} chars`;
  });
  cmdTest("SaveItemsToString", async () => {
    const text = await board.saveItemsToString([firstFp.id]);
    expect(text).toContain("(footprint");
    return `${text.length} chars`;
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
    const items = await board.parseAndCreate("(kicad_pcb)");
    record("ParseAndCreateItemsFromString", "pass", `answers AS_OK but is a stub in KiCad (returned ${items.length} items)`);
  });
  cmdTest("RefreshEditor", async () => {
    await board.refreshEditor();
    await sch.refreshEditor();
    await cmd.refreshEditor(c(), { frame: FrameType.FT_UNKNOWN });
  });
  guiOnlyTest("GetSelection", () => cmd.getSelection(c(), { header: board.header() }));
  guiOnlyTest("AddToSelection", () => cmd.addToSelection(c(), { header: board.header(), items: [{ value: firstFp.id }] }));
  guiOnlyTest("RemoveFromSelection", () => cmd.removeFromSelection(c(), { header: board.header(), items: [{ value: firstFp.id }] }));
  guiOnlyTest("ClearSelection", () => cmd.clearSelection(c(), { header: board.header() }));
  guiOnlyTest("RevertDocument", () => board.revert());
  guiOnlyTest("RunAction", () => cmd.runAction(c(), { action: "pcbnew.InteractiveSelection.ClearSelection" }));
  guiOnlyTest("SaveSelectionToString", () => cmd.saveSelectionToString(c(), {}));

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
  guiOnlyTest("SyncSelection", () => cmd.syncSelection(c(), { items: [{ spec: { case: "footprint", value: { reference: firstFp.reference } } }] }));

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
    expect(_BOT.BOT_DRILL).toBe(BoardOriginType.BOT_DRILL);
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
    const polys = await board.padShapesAsPolygons(pads.slice(0, 3).map((p) => p.id), BoardLayer.BL_F_Cu);
    expect(polys.size).toBeGreaterThan(0);
  });
  cmdTest("CheckPadstackPresenceOnLayers", async () => {
    const m = await board.padstackPresence(pads.slice(0, 3).map((p) => p.id), [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu]);
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
    const id = await board.injectDrcError("kicad-web injected", firstFp.position, { severity: DrcSeverity.DRS_WARNING, items: [firstFp.id] });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    return id;
  });
  cmdTest("ImportNetlist", async () => {
    const r = await board.importNetlist(QA_NETLIST, { dryRun: true, matchMode: "reference" });
    expect(typeof r.report).toBe("string");
    return `dry run of a QA netlist: ${r.errorCount} errors, ${r.warningCount} warnings, ${r.newFootprintCount} new footprints`;
  }, 120_000);
  guiOnlyTest("GetActiveLayer", () => cmd.getActiveLayer(c(), { board: board.specifier }));
  guiOnlyTest("SetActiveLayer", () => cmd.setActiveLayer(c(), { board: board.specifier, layer: BoardLayer.BL_F_Cu }));
  guiOnlyTest("GetVisibleLayers", () => cmd.getVisibleLayers(c(), { board: board.specifier }));
  guiOnlyTest("SetVisibleLayers", () => cmd.setVisibleLayers(c(), { board: board.specifier, layers: [BoardLayer.BL_F_Cu] }));
  guiOnlyTest("GetBoardEditorAppearanceSettings", () => cmd.getBoardEditorAppearanceSettings(c(), {}));
  guiOnlyTest("SetBoardEditorAppearanceSettings", () => cmd.setBoardEditorAppearanceSettings(c(), {}));
  guiOnlyTest("InteractiveMoveItems", () => cmd.interactiveMoveItems(c(), { board: board.specifier, items: [{ value: firstFp.id }] }));

  // ---- board/jobs -----------------------------------------------------------------------------------------
  const boardJob = (name: string, run: (out: string) => Promise<{ outputPaths: string[]; status: JobStatus }>, ext: string, timeout = 120_000) =>
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
  boardJob("RunBoardJobExportSvg", (out) => board.jobs.exportSvg(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_Edge_Cuts] } }), ".svg");
  boardJob("RunBoardJobExportDxf", (out) => board.jobs.exportDxf(out, { plotSettings: { layers: [BoardLayer.BL_Edge_Cuts] } }), ".dxf");
  boardJob("RunBoardJobExportPdf", (out) => board.jobs.exportPdf(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu] } }), ".pdf");
  boardJob("RunBoardJobExportPs", (out) => board.jobs.exportPs(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu] } }), ".ps");
  boardJob("RunBoardJobExportGerbers", (out) => board.jobs.exportGerbers(out, { plotSettings: { layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu] } }), "");
  boardJob("RunBoardJobExportDrill", (out) => board.jobs.exportDrill(`${out}/`, { format: DrillFormat.DF_EXCELLON }), "");
  boardJob("RunBoardJobExportPosition", (out) => board.jobs.exportPosition(out), ".pos");
  boardJob("RunBoardJobExportGencad", (out) => board.jobs.exportGencad(out), ".cad");
  boardJob("RunBoardJobExportIpc2581", (out) => board.jobs.exportIpc2581(out), ".xml");
  boardJob("RunBoardJobExportIpcD356", (out) => board.jobs.exportIpcD356(out), ".d356");
  boardJob("RunBoardJobExportODB", (out) => board.jobs.exportOdb(out), ".zip");
  boardJob("RunBoardJobExportStats", (out) => board.jobs.exportStats(out, { format: StatsOutputFormat.SOF_JSON }), ".json");
  boardJob("RunBoardJobExport3D", (out) => board.jobs.export3D(out, { format: Board3DFormat.B3D_GLB, overwrite: true }), ".glb", 300_000);
  boardJob("RunBoardJobExportRender", (out) => board.jobs.exportRender(out, { format: RenderFormat.RF_PNG, width: 320, height: 240 }), ".png", 300_000);

  // ---- footprint document (late: has crashed the stable server) ---------------------------------------------
  cmdTest("OpenLibraryItem", async () => {
    // The footprint handler only exists once a footprint document is open headless; the temp
    // project carries an fp-lib-table pointing at KiCad's QA Resistor_SMD.pretty. Runs late
    // because opening a footprint document has crashed the stable server (see summary).
    const libId = "Resistor_SMD:R_0603_1608Metric";
    const fpDoc = await k().openFootprint(libId);
    const items = await fpDoc.getAllItems();
    await fpDoc.openInEditor();
    await fpDoc.close();
    return `opened ${libId}: ${items.length} items`;
  });

  // ---- close (last) -----------------------------------------------------------------------------------------
  cmdTest("CloseDocument", async () => {
    await sch.close();
    // KiCad answers GetOpenDocuments with AS_UNHANDLED once no schematic handler exists; the client maps that to [].
    expect(await k().openDocuments(DocumentType.DOCTYPE_SCHEMATIC)).toEqual([]);
    expect((await k().openDocuments(DocumentType.DOCTYPE_PCB)).length).toBe(1);
    sch = await project.openSchematic(tmp.sch);
    expect((await k().openDocuments(DocumentType.DOCTYPE_SCHEMATIC)).length).toBe(1);
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

function printSummary(): void {
  const rows = COMMANDS.map((info) => {
    const r = results.get(info.command);
    return { command: info.command, group: info.group, headless: info.headless, status: r?.status ?? "fail", note: r?.note ?? "not run" };
  });
  const pass = rows.filter((r) => r.status === "pass").length;
  const skip = rows.filter((r) => r.status === "skip").length;
  const fail = rows.filter((r) => r.status === "fail").length;
  const headlessTotal = COMMANDS.filter((x) => x.headless === "ok").length;
  const headlessPass = rows.filter((r) => r.headless === "ok" && r.status === "pass").length;
  const bugNotes = rows.filter((r) => r.note.includes("KICAD-BUG")).length;
  const lines = [
    "",
    `=== IPC conformance (KiCad ${KICAD_COMMIT.slice(0, 10)}) ===`,
    `${rows.length} commands: ${pass} pass, ${skip} skip (gui-only / server predates), ${fail} fail; headless ${headlessPass}/${headlessTotal} green; ${bugNotes} with KICAD-BUG notes`,
    ...restarts.map((r) => `  server restarted ${r}`),
    ...rows.map((r) => `  ${r.status.padEnd(4)} ${r.command.padEnd(34)} ${r.group.padEnd(17)} ${r.note}`),
    "",
  ];
  console.log(lines.join("\n"));
  void writeFile(join(import.meta.dir, "..", "..", "dist", "conformance-summary.txt"), lines.join("\n")).catch(() => {});
  void create;
  void Zone;
  void Pad;
  void KiCadObjectType;
}
