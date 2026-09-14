import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ArcSchema, BoardLayer, TrackSchema, ViaSchema } from "@fp-pcb/proto";
import { Arc, Track, Via, toDistance, toVector2 } from "@fp-pcb/client";
import { persistAppliedRoute, routeGeometry } from "../src/bridge-job";

describe("persistAppliedRoute", () => {
  test("saves a route after it has been applied", async () => {
    let saves = 0;
    await persistAppliedRoute({
      async save() {
        saves++;
      },
    });
    expect(saves).toBe(1);
  });

  test("explains that an applied route remains only in memory when saving fails", async () => {
    const failure = new Error("disk full");
    const saving = persistAppliedRoute({
      async save() {
        throw failure;
      },
    });
    await expect(saving).rejects.toThrow(
      "route was applied in KiCad memory but SaveDocument failed; retry saving before closing the session: disk full",
    );
    await expect(saving).rejects.toMatchObject({ cause: failure });
  });
});

describe("routeGeometry", () => {
  test("serializes traces, arcs and vias without losing KiCad identity or units", () => {
    const track = new Track(
      create(TrackSchema, {
        id: { value: "track-1" },
        start: toVector2({ x: 1, y: 2 }),
        end: toVector2({ x: 3, y: 4 }),
        width: toDistance(5),
        layer: BoardLayer.BL_F_Cu,
        net: { name: "N", code: { value: 7 } },
      }),
    );
    const arc = new Arc(
      create(ArcSchema, {
        id: { value: "arc-1" },
        start: toVector2({ x: 10, y: 20 }),
        mid: toVector2({ x: 15, y: 25 }),
        end: toVector2({ x: 20, y: 20 }),
        width: toDistance(6),
        layer: BoardLayer.BL_B_Cu,
        net: { name: "M", code: { value: 8 } },
      }),
    );
    const via = new Via(
      create(ViaSchema, {
        id: { value: "via-1" },
        position: toVector2({ x: 100, y: 200 }),
        net: { name: "N", code: { value: 7 } },
        padStack: { copperLayers: [{ size: toVector2({ x: 20, y: 20 }) }] },
      }),
    );

    expect(routeGeometry([track, arc, via])).toEqual([
      { kind: "trace", id: "track-1", layer: BoardLayer.BL_F_Cu, net: 7, points: [1, 2, 3, 4], width: 5 },
      { kind: "trace", id: "arc-1", layer: BoardLayer.BL_B_Cu, net: 8, points: [10, 20, 15, 25, 20, 20], width: 6 },
      { kind: "via", id: "via-1", layer: -1, net: 7, points: [90, 190, 110, 210] },
    ]);
  });
});
