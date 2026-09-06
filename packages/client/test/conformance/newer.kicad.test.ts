/**
 * Conformance for commands newer than the stable server build: `GetServerInfo` + the events
 * socket, `NewProject` / `NewDocument` / `GetProjectInfo`, and headless symbol documents
 * (`DOCTYPE_SYMBOL`). Runs against the development binary (`KICAD_CLI_DEV`, default
 * ../kicad/build/dev/...) and skips cleanly when it is absent or predates a command.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiStatusCode, BoardLayer, DocumentType, ProjectFileType } from "@kicad-web/proto";
import { KiCadEvents } from "../../src/events";
import { KiCadApiError } from "../../src/errors";
import { LibSymbol, SchematicPin, Track, type Board, type Project } from "../../src/model";
import { NngIpcSubscriber } from "../../src/transport";
import { mm } from "../../src/units";
import { KICAD_CLI_DEV, KICAD_DATA, haveKicadDev, startKiCad, type RunningKiCad } from "../kicad-server";

const DEVICE_LIB = `${KICAD_DATA}/libraries/Device.kicad_sym`;

let rt: RunningKiCad;
let dir: string;
let supported = false;
let eventsUrl = "";
let events: KiCadEvents | undefined;
let project: Project;
let board: Board;

type Status = "pass" | "fail" | "skip";
const results = new Map<string, { status: Status; note: string }>();
const record = (name: string, status: Status, note = "") => results.set(name, { status, note });

function cmdTest(name: string, fn: () => Promise<string | void>, timeout = 60_000): void {
  test(name, async () => {
    if (!supported) {
      record(name, "skip", `${KICAD_CLI_DEV} predates GetServerInfo`);
      return;
    }
    try {
      const note = await fn();
      if (!results.has(name)) record(name, "pass", note ?? "");
    } catch (e) {
      if (KiCadApiError.is(e) && e.isUnsupported) {
        record(name, "skip", `dev server predates the command (${e.codeName})`);
        return;
      }
      record(name, "fail", e instanceof Error ? e.message.split("\n")[0]! : String(e));
      throw e;
    }
  }, timeout);
}

describe.skipIf(!haveKicadDev())("conformance (dev binary): events, NewProject/NewDocument/GetProjectInfo, symbol documents", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kicad-web-newer-"));
    rt = await startKiCad(null, "newer", KICAD_CLI_DEV);
    const info = await rt.kicad.serverInfo();
    supported = info !== undefined;
    eventsUrl = info?.eventsSocketUrl ?? "";
    if (!supported) console.log(`[skip] ${KICAD_CLI_DEV} predates GetServerInfo; newer-command tests are skipped`);
  }, 120_000);

  afterAll(async () => {
    await events?.close();
    await rt?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
    const rows = [...results].map(([n, r]) => `  ${r.status.padEnd(4)} ${n.padEnd(34)} ${r.note}`);
    const pass = [...results.values()].filter((r) => r.status === "pass").length;
    const skip = [...results.values()].filter((r) => r.status === "skip").length;
    const fail = [...results.values()].filter((r) => r.status === "fail").length;
    console.log(["", `=== newer commands (dev binary ${KICAD_CLI_DEV}) ===`, `${results.size} checks: ${pass} pass, ${skip} skip, ${fail} fail`, ...rows, ""].join("\n"));
  });

  cmdTest("GetServerInfo", async () => {
    const info = (await rt.kicad.serverInfo())!;
    expect(info.socketUrl).toContain(rt.server.socketPath);
    expect(info.kicadToken).toBe(rt.kicad.client.kicadToken!);
    expect(info.eventsSocketUrl).toMatch(/-events\.sock$/);
    return `events at ${info.eventsSocketUrl}`;
  });

  cmdTest("Events: DocumentOpened / DocumentChanged / DocumentSaved on the pub socket", async () => {
    if (!eventsUrl) {
      record("Events: DocumentOpened / DocumentChanged / DocumentSaved on the pub socket", "skip", "server reports no events socket");
      return;
    }
    const sub = await NngIpcSubscriber.connect({ path: eventsUrl });
    events = new KiCadEvents(sub);
    const gaps: string[] = [];
    events.onGap((g) => gaps.push(`${g.expected}->${g.received}`));

    const projectOpened = events.next("documentOpened", { timeoutMs: 20_000, filter: (d) => d.document?.type === DocumentType.DOCTYPE_PROJECT });
    project = await rt.kicad.newProject(join(dir, "evproj"));
    expect((await projectOpened).document?.project?.name).toBe("evproj");

    const boardOpened = events.next("documentOpened", { timeoutMs: 20_000, filter: (d) => d.document?.type === DocumentType.DOCTYPE_PCB });
    board = await project.openBoard();
    await boardOpened;

    const changed = events.next("documentChanged", { timeoutMs: 20_000 });
    const t = new Track();
    t.start = { x: mm(1), y: mm(1) };
    t.end = { x: mm(5), y: mm(1) };
    t.width = mm(0.25);
    t.layerId = BoardLayer.BL_F_Cu;
    const res = await board.commit("add track", (tx) => tx.create([t]));
    const ch = await changed;
    expect(ch.created.map((k) => k.value)).toEqual([res.created[0]!.id]);
    expect(ch.message).toBe("add track");
    expect(ch.revision).toBeGreaterThan(0n);
    expect(ch.clientName).toBe(rt.kicad.client.clientName);
    expect(ch.revision).toBe((await board.revision())!);

    const saved = events.next("documentSaved", { timeoutMs: 20_000 });
    await board.save();
    expect((await saved).path).toBe(join(dir, "evproj", "evproj.kicad_pcb"));
    expect(gaps).toEqual([]);
    return `${events.received} events, last sequence ${events.lastSequence}, no gaps`;
  }, 120_000);

  cmdTest("NewProject", async () => {
    project ??= await rt.kicad.newProject(join(dir, "evproj"));
    expect(project.name).toBe("evproj");
    for (const ext of [".kicad_pro", ".kicad_sch", ".kicad_pcb"]) expect(existsSync(join(dir, "evproj", `evproj${ext}`))).toBe(true);
    expect((await readFile(join(dir, "evproj", "evproj.kicad_sch"), "utf8")).startsWith("(kicad_sch")).toBe(true);
    const dup = await rt.kicad.newProject(join(dir, "evproj")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(KiCadApiError.is(dup, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    return "project + stub schematic/board created and opened; existing project refused";
  });

  cmdTest("GetProjectInfo", async () => {
    const info = await project.info();
    expect(info.kicadProPath).toBe(join(dir, "evproj", "evproj.kicad_pro"));
    expect(info.project?.name).toBe("evproj");
    const byKind = (k: ProjectFileType) => info.files.filter((f) => f.kind === k);
    expect(byKind(ProjectFileType.PFT_PROJECT).length).toBe(1);
    expect(byKind(ProjectFileType.PFT_SCHEMATIC).some((f) => f.isRoot)).toBe(true);
    expect(byKind(ProjectFileType.PFT_PCB)[0]?.isOpen).toBe(board !== undefined);
    return info.files.map((f) => `${ProjectFileType[f.kind]}${f.isOpen ? "*" : ""}`).join(", ");
  });

  cmdTest("NewDocument", async () => {
    const bare = await rt.kicad.newProject(join(dir, "bare"), { skipStubDocuments: true });
    expect(existsSync(join(dir, "bare", "bare.kicad_pcb"))).toBe(false);
    const b = await bare.newBoard();
    expect(existsSync(join(dir, "bare", "bare.kicad_pcb"))).toBe(true);
    expect(await b.getAllItems()).toEqual([]);
    const s = await bare.newSchematic();
    expect(existsSync(join(dir, "bare", "bare.kicad_sch"))).toBe(true);
    expect((await s.sheets()).length).toBeGreaterThanOrEqual(1);
    const info = await bare.info();
    expect(info.files.filter((f) => f.isOpen && (f.kind === ProjectFileType.PFT_PCB || f.kind === ProjectFileType.PFT_SCHEMATIC)).length).toBe(2);
    const again = await bare.newBoard().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(KiCadApiError.is(again, ApiStatusCode.AS_BAD_REQUEST)).toBe(true);
    project = bare;
    board = b;
    return "board + schematic created in a stub-less project and opened; existing file refused";
  });

  cmdTest("OpenDocument(DOCTYPE_SYMBOL) + symbol document items/commit", async () => {
    const symDir = join(dir, "symproj");
    await mkdir(symDir, { recursive: true });
    await writeFile(join(symDir, "sym-lib-table"), `(sym_lib_table\n  (version 7)\n  (lib (name "Device") (type "KiCad") (uri "${DEVICE_LIB}") (options "") (descr "QA"))\n)\n`);
    project = await rt.kicad.newProject(symDir, { skipStubDocuments: true });
    const name = /^\s*\(symbol "([^"]+)"/m.exec(await readFile(DEVICE_LIB, "utf8"))?.[1];
    expect(name).toBeDefined();
    const libId = `Device:${name}`;
    const sym = await rt.kicad.openSymbol(libId).catch((e: unknown) => {
      if (KiCadApiError.is(e, ApiStatusCode.AS_BAD_REQUEST)) throw new Error(`OpenDocument(DOCTYPE_SYMBOL ${libId}) rejected: ${e.serverMessage}`);
      throw e;
    });
    expect(sym.libId).toBe(libId);
    expect((await rt.kicad.openDocuments(DocumentType.DOCTYPE_SYMBOL)).length).toBe(1);
    const lib = await sym.libSymbol();
    expect(lib).toBeInstanceOf(LibSymbol);
    expect(lib!.name).toBe(name!);
    expect(lib!.pins.length).toBeGreaterThan(0);
    const pins = await sym.getPins();
    const items = await sym.getAllItems();
    expect(items.length).toBeGreaterThan(0);
    const types = [...new Set(items.map((i) => i.typeName))].sort();
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
    await sym.close();
    expect((await rt.kicad.openDocuments(DocumentType.DOCTYPE_SYMBOL)).length).toBe(0);
    return `${libId}: ${items.length} children (${types.join(", ")}), ${pins.length} pins, lib symbol with ${lib!.pins.length} pins over ${lib!.unitCount} unit(s); ${commitNote}`;
  });
});
