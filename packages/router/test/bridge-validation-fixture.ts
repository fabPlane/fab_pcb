import { create } from "@bufbuild/protobuf";
import { BoardLayer, DrcErrorType, DrcMarkerSchema, RuleSeverity, LockedState, TrackSchema } from "@fp-pcb/proto";
import { Track, type Board } from "@fp-pcb/client";
import { createRouteJobs } from "../src/bridge-job";
import type { RouteResult } from "../src/types";
import { collisionBoard } from "./collision-fixture";

// Stateful commit/undo stand-in: deletion during a later cleanup pass must be
// restored along with removal of the route when native validation is unavailable.
export function validationFixture(
  options: {
    baselineGate?: () => Promise<void>;
    refill?: "valid" | "throws" | "commit-then-throws" | "commit-valid";
    filledMarkers?: "new" | "existing" | "duplicate" | "replacement" | "excluded";
    markerChange?: "position" | "layer" | "item-order";
    baselineStatus?: "warning" | "excluded";
    unfilledErrors?: boolean;
    maskedTrackError?: "new" | "existing";
    danglingSeverity?: RuleSeverity;
    excludedDangling?: "existing" | "generated";
    finalDrcFailure?: boolean;
    finalForeignEdit?: boolean;
    cleanupFirst?: boolean;
    undo?: "zero" | "throws";
    valid?: boolean;
    foreignEdit?: boolean;
    ratsnestFailure?: boolean;
    relabel?: boolean;
    oscillatingCount?: boolean;
  } = {},
) {
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
  let topCommitId = "route-commit";
  let fills = 0;
  const board = {
    refillZones: async () => {
      calls.push("refill");
      if (++fills === 1 || options.refill === "valid") return;
      if (options.refill === "commit-then-throws" || options.refill === "commit-valid") topCommitId = "refill-commit";
      if (options.refill === "commit-valid") return;
      throw new Error("native refill unavailable");
    },
    save: async () => {
      calls.push("save");
    },
    getTracks: async () => copper,
    ratsnest: async () => {
      calls.push("ratsnest");
      if (options.ratsnestFailure) throw new Error("native ratsnest transport unavailable");
      const open = options.relabel && (!options.oscillatingCount || checks % 2 === 1);
      return { edges: open ? [{
        net: "A", netCode: 1, source: "endpoint", target: "target",
        sourcePosition: { x: 0, y: 0 }, targetPosition: { x: 10e6, y: 0 }, length: 10e6,
      }] : [] };
    },
    undoStack: async () => {
      calls.push("undoStack");
      return { undo: [{ commitId: { value: topCommitId } }], redo: [] };
    },
    undo: async () => {
      calls.push("undo");
      if (options.undo === "throws") throw new Error("undo transport unavailable");
      if (options.undo === "zero") return { applied: 0 };
      copper = [...snapshot];
      return { applied: 1 };
    },
    drc: {
      run: async (opts?: { reportAllTrackErrors?: boolean }) => {
        calls.push("drc");
        if (options.maskedTrackError) {
          const clearance = (id: string) => create(DrcMarkerSchema, {
            errorType: DrcErrorType.DRCET_CLEARANCE, severity: RuleSeverity.RS_ERROR,
            items: [{ value: "existing-track" }, { value: id }],
          });
          // Native default reports only the first clearance finding per track.
          return { markers: [clearance("old-neighbour"),
            ...(opts?.reportAllTrackErrors && (options.maskedTrackError === "existing" || copper.includes(generated))
              ? [clearance(options.maskedTrackError === "existing" ? "second-old-neighbour" : "new-route")] : [])] };
        }
        const marker = (item: string, id: string, excluded = false) => create(DrcMarkerSchema, {
          errorType: DrcErrorType.DRCET_STARVED_THERMAL, severity: RuleSeverity.RS_ERROR,
          items: options.markerChange === "item-order"
            ? (id === "before-id" ? ["pad", "track"] : ["track", "pad"]).map(value => ({ value }))
            : [{ value: item }],
          position: { xNm: options.markerChange === "position" && id !== "before-id" ? 1n : 0n, yNm: 0n },
          layer: options.markerChange === "layer" && id !== "before-id" ? BoardLayer.BL_B_Cu : BoardLayer.BL_F_Cu,
          id: { value: id }, excluded,
        });
        if (!copper.includes(generated)) {
          await options.baselineGate?.();
          const baselineMarker = marker("pad", "before-id");
          if (options.baselineStatus === "warning") baselineMarker.severity = RuleSeverity.RS_WARNING;
          if (options.baselineStatus === "excluded") baselineMarker.excluded = true;
          return { markers: options.filledMarkers && options.filledMarkers !== "new" && options.filledMarkers !== "excluded"
            ? [baselineMarker] : [] };
        }
        if ((fills === 2 || options.unfilledErrors) && options.filledMarkers) {
          const kind = options.filledMarkers;
          return { markers: kind === "duplicate" ? [marker("pad", "after-1"), marker("pad", "after-2")]
            : [marker(kind === "replacement" ? "other-pad" : "pad", "after-id", kind === "excluded")] };
        }
        checks++;
        if (options.finalDrcFailure && fills === 2) {
          if (options.finalForeignEdit) {
            copper.push(new Track(create(TrackSchema, { id: { value: "unrelated-edit" }, net: { name: "OTHER" } })));
            topCommitId = "unrelated-commit";
          }
          throw new Error("filled DRC unavailable");
        }
        if (options.danglingSeverity !== undefined) return { markers: copper.some((item) => item.id === "stub") ? [create(DrcMarkerSchema, {
          errorType: DrcErrorType.DRCET_DANGLING_TRACK, severity: options.danglingSeverity,
          items: [{ value: "stub" }],
        })] : [] };
        if (options.excludedDangling) return { markers: [create(DrcMarkerSchema, {
          errorType: DrcErrorType.DRCET_DANGLING_TRACK, severity: RuleSeverity.RS_WARNING, excluded: true,
          items: [{ value: options.excludedDangling === "existing" ? "stub" : generated.id }],
        })] };
        if (options.valid || options.ratsnestFailure || (options.relabel && checks === 1)) return { markers: [] };
        if (options.cleanupFirst && checks === 1)
          return {
            markers: [{ errorType: DrcErrorType.DRCET_DANGLING_TRACK, severity: RuleSeverity.RS_WARNING, items: [{ value: "stub" }] }],
          };
        if (options.foreignEdit) {
          copper.push(new Track(create(TrackSchema, { id: { value: "unrelated-edit" }, net: { name: "OTHER" } })));
          topCommitId = "unrelated-commit";
        }
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
  const job = jobs.start(
    { id: "validation", transport: null },
    {
      router: "js",
      refillZones: !!options.refill,
      ...(options.ratsnestFailure || options.relabel ? {} : { message: "validation regression" }),
      options: { nets: ["A"] },
    },
  );
  const done = jobs.wait(job.id);
  return { done, calls, original, cancel: () => jobs.cancel(job.id), copper: () => copper };
}
