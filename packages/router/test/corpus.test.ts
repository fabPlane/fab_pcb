import { describe, expect, test } from "bun:test";
import { BoardLayer } from "@fp-pcb/proto";
import { mm } from "@fp-pcb/client";
import { CORPUS } from "../corpus/cases";
import { runCorpus } from "../corpus/run";
import { validateRouteOutput } from "../corpus/validate";
import type { RouteResult } from "../src/types";

describe("corpus output validator", () => {
  const input = CORPUS[0]!.input;
  const result = (tracks: RouteResult["tracks"], vias: RouteResult["vias"] = []): RouteResult => ({
    router: "test",
    tracks,
    vias,
    unrouted: [],
    totalConnections: 0,
    timedOut: false,
    elapsedMs: 0,
    log: [],
  });

  test("does not call separated collinear segments a crossing", () => {
    const violations = validateRouteOutput(
      input,
      result([
        { net: "A", netCode: 1, start: { x: mm(2), y: mm(15) }, end: { x: mm(6), y: mm(15) }, width: mm(0.25), layer: BoardLayer.BL_F_Cu },
        {
          net: "B",
          netCode: 2,
          start: { x: mm(20), y: mm(15) },
          end: { x: mm(25), y: mm(15) },
          width: mm(0.25),
          layer: BoardLayer.BL_F_Cu,
        },
      ]),
    );
    expect(violations.filter((violation) => violation.rule === "tracks_crossing")).toEqual([]);
  });

  test("finds a same-layer crossing", () => {
    const violations = validateRouteOutput(
      input,
      result([
        {
          net: "A",
          netCode: 1,
          start: { x: mm(10), y: mm(10) },
          end: { x: mm(20), y: mm(20) },
          width: mm(0.25),
          layer: BoardLayer.BL_F_Cu,
        },
        {
          net: "B",
          netCode: 2,
          start: { x: mm(20), y: mm(10) },
          end: { x: mm(10), y: mm(20) },
          width: mm(0.25),
          layer: BoardLayer.BL_F_Cu,
        },
      ]),
    );
    expect(violations.some((violation) => violation.rule === "tracks_crossing")).toBe(true);
  });

  test("uses the radius, not the circumscribed square, for circular pads", () => {
    const violations = validateRouteOutput(
      input,
      result([
        {
          net: "B",
          netCode: 2,
          start: { x: mm(3), y: mm(6.2) },
          end: { x: mm(7), y: mm(6.2) },
          width: mm(0.2),
          layer: BoardLayer.BL_F_Cu,
        },
      ]),
    );
    expect(violations.filter((violation) => violation.rule === "pad_clearance")).toEqual([]);
  });

  test("validates output vias against tracks and the board outline", () => {
    const violations = validateRouteOutput(
      input,
      result(
        [
          {
            net: "B",
            netCode: 2,
            start: { x: mm(8), y: mm(10) },
            end: { x: mm(12), y: mm(10) },
            width: mm(0.25),
            layer: BoardLayer.BL_F_Cu,
          },
        ],
        [
          {
            net: "A",
            netCode: 1,
            position: { x: mm(10), y: mm(10) },
            diameter: mm(0.8),
            drill: mm(0.4),
            layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
          },
          {
            net: "A",
            netCode: 1,
            position: { x: mm(-1), y: mm(10) },
            diameter: mm(0.8),
            drill: mm(0.4),
            layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
          },
          {
            net: "B",
            netCode: 2,
            position: { x: mm(10.3), y: mm(10) },
            diameter: mm(0.8),
            drill: mm(0.4),
            layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
          },
          {
            net: "A",
            netCode: 1,
            position: { x: mm(24), y: mm(5) },
            diameter: mm(0.8),
            drill: mm(0.4),
            layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
          },
        ],
      ),
    );
    expect(violations.some((violation) => violation.rule === "via_track_clearance")).toBe(true);
    expect(violations.some((violation) => violation.rule === "via_pad_clearance")).toBe(true);
    expect(violations.some((violation) => violation.rule === "via_clearance")).toBe(true);
    expect(violations.some((violation) => violation.rule === "hole_clearance")).toBe(true);
    expect(violations.some((violation) => violation.rule === "outside_board")).toBe(true);
  });
});

test("router regression corpus", async () => {
  const tier = process.env["ROUTER_CORPUS_TIER"] === "nightly" ? "nightly" : "pr";
  const results = await runCorpus(tier);
  for (const result of results) console.log(`${result.id}: ${result.failures.length ? "FAIL" : "pass"}`, ...result.observations);
  expect(results.flatMap((result) => result.failures.map((failure) => `${result.id}: ${failure}`))).toEqual([]);
}, 420_000);
