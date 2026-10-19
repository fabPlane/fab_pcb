import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BoardLayer, DrcErrorType, RuleSeverity, TrackSchema } from "@fp-pcb/proto";
import { Track, type Board } from "@fp-pcb/client";
import { createRouteJobs } from "../src/bridge-job";
import { collisionBoard } from "./collision-fixture";

// A newer native commit can appear while awaiting DRC or ratsnest. Undoing
// that commit would destroy an unrelated edit instead of the tentative route.
for (const path of ["cleanup", "relabel"] as const) {
  for (const state of ["owned", "foreign", "history-error", "undo-error"] as const) {
    const foreign = state === "foreign";
    const failed = state !== "owned";
    test(`${path} preserves undo ownership (${state})`, async () => {
      let top = "route";
      let foreignPresent = false;
      let undos = 0;
      let applies = 0;
      let saves = 0;
      const generated = new Track(create(TrackSchema, { id: { value: "generated" } }));
      const board = {
        save: async () => {
          saves++;
        },
        getTracks: async () => [],
        undoStack: async () => {
          if (state === "history-error") throw new Error("history transport unavailable");
          return { undo: [{ commitId: { value: top } }], redo: [] };
        },
        undo: async () => {
          undos++;
          if (state === "undo-error") throw new Error("undo transport unavailable");
          if (top === "foreign") foreignPresent = false;
          return { applied: 1 };
        },
        ratsnest: async () => {
          if (path === "relabel" && foreign && applies === 1) {
            top = "foreign";
            foreignPresent = true;
          }
          return { edges: collisionBoard().connections };
        },
        drc: {
          run: async () => {
            if (path === "cleanup") {
              if (foreign) {
                top = "foreign";
                foreignPresent = true;
              }
              return {
                markers: [
                  { errorType: DrcErrorType.DRCET_DANGLING_TRACK, severity: RuleSeverity.RS_WARNING, items: [{ value: "generated" }] },
                ],
              };
            }
            return { markers: [] };
          },
        },
      } as unknown as Board;
      const jobs = createRouteJobs({
        openBoard: async () => board,
        extract: async () => collisionBoard(),
        capacityRouter: {
          name: "fab-router",
          route: async () => ({
            router: "fab-router",
            tracks: [{ net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }],
            vias: [],
            totalConnections: 1,
            unrouted: [],
            timedOut: false,
            elapsedMs: 1,
            log: [],
          }),
        },
        apply: async () => {
          applies++;
          top = "route";
          return { commitId: "route", created: [generated], updated: [], deleted: [], value: [generated] };
        },
      });
      const info = await jobs.wait(
        jobs.start(
          { id: "ownership", transport: null },
          {
            router: "js",
            refillZones: false,
            ...(path === "cleanup" ? { message: "repair" } : {}),
          },
        ).id,
      );
      expect(info.state).toBe(failed ? "failed" : "done");
      expect(foreignPresent).toBe(foreign);
      expect(undos).toBe(foreign || state === "history-error" ? 0 : 1);
      expect(applies).toBe(path === "relabel" && !failed ? 2 : 1);
      if (failed) {
        if (foreign) expect(info.error).toContain("not at the top of the undo stack");
        if (state.endsWith("-error"))
          expect(info.error).toContain(state === "history-error" ? "history transport unavailable" : "undo transport unavailable");
        expect(info.error).toContain("tentative route may remain in KiCad memory");
        expect(info.summary).toBeUndefined();
        expect(saves).toBe(1); // Only the initial save, before applying copper.
      }
    });
  }
}
