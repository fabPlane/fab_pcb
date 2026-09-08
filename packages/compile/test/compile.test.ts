/**
 * Orchestration on a stub `Board` that logs every call: what matters here is the *ordering*
 * guarantee — a compile that fails must not have touched the board, the dry run gates the real
 * import, the outline precedes it, and only the footprints it added get placed. `applyNetlist`
 * against a real server belongs in a `*.kicad.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoplaceResult, BoardLayer } from "@fp-pcb/proto";
import type { Board } from "@fp-pcb/client";
import { compile } from "../src/compile";
import { outlineItems, outlinePoints, reportDiagnostics } from "../src/apply";
import type { CompileSource, Frontend, Netlist } from "../src/types";

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
  ],
};

const SOURCE: CompileSource = { kind: "stub", files: { "design.net": "" }, entrypoint: "design.net" };

function frontend(result: Partial<Awaited<ReturnType<Frontend["build"]>>> = {}, kind = "stub"): Frontend {
  return { kind, build: async () => ({ netlist: NETLIST, diagnostics: [], ...result }) };
}

interface StubOptions {
  /** Footprints already on the board. */
  existing?: string[];
  /** Ids the real import "creates". */
  adds?: string[];
  /** The board already has an Edge.Cuts shape. */
  outlined?: boolean;
  /** What the dry run reports. */
  dryRun?: { errorCount: number; warningCount?: number; report?: string };
  /** What the real import reports. */
  imported?: { errorCount?: number; warningCount?: number; report?: string };
  autoplaceOk?: boolean;
}

function board(o: StubOptions = {}): { board: Board; log: string[]; autoplaceArgs: unknown[] } {
  const log: string[] = [];
  const autoplaceArgs: unknown[] = [];
  let footprints = [...(o.existing ?? [])];
  const stub = {
    async importNetlist(_path: string, opts: { dryRun?: boolean }) {
      if (opts.dryRun) {
        log.push("importNetlist:dry");
        return { errorCount: 0, warningCount: 0, newFootprintCount: 0, report: "", ...o.dryRun };
      }
      log.push("importNetlist");
      footprints = [...footprints, ...(o.adds ?? [])];
      return { errorCount: 0, warningCount: 0, newFootprintCount: o.adds?.length ?? 0, report: "Added footprint R1", ...o.imported };
    },
    async getShapes() {
      log.push("getShapes");
      return o.outlined ? [{ proto: { layer: BoardLayer.BL_Edge_Cuts } }] : [];
    },
    async getItems() {
      log.push("getItems");
      return footprints.map((id) => ({ id }));
    },
    async commit(_message: string, fn: (tx: { create: (items: unknown[]) => Promise<unknown[]> }) => Promise<unknown>) {
      log.push("commit");
      return fn({ create: async (items) => items });
    },
    async autoplace(...args: unknown[]) {
      log.push("autoplace");
      autoplaceArgs.push(...args);
      const ok = o.autoplaceOk ?? true;
      return {
        result: ok ? AutoplaceResult.APR_COMPLETED : AutoplaceResult.APR_NO_BOARD_OUTLINE,
        placedCount: ok ? (o.adds?.length ?? 0) : 0,
        ok,
      };
    },
  };
  return { board: stub as unknown as Board, log, autoplaceArgs };
}

const paths: string[] = [];
function netlistPath(name: string): string {
  const p = join(tmpdir(), `fp-pcb-compile-${name}-${Date.now()}.net`);
  paths.push(p);
  return p;
}
afterAll(async () => {
  await Promise.all(paths.map((p) => rm(p, { force: true })));
});

const spec = { widthMm: 20, heightMm: 10 };

describe("compile", () => {
  test("dry run, outline, import, then places exactly what was added", async () => {
    const { board: b, log, autoplaceArgs } = board({ existing: ["fp-old"], adds: ["fp-r1", "fp-d1"] });
    const res = await compile(SOURCE, b, { frontend: frontend(), netlistPath: netlistPath("ok"), autoplace: true, board: spec });

    expect(res.ok).toBe(true);
    expect(log).toEqual(["importNetlist:dry", "getShapes", "commit", "getItems", "importNetlist", "getItems", "autoplace"]);
    expect(autoplaceArgs).toEqual([["fp-r1", "fp-d1"], { includeOffboard: true }]);
    expect(res.counts).toEqual({ components: 2, nets: 1, footprintsAdded: 2, footprintsPlaced: 2 });
    expect(await Bun.file(res.netlistPath!).text()).toContain('(comp (ref "R1")');
  });

  test("a dry-run error stops before anything changes and carries KiCad's report", async () => {
    const report = "Cannot add R1 (footprint 'Resistor_SMD:R_0402_1005Metric' not found).";
    const { board: b, log } = board({ dryRun: { errorCount: 1, report } });
    const res = await compile(SOURCE, b, { frontend: frontend(), netlistPath: netlistPath("dry"), autoplace: true, board: spec });

    expect(res.ok).toBe(false);
    expect(log).toEqual(["importNetlist:dry"]);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: "error", code: "import_failed" });
    expect(res.diagnostics[0]!.message).toContain(report);
  });

  test("a frontend error leaves the board untouched", async () => {
    const { board: b, log } = board();
    const failing = frontend({ netlist: null, diagnostics: [{ severity: "error", stage: "frontend", message: "boom", line: 3 }] });
    const res = await compile(SOURCE, b, { frontend: failing, netlistPath: netlistPath("frontend") });

    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]!.line).toBe(3);
    expect(log).toEqual([]);
  });

  test("a validation error leaves the board untouched", async () => {
    const { board: b, log } = board();
    const bad = frontend({ netlist: { components: [], nets: [{ name: "N1", nodes: [{ ref: "R9", pin: "1" }] }] } });
    const res = await compile(SOURCE, b, { frontend: bad, netlistPath: netlistPath("validate") });

    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.code)).toContain("unknown_ref");
    expect(log).toEqual([]);
  });

  test("refuses a source the frontend does not handle", async () => {
    const { board: b, log } = board();
    const res = await compile(SOURCE, b, { frontend: frontend({}, "other"), netlistPath: netlistPath("mismatch") });

    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]!.code).toBe("frontend_mismatch");
    expect(log).toEqual([]);
  });

  test("warnings alone still compile", async () => {
    const { board: b } = board({ imported: { warningCount: 1, report: "Footprint R1 has an unknown field." } });
    const warned = frontend({ netlist: { components: [{ ref: "R1", value: "1k", footprint: "" }], nets: [] } });
    const res = await compile(SOURCE, b, { frontend: warned, netlistPath: netlistPath("warn") });

    expect(res.ok).toBe(true);
    expect(res.diagnostics.map((d) => d.code)).toEqual(["missing_footprint", "import_warnings"]);
  });

  test("an existing outline is left alone", async () => {
    const { board: b, log } = board({ outlined: true, adds: ["fp-r1"] });
    await compile(SOURCE, b, { frontend: frontend(), netlistPath: netlistPath("outline"), board: spec });
    expect(log).not.toContain("commit");
  });

  test("nothing added means nothing to place", async () => {
    const { board: b, log } = board({ existing: ["fp-r1", "fp-d1"] });
    const res = await compile(SOURCE, b, { frontend: frontend(), netlistPath: netlistPath("noop"), autoplace: true, board: spec });
    expect(log).not.toContain("autoplace");
    expect(res.counts.footprintsPlaced).toBe(0);
  });

  test("a failed autoplace is a warning, not a failed compile", async () => {
    const { board: b } = board({ adds: ["fp-r1"], autoplaceOk: false });
    const res = await compile(SOURCE, b, { frontend: frontend(), netlistPath: netlistPath("place"), autoplace: true, board: spec });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.map((d) => d.code)).toContain("autoplace_failed");
  });
});

describe("outline helpers", () => {
  test("width and height become a rectangle in nanometres", () => {
    expect(outlinePoints({ widthMm: 20, heightMm: 10 })).toEqual([
      { x: 0, y: 0 },
      { x: 20_000_000, y: 0 },
      { x: 20_000_000, y: 10_000_000 },
      { x: 0, y: 10_000_000 },
    ]);
  });

  test("an explicit outline wins over width and height", () => {
    expect(outlinePoints({ widthMm: 20, heightMm: 10, outline: [{ x: 1, y: 2 }] })).toEqual([{ x: 1_000_000, y: 2_000_000 }]);
  });

  test("no outline described", () => {
    expect(outlinePoints(undefined)).toBeNull();
    expect(outlinePoints({})).toBeNull();
    expect(outlinePoints({ widthMm: 20 })).toBeNull();
  });

  test("a closed polygon becomes one Edge.Cuts segment per side", () => {
    const items = outlineItems(outlinePoints({ widthMm: 20, heightMm: 10 })!);
    expect(items).toHaveLength(4);
    for (const item of items) expect(item.proto.layer).toBe(BoardLayer.BL_Edge_Cuts);
  });
});

describe("reportDiagnostics", () => {
  test("grades by the error count, never by the text", () => {
    const d = reportDiagnostics("Cannot add R1 (footprint 'X' not found).", 1, 0);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", code: "import_failed" });
    expect(d[0]!.message).toContain("Cannot add R1");
  });

  test("warnings only", () => {
    expect(reportDiagnostics("something odd", 0, 2).map((d) => d.severity)).toEqual(["warning"]);
  });

  test("a clean import is silent, whatever the report says", () => {
    expect(reportDiagnostics("Added footprint R1\nAdded footprint D1", 0, 0)).toEqual([]);
    expect(reportDiagnostics("", 0, 0)).toEqual([]);
  });
});
