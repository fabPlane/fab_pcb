/**
 * Integration: the compile job through the bridge against a real `kicad-cli api-server` — a bare
 * session, `POST /sessions/:id/compile` with an inline `circuit.netlist.json` that names its own
 * footprint library, progress over SSE, the project created on disk, the board compiled and saved,
 * and a second compile on the now-open project. Skipped with a message when kicad-cli is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CompileJobInfo } from "@fp-pcb/compile/bridge-job";
import { KiCad, decodeEvent } from "@fp-pcb/client";
import { configFromEnv, startBridge, type BridgeServer } from "../src/index";

const cfg = configFromEnv(process.env, { port: 0, log: () => {} });
const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(import.meta.dir, "..", "..", "..", "..", "kicad");
const QA_LIBRARIES = join(KICAD_ROOT, "qa", "data", "libraries");
const haveKicad = existsSync(cfg.kicadCli) && existsSync(join(QA_LIBRARIES, "Resistor_SMD.pretty"));
if (!haveKicad)
  console.log(
    `[skip] kicad-cli or qa libraries not found (${cfg.kicadCli}); set KICAD_CLI / KICAD_SRC to run the compile job integration test`,
  );

const NETLIST_JSON = {
  netlist: {
    components: [
      { ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric", libSource: { lib: "Device", part: "R" } },
      { ref: "R2", value: "2k2", footprint: "Resistor_SMD:R_0603_1608Metric", libSource: { lib: "Device", part: "R" } },
    ],
    nets: [
      {
        name: "N1",
        nodes: [
          { ref: "R1", pin: "1" },
          { ref: "R2", pin: "1" },
        ],
      },
      {
        name: "N2",
        nodes: [
          { ref: "R1", pin: "2" },
          { ref: "R2", pin: "2" },
        ],
      },
    ],
  },
  board: {
    widthMm: 20,
    heightMm: 10,
    placements: [
      { ref: "R1", position: { x: 5, y: 4 } },
      { ref: "R2", position: { x: 15, y: 6 } },
    ],
  },
  libraries: [
    { kind: "footprint", nickname: "Resistor_SMD", uri: join(QA_LIBRARIES, "Resistor_SMD.pretty") },
    { kind: "symbol", nickname: "Device", uri: join(QA_LIBRARIES, "Device.kicad_sym") },
  ],
};

describe.skipIf(!haveKicad)("compile jobs + kicad-cli api-server", () => {
  let bridge: BridgeServer;
  let workspace: string;
  let sessionId: string;
  let preservedWireId: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "fp-pcb-compile-kicad-"));
    bridge = await startBridge({ ...cfg, workspaceRoot: workspace });
    const res = await fetch(`${bridge.url}/sessions`, { method: "POST", body: JSON.stringify({ path: null }) });
    expect(res.status).toBe(201);
    sessionId = ((await res.json()) as { session: { id: string } }).session.id;
  }, 90_000);

  afterAll(async () => {
    await bridge?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  const api = (path: string, init?: RequestInit) => fetch(`${bridge.url}${path}`, init);

  async function follow(jobId: string, onEvent?: (ev: string, data: CompileJobInfo) => void): Promise<CompileJobInfo> {
    const res = await api(`/sessions/${sessionId}/compile/${jobId}`, { headers: { accept: "text/event-stream" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    let last: CompileJobInfo | undefined;
    for (const block of text.split("\n\n")) {
      const ev = /^event: (\S+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const parsed = JSON.parse(data) as CompileJobInfo;
      onEvent?.(ev, parsed);
      if (ev === "done" || ev === "error" || ev === "state") last = parsed;
    }
    if (!last) throw new Error(`no terminal event in:\n${text}`);
    return last;
  }

  test("/health lists the compile frontends", async () => {
    const h = (await (await api("/health")).json()) as { compile: { frontends: string[] } };
    expect(h.compile.frontends).toEqual(["netlist-json"]);
  });

  test("compiles a netlist-json source on a bare session, creating the project", async () => {
    const projectPath = join(workspace, "demo", "demo.kicad_pro");
    const events: ReturnType<typeof decodeEvent>[] = [];
    const off = bridge.sessions.get(sessionId)!.onEvent((bytes) => events.push(decodeEvent(bytes)));
    const res = await api(`/sessions/${sessionId}/compile`, {
      method: "POST",
      body: JSON.stringify({
        source: {
          kind: "netlist-json",
          files: { "circuit.netlist.json": JSON.stringify(NETLIST_JSON) },
          entrypoint: "circuit.netlist.json",
        },
        project: { path: projectPath },
        netlistPath: ".fabdesk/compile.net",
      }),
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: CompileJobInfo };
    expect(job.state).toBe("queued");
    const states: string[] = [];
    const done = await follow(job.id, (ev, d) => states.push(`${ev}:${d.state}`));
    off();
    expect(done.state).toBe("done");
    expect(done.error).toBeUndefined();
    expect(done.result).toMatchObject({
      ok: true,
      diagnostics: [],
      counts: { components: 2, nets: 2, footprintsAdded: 2, footprintsPlaced: 2 },
    });
    expect(typeof done.revision).toBe("number");
    for (const s of ["schematic", "checking", "outlining", "importing", "placing", "parity", "saving"])
      expect(states).toContain(`progress:${s}`);
    expect(states.indexOf("progress:schematic")).toBeLessThan(states.indexOf("progress:checking"));
    expect(states.indexOf("progress:parity")).toBeGreaterThan(states.indexOf("progress:importing"));
    expect(done.log.some((l) => l.includes("registered 2 project libraries: Resistor_SMD, Device"))).toBe(true);
    expect(done.log.some((l) => l.includes("schematic: 2 symbols, 4 wires, 4 labels, 0 no-connects"))).toBe(true);
    expect(done.log).toContain("schematic: saved and reopened before ERC");
    expect(done.log.some((line) => line.startsWith("ERC: 0 errors"))).toBe(true);
    expect(done.log).toContain("board update: SyncSchematicToBoard (schematic authoritative)");
    expect(done.log).toContain("schematic parity: 0 conflicts");
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(join(workspace, "demo", "demo.kicad_pcb"))).toBe(true);
    expect(existsSync(join(workspace, "demo", ".fabdesk", "compile.net"))).toBe(true);
    const discovered = (await (await api(`/sessions/${sessionId}`)).json()) as {
      session: { path: string | null };
    };
    expect(discovered.session.path).toBe(projectPath);
    const imported = events.find(
      (event) =>
        event.kind.case === "documentChanged" &&
        event.kind.value.clientName === `fp-pcb/bridge/${sessionId}/compile` &&
        event.kind.value.message === "Update Netlist",
    );
    expect(imported?.kind.case).toBe("documentChanged");
    if (imported?.kind.case === "documentChanged") {
      expect(imported.kind.value.document?.identifier).toEqual({ case: "boardFilename", value: "demo.kicad_pcb" });
      expect(Number(imported.kind.value.revision)).toBeGreaterThan(0);
      expect(Number(imported.kind.value.revision)).toBeLessThanOrEqual(done.revision!);
    }
    const kicad = await KiCad.connect(bridge.sessions.get(sessionId)!.transport!, { clientName: "fp-pcb/bridge-placement-test" });
    expect(
      Object.fromEntries(
        (await (await kicad.currentBoard())!.getFootprints()).map((footprint) => [footprint.reference, footprint.position]),
      ),
    ).toEqual({ R1: { x: 5_000_000, y: 4_000_000 }, R2: { x: 15_000_000, y: 6_000_000 } });
    const schematic = (await kicad.currentSchematic())!;
    let root = await schematic.rootSheet();
    expect((await root.getSymbols()).map((symbol) => symbol.reference).sort()).toEqual(["R1", "R2"]);
    const wires = await schematic.getWires(root.scope);
    expect(wires.length).toBe(4);
    const symbols = await root.getSymbols();
    const pins = symbols.flatMap((symbol) => symbol.pins);
    expect(pins).toHaveLength(4);
    expect(new Set(pins.map((pin) => pin.id)).size).toBe(pins.length);
    const pinPositions = symbols
      .flatMap((symbol) => symbol.pins.map((pin) => [symbol.reference, pin.proto.number, pin.position] as const))
      .sort(([aRef, aPin], [bRef, bPin]) => `${aRef}:${aPin}`.localeCompare(`${bRef}:${bPin}`));
    const initialErc = await schematic.erc.run();
    expect(initialErc.errorCount).toBe(0);
    expect(initialErc.markers.map((marker) => marker.description).join("\n")).not.toMatch(
      /not connected|unconnected wire endpoint|off connection grid/i,
    );

    // The editable source of truth must survive the actual file boundary, not merely look right
    // in the server's in-memory model.
    await schematic.close();
    const reopened = await kicad.openSchematic(join(workspace, "demo", "demo.kicad_sch"));
    root = await reopened.rootSheet();
    expect((await root.getSymbols()).map((symbol) => symbol.reference).sort()).toEqual(["R1", "R2"]);
    const reloadedErc = await reopened.erc.run();
    expect(reloadedErc.errorCount).toBe(0);
    expect(reloadedErc.markers.map((marker) => marker.description).join("\n")).not.toMatch(
      /not connected|unconnected wire endpoint|off connection grid/i,
    );
    const reloadedSymbols = await root.getSymbols();
    const reloadedPins = reloadedSymbols.flatMap((symbol) => symbol.pins);
    expect(reloadedPins).toHaveLength(4);
    expect(new Set(reloadedPins.map((pin) => pin.id)).size).toBe(reloadedPins.length);
    expect(
      reloadedSymbols
        .flatMap((symbol) => symbol.pins.map((pin) => [symbol.reference, pin.proto.number, pin.position] as const))
        .sort(([aRef, aPin], [bRef, bPin]) => `${aRef}:${aPin}`.localeCompare(`${bRef}:${bPin}`)),
    ).toEqual(pinPositions);
    const parity = await (await kicad.currentBoard())!.drc.run({ testFootprintsAgainstSchematic: true });
    expect(parity.parityCount).toBe(0);
    const preserved = (await reopened.getWires(root.scope))[0]!;
    preserved.setCustomProperty("fp-pcb.generated", undefined);
    preservedWireId = (await root.commit("adopt generated wire as manual", (tx) => tx.update([preserved]))).updated[0]!.id;
    const polled = (await (await api(`/sessions/${sessionId}/compile/${job.id}`)).json()) as { job: CompileJobInfo };
    expect(polled.job.state).toBe("done");
    const list = (await (await api(`/sessions/${sessionId}/compile`)).json()) as { jobs: CompileJobInfo[]; frontends: string[] };
    expect(list.jobs.map((j) => j.id)).toContain(job.id);
  }, 120_000);

  test("a second compile on the now-open project adds nothing and reports its diagnostics", async () => {
    const withWarning = {
      ...NETLIST_JSON,
      netlist: { ...NETLIST_JSON.netlist, nets: [...NETLIST_JSON.netlist.nets, { name: "LONELY", nodes: [] }] },
    };
    const res = await api(`/sessions/${sessionId}/compile`, {
      method: "POST",
      body: JSON.stringify({
        source: {
          kind: "netlist-json",
          files: { "circuit.netlist.json": JSON.stringify(withWarning) },
          entrypoint: "circuit.netlist.json",
        },
      }),
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: CompileJobInfo };
    const done = await bridge.compileJobs.wait(job.id);
    expect(done.state).toBe("done");
    expect(done.result?.counts.footprintsAdded).toBe(0);
    expect(done.result?.diagnostics.map((d) => d.code)).toContain("single_node_net");
    const kicad = await KiCad.connect(bridge.sessions.get(sessionId)!.transport!, { clientName: "fp-pcb/schematic-rebuild-test" });
    const root = await (await kicad.currentSchematic())!.rootSheet();
    expect((await root.getSymbols()).map((symbol) => symbol.reference).sort()).toEqual(["R1", "R2"]);
    expect((await root.getAllItems()).some((item) => item.id === preservedWireId)).toBe(true);
    // The regenerated stub that lies exactly on the adopted wire is merged away by KiCad's commit
    // cleanup (headless commits run it since upstream f47543c257), as the editor would; the
    // adopted wire itself is kept (checked above).
    expect((await (await kicad.currentSchematic())!.getWires(root.scope)).length).toBe(4);
  }, 60_000);

  test("an ERC-invalid schematic fails before the board update", async () => {
    const sessionResponse = await fetch(`${bridge.url}/sessions`, { method: "POST", body: JSON.stringify({ path: null }) });
    expect(sessionResponse.status).toBe(201);
    const isolatedSessionId = ((await sessionResponse.json()) as { session: { id: string } }).session.id;
    const invalid = {
      ...NETLIST_JSON,
      netlist: { components: [NETLIST_JSON.netlist.components[0]], nets: [] },
      board: { widthMm: 10, heightMm: 10 },
    };
    try {
      const response = await fetch(`${bridge.url}/sessions/${isolatedSessionId}/compile`, {
        method: "POST",
        body: JSON.stringify({
          source: {
            kind: "netlist-json",
            files: { "circuit.netlist.json": JSON.stringify(invalid) },
            entrypoint: "circuit.netlist.json",
          },
          project: { path: join(workspace, "erc-invalid", "erc-invalid.kicad_pro") },
        }),
      });
      expect(response.status).toBe(202);
      const { job } = (await response.json()) as { job: CompileJobInfo };
      const done = await bridge.compileJobs.wait(job.id);
      expect(done.state).toBe("failed");
      expect(done.error).toBeUndefined();
      expect(done.result?.diagnostics.map((diagnostic) => diagnostic.code)).toContain("erc_errors");
      expect(done.log.some((line) => /^ERC: [1-9]\d* errors/.test(line))).toBe(true);
      expect(done.log).not.toContain("board update: SyncSchematicToBoard (schematic authoritative)");
      expect(done.rejectedSchematicPath).toBe(join(workspace, "erc-invalid", ".fp-pcb", "rejected", `${job.id}.kicad_sch`));
      expect(existsSync(done.rejectedSchematicPath!)).toBe(true);
      expect(done.log.some((line) => line.includes("restored last-known-good schematic"))).toBe(true);
      const isolated = await KiCad.connect(bridge.sessions.get(isolatedSessionId)!.transport!, {
        clientName: "fp-pcb/erc-fail-closed-test",
      });
      expect(await (await isolated.currentBoard())!.getFootprints()).toHaveLength(0);
      expect(await (await isolated.currentSchematic())!.rootSheet().then((sheet) => sheet.getSymbols())).toHaveLength(0);
    } finally {
      await fetch(`${bridge.url}/sessions/${isolatedSessionId}`, { method: "DELETE" });
    }
  }, 60_000);

  test("a frontend error ends failed with diagnostics and no infrastructure error", async () => {
    const res = await api(`/sessions/${sessionId}/compile`, {
      method: "POST",
      body: JSON.stringify({
        source: { kind: "netlist-json", files: { "circuit.netlist.json": "{ nope" }, entrypoint: "circuit.netlist.json" },
      }),
    });
    const { job } = (await res.json()) as { job: CompileJobInfo };
    const done = await bridge.compileJobs.wait(job.id);
    expect(done.state).toBe("failed");
    expect(done.error).toBeUndefined();
    expect(done.result?.ok).toBe(false);
    expect(done.result?.diagnostics[0]?.code).toBe("json_syntax");
  }, 60_000);
});
