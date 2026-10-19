import { create } from "@bufbuild/protobuf";
import { BoardLayer, DrcErrorType, LockedState, TrackSchema } from "@fp-pcb/proto";
import { Track, type Board } from "@fp-pcb/client";
import { createRouteJobs } from "../src/bridge-job";
import type { RouteResult } from "../src/types";
import { collisionBoard } from "./collision-fixture";

// Stateful commit/undo stand-in: deletion during a later cleanup pass must be
// restored along with removal of the route when native validation is unavailable.
export function validationFixture(options: { cleanupFirst?: boolean; undo?: "zero" | "throws"; valid?: boolean } = {}) {
  const original = [
    new Track(create(TrackSchema, { id: { value: "stub" }, net: { name: "A" } })),
    new Track(create(TrackSchema, { id: { value: "protected" }, net: { name: "A" }, locked: LockedState.LS_LOCKED })),
    new Track(create(TrackSchema, { id: { value: "other-net" }, net: { name: "OTHER" } })),
  ];
  const generated = new Track(create(TrackSchema, { id: { value: "new-route" }, net: { name: "A" } }));
  let copper = [...original];
  let snapshot = [...original];
  const calls: string[] = [];
  let checks = 0;
  const board = {
    save: async () => {
      calls.push("save");
    },
    getTracks: async () => copper,
    ratsnest: async () => {
      calls.push("ratsnest");
      return { edges: [] };
    },
    undo: async () => {
      calls.push("undo");
      if (options.undo === "throws") throw new Error("undo transport unavailable");
      if (options.undo === "zero") return { applied: 0 };
      copper = [...snapshot];
      return { applied: 1 };
    },
    drc: {
      run: async () => {
        calls.push("drc");
        checks++;
        if (options.valid) return { markers: [] };
        if (options.cleanupFirst && checks === 1)
          return {
            markers: [{ errorType: DrcErrorType.DRCET_DANGLING_TRACK, items: [{ value: "stub" }] }],
          };
        throw new Error("native DRC transport unavailable");
      },
    },
  } as unknown as Board;
  const result: RouteResult = {
    router: "fab-router",
    tracks: [{ net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }],
    vias: [],
    totalConnections: 1,
    unrouted: [],
    timedOut: false,
    elapsedMs: 1,
    log: [],
  };
  const jobs = createRouteJobs({
    openBoard: async () => board,
    extract: async () => collisionBoard(),
    capacityRouter: { name: "fab-router", route: async () => result },
    apply: async (_board, _result, opts) => {
      calls.push("apply");
      snapshot = [...copper];
      copper = [...copper.filter((item) => !opts?.removeCopperIds?.includes(item.id)), generated];
      return { commitId: "route-commit", created: [generated], updated: [], deleted: [], value: [generated] };
    },
  });
  const done = jobs.wait(
    jobs.start(
      { id: "validation", transport: null },
      {
        router: "js",
        refillZones: false,
        message: "validation regression",
        options: { nets: ["A"] },
      },
    ).id,
  );
  return { done, calls, original, copper: () => copper };
}
