import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { BoardLayer, DrcErrorType, TrackSchema } from "@fp-pcb/proto";
import { Track, type Board } from "@fp-pcb/client";
import { createRouteJobs } from "../src/bridge-job";
import { collisionBoard } from "./collision-fixture";

// A newer native commit can appear while awaiting DRC or ratsnest. Undoing
// that commit would destroy an unrelated edit instead of the tentative route.
for (const path of ["cleanup", "relabel"] as const) {
  for (const foreign of [false, true]) {
    test(`${path} preserves undo ownership (${foreign ? "newer edit" : "owned control"})`, async () => {
      let top = "route";
      let foreignPresent = false;
      let undos = 0;
      let applies = 0;
      let saves = 0;
      const generated = new Track(create(TrackSchema, { id: { value: "generated" } }));
      const board = {
        save: async () => { saves++; },
        getTracks: async () => [],
        undoStack: async () => ({ undo: [{ commitId: { value: top } }], redo: [] }),
        undo: async () => {
          undos++;
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
        drc: { run: async () => {
          if (path === "cleanup") {
            if (foreign) { top = "foreign"; foreignPresent = true; }
            return { markers: [{ errorType: DrcErrorType.DRCET_DANGLING_TRACK, items: [{ value: "generated" }] }] };
          }
          return { markers: [] };
        } },
      } as unknown as Board;
      const jobs = createRouteJobs({
        openBoard: async () => board,
        extract: async () => collisionBoard(),
        capacityRouter: { name: "fab-router", route: async () => ({
          router: "fab-router",
          tracks: [{ net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }],
          vias: [], totalConnections: 1, unrouted: [], timedOut: false, elapsedMs: 1, log: [],
        }) },
        apply: async () => {
          applies++;
          top = "route";
          return { commitId: "route", created: [generated], updated: [], deleted: [], value: [generated] };
        },
      });
      const info = await jobs.wait(jobs.start({ id: "ownership", transport: null }, {
        router: "js", refillZones: false, ...(path === "cleanup" ? { message: "repair" } : {}),
      }).id);
      expect(info.state).toBe(foreign ? "failed" : "done");
      expect(foreignPresent).toBe(foreign);
      expect(undos).toBe(foreign ? 0 : 1);
      expect(applies).toBe(path === "relabel" && !foreign ? 2 : 1);
      if (foreign) {
        expect(info.error).toContain("not at the top of the undo stack");
        expect(info.summary).toBeUndefined();
        expect(saves).toBe(1); // Only the initial save, before applying copper.
      }
    });
  }
}
