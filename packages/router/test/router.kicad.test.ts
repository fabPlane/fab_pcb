/**
 * Integration: the whole pipeline against a real `kicad-cli api-server` on the ecc83 practice board
 * (extract -> js_autorouter -> one commit -> ratsnest empty -> DRC clean), plus Freerouting through
 * KiCad's Specctra commands when the server has them. Skips without KiCad (see bench/kicad.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BoardLayer, DrcErrorType, RuleSeverity } from "@fp-pcb/proto";
import { Via, mm } from "@fp-pcb/client";
import { KICAD_CLI, fixtureBoards, haveKicad, openFixture, type FixtureBoard, type RunningBoard } from "../bench/kicad";
import {
  DEFAULT_JAR,
  FreeroutingRouter,
  JsAutorouter,
  alreadyApplied,
  applyRouteResult,
  extractRouteInput,
  findJava,
  serverHasSpecctra,
  viaProto,
  type RouteResult,
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

  test("extract -> js_autorouter -> one commit routes every connection without DRC errors", async () => {
    const router = new JsAutorouter();
    const available = await router.available();
    if (!available.ok) {
      console.log(`[skip] ${available.reason}`);
      return;
    }
    const board = run.board;
    await board.refillZones();
    const before = await board.unroutedCount();
    expect(before.unroutedCount).toBeGreaterThan(0);

    const input = await extractRouteInput(board);
    expect(input.copperLayers.length).toBe(2);
    expect(input.outline.length).toBe(1);
    expect(input.pads.length).toBeGreaterThan(20);
    expect(input.connections.length).toBe(before.unroutedCount);

    const res = await router.route(input, { maxTimeMs: 120_000 });
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

  test("applyRouteResult claims a free via: UpdateItems puts it on the net in the same commit", async () => {
    const board = run.board;
    const net = (await board.nets()).find((n) => n.name && (n.code?.value ?? 0) > 0)!;
    const created = await board.commit("free via", (tx) =>
      tx.create([
        new Via(
          viaProto({
            net: "",
            netCode: 0,
            position: { x: mm(120), y: mm(80) },
            diameter: mm(1),
            drill: mm(0.3),
            layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
          }),
        ),
      ]),
    );
    const free = created.created[0] as Via;
    expect(free.net ?? "").toBe("");
    const result: RouteResult = {
      router: "test",
      tracks: [],
      vias: [],
      claimedVias: [{ id: free.id, net: net.name, netCode: net.code?.value ?? 0, position: free.position }],
      unrouted: [],
      totalConnections: 0,
      timedOut: false,
      elapsedMs: 0,
      log: [],
    };
    await applyRouteResult(board, result);
    // GetItems carries the net name; the code is not always echoed back (see extract.ts), so the name is the check.
    const after = (await board.getTracks()).find((t) => t.id === free.id) as Via;
    expect(after.net).toBe(net.name);
    expect((await board.itemsByNet([net.name])).some((i) => i.id === free.id)).toBe(true);
    // Keep the next live test independent: an isolated claimed via is itself an unrouted node.
    await board.commit("remove free via fixture", (tx) => tx.delete([after]));
  }, 60_000);

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
