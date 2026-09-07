/**
 * Integration: the whole pipeline against a real `kicad-cli api-server` on the ecc83 practice board
 * (extract -> JS router -> one commit -> ratsnest empty -> DRC clean), plus Freerouting through
 * KiCad's Specctra commands when the server has them. Skips without KiCad (see bench/kicad.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DrcErrorType, RuleSeverity } from "@fp-pcb/proto";
import { KICAD_CLI, fixtureBoards, haveKicad, openFixture, type FixtureBoard, type RunningBoard } from "../bench/kicad";
import {
  DEFAULT_JAR,
  FreeroutingRouter,
  JsRouter,
  alreadyApplied,
  applyRouteResult,
  extractRouteInput,
  findJava,
  serverHasSpecctra,
} from "../src/index";

const boards = haveKicad() ? await fixtureBoards() : [];
const ecc83: FixtureBoard | undefined = boards.find((b) => b.name === "ecc83");
if (!haveKicad()) console.log(`[skip] kicad-cli not found at ${KICAD_CLI} (set KICAD_CLI to run the router integration tests)`);
else if (!ecc83) console.log("[skip] e2e/fixtures/boards/ecc83/*.unrouted.kicad_pcb not found");

function otherErrors(res: { markers: { errorType: DrcErrorType; severity: RuleSeverity; excluded: boolean }[] }): number {
  return res.markers.filter(
    (m) => !m.excluded && m.severity === RuleSeverity.RS_ERROR && m.errorType !== DrcErrorType.DRCET_UNCONNECTED_ITEMS,
  ).length;
}

describe.skipIf(!ecc83)("router pipeline on ecc83 (real KiCad)", () => {
  let run: RunningBoard;
  beforeAll(async () => {
    run = await openFixture(ecc83!, { prefix: "router-it" });
  });
  afterAll(async () => {
    await run?.stop();
  });

  test("extract -> JsRouter -> one commit routes every connection without DRC errors", async () => {
    const board = run.board;
    await board.refillZones();
    const before = await board.unroutedCount();
    expect(before.unroutedCount).toBeGreaterThan(0);

    const input = await extractRouteInput(board);
    expect(input.copperLayers.length).toBe(2);
    expect(input.outline.length).toBe(1);
    expect(input.pads.length).toBeGreaterThan(20);
    expect(input.connections.length).toBe(before.unroutedCount);

    const res = await new JsRouter().route(input, { maxTimeMs: 120_000 });
    expect(res.unrouted).toEqual([]);
    const applied = await applyRouteResult(board, res);
    expect(applied.created.length).toBe(res.tracks.length + res.vias.length);
    expect(applied.commitId).not.toBe("");

    await board.refillZones();
    expect((await board.unroutedCount()).unroutedCount).toBe(0);
    const drc = await board.drc.run();
    expect(otherErrors(drc)).toBe(0);

    // one commit: undoing back to it (past the zone refills, which push their own entries) takes
    // the whole routing away in one step
    const stack = await board.undoStack();
    const idx = stack.undo
      .map((e) => e.description)
      .lastIndexOf(
        stack.undo
          .map((e) => e.description)
          .filter((d) => /Autoroute/.test(d))
          .pop() ?? "",
      );
    expect(idx).toBeGreaterThanOrEqual(0);
    const undone = await board.undo(stack.undo.length - idx);
    expect(undone.applied).toBe(stack.undo.length - idx);
    expect((await board.getTracks()).length).toBe(0);
  }, 300_000);

  test("Freerouting through the KiCad Specctra commands (or the builtin DSN/SES path) routes the board", async () => {
    const board = run.board;
    if (!existsSync(DEFAULT_JAR) || !findJava()) {
      console.log("[skip] Freerouting jar/java missing");
      return;
    }
    const hasApi = await serverHasSpecctra(board);
    const router = new FreeroutingRouter({ board }, { passes: 20 });
    expect(await router.resolveMode()).toBe(hasApi ? "kicad" : "builtin");
    const input = await extractRouteInput(board);
    const res = await router.route(input, {});
    expect(res.unrouted).toEqual([]);
    if (!alreadyApplied(res)) await applyRouteResult(board, res);
    await board.refillZones();
    expect((await board.unroutedCount()).unroutedCount).toBe(0);
    expect((await board.getTracks()).length).toBeGreaterThan(0);
  }, 300_000);
});
