/** The orchestration hooks the bridge job relies on: stage order, `beforeApply` before any board call, cancellation between stages, and the edge inset. */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoplaceResult, BoardLayer } from "@fp-pcb/proto";
import type { Board } from "@fp-pcb/client";
import { insetOutline, outlineItems, outlinePoints } from "../src/apply";
import { compile, CompileCancelled, type CompileStageName } from "../src/compile";
import type { CompileSource, Frontend, Netlist } from "../src/types";

const NETLIST: Netlist = { components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" }], nets: [] };
const SOURCE: CompileSource = { kind: "stub", files: {}, entrypoint: "x" };
const frontend: Frontend = {
  kind: "stub",
  build: async () => ({ netlist: NETLIST, diagnostics: [], libraries: [{ kind: "footprint", nickname: "L", uri: "/l" }] }),
};

type Seg = { value: { start: { xNm: bigint; yNm: bigint }; end: { xNm: bigint; yNm: bigint } } };
const segOf = (s: { proto: { shape?: { geometry: unknown } } }) => s.proto.shape!.geometry as Seg;

/** A board whose outline starts at (2 mm, 2 mm) and whose one footprint the placer left with its box at (0.2 mm, 0.2 mm). */
function board(log: string[]) {
  const fp = { id: "fp1", position: { x: 500_000, y: 500_000 } };
  const edges = outlineItems(outlinePoints({ widthMm: 20, heightMm: 10 })!.map((p) => ({ x: p.x + 2_000_000, y: p.y + 2_000_000 })));
  edges.forEach((e, i) => (e.proto.id = { $typeName: "kiapi.common.types.KIID", value: `edge${i}` }));
  return {
    async importNetlist(_p: string, o: { dryRun?: boolean }) {
      log.push(o.dryRun ? "importNetlist:dry" : "importNetlist");
      return { errorCount: 0, warningCount: 0, newFootprintCount: 1, report: "" };
    },
    async getShapes() {
      log.push("getShapes");
      return edges;
    },
    async getItems() {
      log.push("getItems");
      return log.includes("importNetlist") ? [fp] : [];
    },
    async getPads() {
      log.push("getPads");
      if (!log.includes("importNetlist")) return [];
      // The import spreads the footprint out; the autoplacer brings it to (0.5 mm, 0.5 mm).
      const placed = log.includes("autoplace");
      return [{ parent: "fp1", position: { x: placed ? 500_000 : 40_000_000, y: 500_000 } }];
    },
    async commit(
      message: string,
      fn: (tx: { create: (i: unknown[]) => Promise<unknown[]>; update: (i: unknown[]) => Promise<unknown[]> }) => Promise<unknown>,
    ) {
      log.push(`commit:${message}`);
      return fn({ create: async (i) => i, update: async (i) => i });
    },
    async autoplace() {
      log.push("autoplace");
      return { result: AutoplaceResult.APR_COMPLETED, placedCount: 1, ok: true };
    },
    async boundingBoxes(ids: string[]) {
      return new Map(
        ids.map((id) => {
          const e = edges.find((s) => s.id === id);
          if (e) {
            const g = segOf(e);
            return [
              id,
              {
                x: Math.min(Number(g.value.start.xNm), Number(g.value.end.xNm)),
                y: Math.min(Number(g.value.start.yNm), Number(g.value.end.yNm)),
                w: 0,
                h: 0,
              },
            ];
          }
          return [id, { x: fp.position.x - 300_000, y: fp.position.y - 300_000, w: 1_000_000, h: 600_000 }];
        }),
      );
    },
    async getFootprints() {
      return [fp];
    },
    fp,
    edges,
  };
}

const netlistPath = async () => join(await mkdtemp(join(tmpdir(), "fp-pcb-hooks-")), "c.net");

describe("compile hooks", () => {
  test("stages run in order and beforeApply precedes every board call", async () => {
    const log: string[] = [];
    const b = board(log);
    const stages: CompileStageName[] = [];
    await compile(SOURCE, b as unknown as Board, {
      frontend,
      netlistPath: await netlistPath(),
      autoplace: true,
      onStage: (s) => stages.push(s),
      beforeApply: async (built) => {
        expect(built.libraries?.[0]?.nickname).toBe("L");
        log.push("beforeApply");
      },
    });
    expect(stages).toEqual(["frontend", "validating", "checking", "outlining", "importing", "placing"]);
    expect(log[0]).toBe("beforeApply");
  });

  test("aborting between stages throws CompileCancelled and stops the board work", async () => {
    const log: string[] = [];
    const b = board(log);
    const ac = new AbortController();
    const pending = compile(SOURCE, b as unknown as Board, {
      frontend,
      netlistPath: await netlistPath(),
      autoplace: true,
      signal: ac.signal,
      onStage: (s) => {
        if (s === "outlining") ac.abort();
      },
    });
    const err = await pending.catch((e: unknown) => e);
    expect(CompileCancelled.is(err)).toBe(true);
    expect(log).not.toContain("importNetlist");
  });

  test("the edge inset moves the outline so its corner is margin outside the placed group, in one commit", async () => {
    const log: string[] = [];
    const b = board(log);
    // outline corner (2, 2) mm; footprint box starts at (0.2, 0.2) mm; margin 0.5 mm -> outline moves by (-2.3, -2.3) mm
    const d = await insetOutline(b as unknown as Board, ["fp1"], 500_000);
    expect(d).toEqual({ x: -2_300_000, y: -2_300_000 });
    expect(b.fp.position).toEqual({ x: 500_000, y: 500_000 });
    expect(Number(segOf(b.edges[0]!).value.start.xNm)).toBe(-300_000);
    expect(log.filter((l) => l.startsWith("commit:"))).toEqual(["commit:Compile: edge clearance inset"]);
    // already outside: nothing moves, no commit
    expect(await insetOutline(b as unknown as Board, ["fp1"], 500_000)).toBeNull();
  });

  test("a pre-existing outline is not moved: the compile reports edge_clearance_unchecked", async () => {
    const log: string[] = [];
    const b = board(log);
    const res = await compile(SOURCE, b as unknown as Board, {
      frontend,
      netlistPath: await netlistPath(),
      autoplace: true,
      edgeMarginNm: 500_000,
      board: { widthMm: 20, heightMm: 10 },
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.map((d) => d.code)).toEqual(["edge_clearance_unchecked"]);
    expect(log.filter((l) => l.startsWith("commit:"))).toEqual([]);
  });

  test("no margin, no outline, or nothing added: no inset", async () => {
    const log: string[] = [];
    const b = board(log);
    expect(await insetOutline(b as unknown as Board, [], 500_000)).toBeNull();
    expect(await insetOutline(b as unknown as Board, ["fp1"], 0)).toBeNull();
    b.getShapes = async () => [];
    expect(await insetOutline(b as unknown as Board, ["fp1"], 500_000)).toBeNull();
  });
});
