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
import { toMm } from "@fp-pcb/client";
import { applyNetlist, edgeClearanceNm, footprintIds, hasOutline, outlineOrigin, type ApplyStage } from "../src/apply";
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
  }, 120_000);

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
});
