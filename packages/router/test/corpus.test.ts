import { describe, expect, test } from "bun:test";
import { BoardLayer } from "@fp-pcb/proto";
import { mm } from "@fp-pcb/client";
import { CORPUS } from "../corpus/cases";
import { runCorpus } from "../corpus/run";
import { validateRouteOutput } from "../corpus/validate";
import type { RouteResult } from "../src/types";

describe("corpus output validator", () => {
  const input = CORPUS[0]!.input;
  const result = (tracks: RouteResult["tracks"]): RouteResult => ({
    router: "test",
    tracks,
    vias: [],
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
});

test("router regression corpus", async () => {
  const tier = process.env["ROUTER_CORPUS_TIER"] === "nightly" ? "nightly" : "pr";
  const results = await runCorpus(tier);
  for (const result of results) console.log(`${result.id}: ${result.failures.length ? "FAIL" : "pass"}`, ...result.observations);
  expect(results.flatMap((result) => result.failures.map((failure) => `${result.id}: ${failure}`))).toEqual([]);
}, 420_000);
