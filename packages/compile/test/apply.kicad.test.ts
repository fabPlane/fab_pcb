/**
 * Integration: `applyNetlist` against a real fork `kicad-cli api-server` — the dry-run gate, the
 * outline, the import, the autoplace with the edge-clearance inset, DRC, and the saved file; then
 * the two re-import behaviours the compile defaults promise (a removed component leaves the board,
 * a changed footprint is swapped). Skipped with a message when kicad-cli or the qa libraries are
 * missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardLayer } from "@fp-pcb/proto";
import { Via, mm, toMm } from "@fp-pcb/client";
import { applyNetlist, edgeClearanceNm, footprintIds, hasOutline, outlineItems, outlineOrigin, type ApplyStage } from "../src/apply";
import { applyBoardConstraints, applyDefaultNetClass, defaultNetClass } from "../src/rules";
import { haveKicad, KICAD_CLI, NETLIST, newProjectWithLibraries, startBareServer, type RunningServer } from "./kicad-server";

if (!haveKicad())
  console.log(`[skip] kicad-cli or qa libraries not found (${KICAD_CLI}); set KICAD_CLI / KICAD_SRC to run the apply integration test`);

describe.skipIf(!haveKicad())("applyNetlist + kicad-cli api-server", () => {
  let server: RunningServer;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fp-pcb-compile-apply-"));
    server = await startBareServer("apply");
  }, 90_000);

  afterAll(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("dry run, outline, import, inset autoplace, DRC-clean edges, save", async () => {
    const { board, projectDir, pcbPath } = await newProjectWithLibraries(server.kicad, root, "full");
    expect(await hasOutline(board)).toBe(false);
    const margin = await edgeClearanceNm(board);
    expect(margin).toBeGreaterThan(0);

    const stages: ApplyStage[] = [];
    const outcome = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      board: { widthMm: 20, heightMm: 10 },
      autoplace: true,
      edgeMarginNm: margin,
      onStage: (s) => stages.push(s),
      date: "2026-09-07T00:00:00.000Z",
    });
    expect(outcome.diagnostics).toEqual([]);
    expect(stages).toEqual(["checking", "outlining", "importing", "placing"]);
    expect(outcome.footprintsAdded).toBe(2);
    expect(outcome.footprintsPlaced).toBe(2);
    expect(await hasOutline(board)).toBe(true);
    expect((await footprintIds(board)).sort()).toEqual([...outcome.addedFootprintIds].sort());

    // the outline moved so every footprint sits at least the edge clearance inside its top/left edges
    expect(outcome.edgeInsetNm).not.toBeNull();
    const origin = (await outlineOrigin(board))!;
    for (const f of await board.getFootprints()) {
      const box = await board.boundingBox(f.id);
      expect(box).toBeDefined();
      expect(box!.x - origin.x).toBeGreaterThanOrEqual(margin - 1);
      expect(box!.y - origin.y).toBeGreaterThanOrEqual(margin - 1);
    }
    const drc = await board.drc.run({ refillZones: true });
    const edge = drc.markers.filter((m) => /edge clearance/i.test(m.description));
    expect(
      edge.map(
        (m) => `${m.description} @ ${toMm(Number(m.position?.xNm ?? 0)).toFixed(2)},${toMm(Number(m.position?.yNm ?? 0)).toFixed(2)}`,
      ),
    ).toEqual([]);
    expect((await board.unroutedCount()).unroutedCount).toBe(2);

    await board.save();
    expect(existsSync(pcbPath)).toBe(true);
    expect(await readFile(pcbPath, "utf8")).toMatch(/^\(kicad_pcb\n\t\(version \d{8}\)/);

    // a second apply of the same netlist changes nothing
    const again = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      autoplace: true,
      edgeMarginNm: margin,
    });
    expect(again.footprintsAdded).toBe(0);
    expect(again.diagnostics).toEqual([]);

    // A manually drawn internal cutout is an independent Edge.Cuts contour. It must survive
    // source-driven replacement of the compiler-owned outer boundary.
    const cutout = outlineItems([
      { x: mm(2), y: mm(2) },
      { x: mm(4), y: mm(2) },
      { x: mm(4), y: mm(4) },
      { x: mm(2), y: mm(4) },
    ]);
    for (const edge of cutout) edge.setCustomProperty("fp-pcb.generated-outline", undefined);
    await board.commit("Test: add manual cutout", (tx) => tx.create(cutout));

    // Source dimensions remain authoritative on rebuild. The compiler owns this outline, so a
    // later size change replaces it instead of reporting success while retaining stale geometry;
    // unrelated manual cutouts remain untouched.
    const resized = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      board: { widthMm: 18, heightMm: 17 },
      autoplace: false,
    });
    expect(resized.diagnostics).toEqual([]);
    const edgeSegments = (await board.getShapes()).filter(
      (shape) => shape.proto.layer === BoardLayer.BL_Edge_Cuts && shape.proto.shape?.geometry.case === "segment",
    );
    expect(edgeSegments).toHaveLength(8);
    const endpoints = edgeSegments.flatMap((shape) => {
      const geometry = shape.proto.shape!.geometry;
      if (geometry.case !== "segment") return [];
      return [geometry.value.start, geometry.value.end].map((point) => [Number(point?.xNm ?? 0), Number(point?.yNm ?? 0)]);
    });
    expect([Math.min(...endpoints.map(([x]) => x!)), Math.max(...endpoints.map(([x]) => x!))]).toEqual([0, mm(18)]);
    expect([Math.min(...endpoints.map(([, y]) => y!)), Math.max(...endpoints.map(([, y]) => y!))]).toEqual([0, mm(17)]);
    const cutoutEndpoints = endpoints.filter(([x, y]) => x! >= mm(2) && x! <= mm(4) && y! >= mm(2) && y! <= mm(4));
    expect(cutoutEndpoints).toHaveLength(8);
  }, 120_000);

  test("a matching manual outline may contain an independent segmented cutout", async () => {
    const { board, projectDir } = await newProjectWithLibraries(server.kicad, root, "manual-cutout");
    const contours = [
      ...outlineItems([
        { x: 0, y: 0 },
        { x: mm(20), y: 0 },
        { x: mm(20), y: mm(10) },
        { x: 0, y: mm(10) },
      ]),
      ...outlineItems([
        { x: mm(2), y: mm(2) },
        { x: mm(4), y: mm(2) },
        { x: mm(4), y: mm(4) },
        { x: mm(2), y: mm(4) },
      ]),
    ];
    for (const edge of contours) edge.setCustomProperty("fp-pcb.generated-outline", undefined);
    await board.commit("Test: add manual contours", (tx) => tx.create(contours));

    const outcome = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      board: { widthMm: 20, heightMm: 10 },
      autoplace: false,
    });
    expect(outcome.diagnostics).toEqual([]);
    expect((await board.getShapes()).filter((shape) => shape.proto.layer === BoardLayer.BL_Edge_Cuts)).toHaveLength(8);
  }, 60_000);

  test("a matching inner contour cannot masquerade as the requested manual board outline", async () => {
    const { board, projectDir } = await newProjectWithLibraries(server.kicad, root, "manual-outer-conflict");
    const contours = [
      ...outlineItems([
        { x: mm(-5), y: mm(-5) },
        { x: mm(25), y: mm(-5) },
        { x: mm(25), y: mm(15) },
        { x: mm(-5), y: mm(15) },
      ]),
      ...outlineItems([
        { x: 0, y: 0 },
        { x: mm(20), y: 0 },
        { x: mm(20), y: mm(10) },
        { x: 0, y: mm(10) },
      ]),
    ];
    for (const edge of contours) edge.setCustomProperty("fp-pcb.generated-outline", undefined);
    await board.commit("Test: add mismatched manual contours", (tx) => tx.create(contours));

    const outcome = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      board: { widthMm: 20, heightMm: 10 },
      autoplace: false,
    });
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["outline_conflict"]);
    expect(outcome.footprintsAdded).toBe(0);
  }, 60_000);

  test("an unresolvable footprint fails the dry run and leaves the board untouched", async () => {
    const { board, projectDir } = await newProjectWithLibraries(server.kicad, root, "missing");
    const outcome = await applyNetlist(
      board,
      { components: [{ ref: "U1", value: "x", footprint: "Nope:Nothing" }], nets: [] },
      { netlistPath: join(projectDir, ".fp-pcb", "compile.net"), board: { widthMm: 20, heightMm: 10 }, autoplace: true },
    );
    expect(outcome.diagnostics).toHaveLength(1);
    expect(outcome.diagnostics[0]).toMatchObject({ severity: "error", code: "import_failed" });
    expect(outcome.diagnostics[0]!.message).toContain("not found");
    expect(await footprintIds(board)).toEqual([]);
    expect(await hasOutline(board)).toBe(false);
  }, 60_000);

  test("compile defaults: a removed component leaves the board, a changed footprint is swapped", async () => {
    const { board, projectDir } = await newProjectWithLibraries(server.kicad, root, "update");
    const netlistPath = join(projectDir, ".fp-pcb", "compile.net");
    await applyNetlist(board, NETLIST, { netlistPath, board: { widthMm: 20, heightMm: 10 }, autoplace: true });
    expect((await board.getFootprints()).map((f) => f.reference).sort()).toEqual(["R1", "R2"]);

    const swapped = await applyNetlist(
      board,
      { components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric" }], nets: [] },
      { netlistPath, autoplace: false },
    );
    expect(swapped.diagnostics).toEqual([]);
    const fps = await board.getFootprints();
    expect(fps.map((f) => f.reference)).toEqual(["R1"]);
    expect(fps[0]!.libraryId).toContain("R_0603_1608Metric");
  }, 60_000);

  test("explicit positions use a prefab blank's fixed frame and omission preserves a manual move", async () => {
    const { board, projectDir } = await newProjectWithLibraries(server.kicad, root, "placed-blank");
    const netlistPath = join(projectDir, ".fp-pcb", "compile.net");
    const outcome = await applyNetlist(board, NETLIST, {
      netlistPath,
      board: {
        widthMm: 30,
        heightMm: 20,
        vias: [{ x: 5, y: 5 }],
        holes: [{ x: 27, y: 3, diameterMm: 2.5 }],
        placements: [
          { ref: "R1", position: { x: 10, y: 8 } },
          { ref: "R2", position: { x: 20, y: 12 } },
        ],
      },
      autoplace: true,
    });
    expect(outcome.diagnostics).toEqual([]);
    expect(outcome.footprintsPlaced).toBe(2);
    expect(await outlineOrigin(board)).toEqual({ x: 0, y: 0 });
    expect(Object.fromEntries((await board.getFootprints()).map((footprint) => [footprint.reference, footprint.position]))).toEqual({
      R1: { x: 10_000_000, y: 8_000_000 },
      R2: { x: 20_000_000, y: 12_000_000 },
    });
    expect((await board.getTracks()).filter((track) => track instanceof Via).map((via) => via.position)).toEqual([
      { x: 5_000_000, y: 5_000_000 },
    ]);

    const r1 = (await board.getFootprints()).find((footprint) => footprint.reference === "R1")!;
    r1.translate({ x: 750_000, y: 500_000 });
    await board.commit("manual move", (tx) => tx.update([r1]));
    const rebuilt = await applyNetlist(board, NETLIST, { netlistPath, autoplace: true });
    expect(rebuilt.footprintsPlaced).toBe(0);
    expect((await board.getFootprints()).find((footprint) => footprint.reference === "R1")!.position).toEqual({
      x: 10_750_000,
      y: 8_500_000,
    });
  }, 120_000);

  test("a blank: free vias and holes are drawn with the outline, which then stays put; rules reach the net class", async () => {
    const { board, projectDir } = await newProjectWithLibraries(server.kicad, root, "blank");
    const spec = { clearanceMm: 0.25, trackWidthMm: 0.3, viaDiameterMm: 1, viaDrillMm: 0.2 };
    // The job's order: constraints before the apply, the net class after it (G29).
    const before = (await board.designRules()).rules.constraints?.copperEdgeClearance?.valueNm;
    expect(await applyBoardConstraints(board, spec)).toHaveLength(4);
    const rules = await board.designRules();
    expect(toMm(Number(rules.rules.constraints?.minTrackWidth?.valueNm ?? 0))).toBeCloseTo(0.3, 6);
    // Constraints the spec does not name keep their values (a partial message would zero them).
    expect(rules.rules.constraints?.copperEdgeClearance?.valueNm).toBe(before);

    const margin = await edgeClearanceNm(board);
    const outcome = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      board: {
        widthMm: 30,
        heightMm: 20,
        rules: { viaDiameterMm: 1, viaDrillMm: 0.2 },
        vias: [
          { x: 5, y: 5 },
          { x: 25, y: 15, diameterMm: 0.8, drillMm: 0.3 },
        ],
        holes: [{ x: 27, y: 3, diameterMm: 2.5 }],
      },
      autoplace: true,
      edgeMarginNm: margin,
    });
    expect(outcome.viasAdded).toBe(2);
    expect(outcome.holesAdded).toBe(1);
    expect(outcome.edgeInsetNm).toBeNull();
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(["prefab_placement"]);
    expect(await outlineOrigin(board)).toEqual({ x: 0, y: 0 });
    const vias = (await board.getTracks()).filter((t): t is Via => t instanceof Via);
    expect(vias).toHaveLength(2);
    expect(vias.every((v) => !v.net)).toBe(true);
    const small = vias.find((v) => toMm(v.position.x) === 25)!;
    expect(toMm(small.diameter)).toBeCloseTo(0.8, 6);
    expect(toMm(small.drillDiameter)).toBeCloseTo(0.3, 6);
    const big = vias.find((v) => toMm(v.position.x) === 5)!;
    expect(toMm(big.diameter)).toBeCloseTo(1, 6);
    const edges = (await board.getShapes()).filter((s) => s.proto.layer === BoardLayer.BL_Edge_Cuts);
    expect(edges).toHaveLength(5);
    expect(edges.filter((s) => s.proto.shape?.geometry.case === "circle")).toHaveLength(1);

    // A second compile sees the outline and leaves the blank alone.
    const again = await applyNetlist(board, NETLIST, {
      netlistPath: join(projectDir, ".fp-pcb", "compile.net"),
      board: { widthMm: 30, heightMm: 20, vias: [{ x: 5, y: 5 }] },
      autoplace: false,
    });
    expect(again.viasAdded).toBe(0);
    expect(again.diagnostics).toEqual([]);
    expect((await board.getTracks()).filter((t) => t instanceof Via)).toHaveLength(2);

    expect(await applyDefaultNetClass(server.kicad, spec)).toHaveLength(4);
    const cls = await defaultNetClass(server.kicad);
    expect(toMm(Number(cls?.board?.trackWidth?.valueNm ?? 0))).toBeCloseTo(0.3, 6);
    expect(toMm(Number(cls?.board?.clearance?.valueNm ?? 0))).toBeCloseTo(0.25, 6);
    expect(toMm(Number(cls?.board?.viaStack?.copperLayers[0]?.size?.xNm ?? 0))).toBeCloseTo(1, 6);
    expect(toMm(Number(cls?.board?.viaStack?.drill?.diameter?.xNm ?? 0))).toBeCloseTo(0.2, 6);
    // G29: a footprint imported after SetNetClasses cannot be autoplaced; the compile warns and goes on.
    const later = await applyNetlist(
      board,
      {
        components: [...NETLIST.components, { ref: "R3", value: "3k3", footprint: "Resistor_SMD:R_0603_1608Metric" }],
        nets: NETLIST.nets.map((n, i) => ({ ...n, nodes: [...n.nodes, { ref: "R3", pin: String(i + 1) }] })),
      },
      { netlistPath: join(projectDir, ".fp-pcb", "compile.net"), autoplace: true },
    );
    expect(later.footprintsAdded).toBe(1);
    expect(later.diagnostics.map((d) => d.code)).toEqual(["autoplace_failed"]);
    expect((await board.getFootprints()).map((f) => f.reference).sort()).toEqual(["R1", "R2", "R3"]);
  }, 120_000);
});
