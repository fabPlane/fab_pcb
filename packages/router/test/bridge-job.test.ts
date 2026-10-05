import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ArcSchema, BoardLayer, TrackSchema, ViaSchema } from "@fp-pcb/proto";
import { Arc, Track, Via, toDistance, toVector2, type Board } from "@fp-pcb/client";
import type { RouteInput, RouteResult } from "../src/types";
import { createRouteJobs, persistAppliedRoute, routeGeometry, withoutRejectedCreatedCopper } from "../src/bridge-job";

function routeJobFixture(options: { refillZones?: boolean; failSecondRefill?: boolean; appliesCopper?: boolean } = {}) {
  const calls: string[] = [];
  let refills = 0;
  const board = {
    async refillZones() {
      calls.push("refill");
      refills++;
      if (options.failSecondRefill && refills === 2) throw new Error("zone filler unavailable");
    },
    async save() {
      calls.push("save");
    },
    async getTracks() {
      calls.push("getTracks");
      return [];
    },
    async ratsnest() {
      calls.push("ratsnest");
      return { unroutedCount: 0, edges: [] };
    },
  } as unknown as Board;
  const appliesCopper = options.appliesCopper ?? true;
  const result: RouteResult = {
    router: "test-router",
    tracks: appliesCopper
      ? [{ net: "N", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }]
      : [],
    vias: [],
    unrouted: [],
    totalConnections: appliesCopper ? 1 : 0,
    timedOut: false,
    elapsedMs: 1,
    log: [],
  };
  const jobs = createRouteJobs({
    openBoard: async () => board,
    extract: async () => {
      calls.push("extract");
      return { pads: [], connections: [], copperLayers: [] } as unknown as RouteInput;
    },
    capacityRouter: {
      name: "test-router",
      async route() {
        calls.push("route");
        return result;
      },
    },
    apply: async () => {
      calls.push("apply");
      return { commitId: "commit-1", created: [], updated: [], deleted: [], value: [] };
    },
  });
  const info = jobs.start(
    { id: "test-session", transport: null },
    { router: "js", ...(options.refillZones === undefined ? {} : { refillZones: options.refillZones }) },
  );
  return { calls, done: jobs.wait(info.id) };
}

describe("route job zone refills", () => {
  test("refills before routing and after the apply, before the final save and re-measure", async () => {
    const { calls, done } = routeJobFixture();
    const info = await done;
    expect(info.state).toBe("done");
    expect(info.zoneRefill).toEqual({ before: true, after: true });
    expect(calls).toEqual(["refill", "save", "getTracks", "extract", "route", "apply", "refill", "save", "ratsnest", "getTracks"]);
  });

  test("refillZones false skips both zone refills", async () => {
    const { calls, done } = routeJobFixture({ refillZones: false });
    const info = await done;
    expect(info.state).toBe("done");
    expect(info.zoneRefill).toEqual({ before: false, after: false });
    expect(calls).not.toContain("refill");
  });

  test("a post-apply refill failure is reported without failing or losing the saved route", async () => {
    const { calls, done } = routeJobFixture({ failSecondRefill: true });
    const info = await done;
    expect(info.state).toBe("done");
    expect(info.zoneRefill).toEqual({ before: true, after: false, error: "zone filler unavailable" });
    expect(info.summary?.log.at(-1)).toContain("saving the applied route without a fresh fill");
    expect(calls.slice(calls.indexOf("apply"))).toEqual(["apply", "refill", "save", "ratsnest", "getTracks"]);
  });

  test("a route that applies no copper does not run the post-apply refill", async () => {
    const { calls, done } = routeJobFixture({ appliesCopper: false });
    const info = await done;
    expect(info.state).toBe("done");
    expect(info.zoneRefill).toEqual({ before: true, after: false });
    expect(calls.filter((call) => call === "refill")).toHaveLength(1);
    expect(calls).not.toContain("apply");
  });
});

test("the stable capacity slot uses fab_router", async () => {
  const freerouting = { jar: "/missing/router.jar", java: "/missing/java", ok: false as const, reason: "test" };
  expect((await createRouteJobs({ freerouting }).capacityRouter()).name).toBe("fab-router");
});

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
      { kind: "trace", id: "track-1", layer: BoardLayer.BL_F_Cu, net: 7, netName: "N", points: [1, 2, 3, 4], width: 5 },
      { kind: "trace", id: "arc-1", layer: BoardLayer.BL_B_Cu, net: 8, netName: "M", points: [10, 20, 15, 25, 20, 20], width: 6 },
      { kind: "via", id: "via-1", layer: -1, net: 7, netName: "N", points: [90, 190, 110, 210] },
    ]);
  });
});

test("withoutRejectedCreatedCopper maps rejected KiCad ids back to generated copper", () => {
  const result = {
    router: "fab-router",
    tracks: [
      { net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, width: 1, layer: BoardLayer.BL_F_Cu },
      { net: "B", netCode: 2, start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, width: 1, layer: BoardLayer.BL_B_Cu },
    ],
    vias: [{ net: "B", netCode: 2, position: { x: 1, y: 1 }, diameter: 2, drill: 1, layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu] }],
    unrouted: [],
    totalConnections: 2,
    timedOut: false,
    elapsedMs: 1,
    log: [],
  };
  const created = [
    new Track(create(TrackSchema, { id: { value: "keep" } })),
    new Track(create(TrackSchema, { id: { value: "reject-track" } })),
    new Via(create(ViaSchema, { id: { value: "reject-via" } })),
  ];
  const clean = withoutRejectedCreatedCopper(result, created, new Set(["reject-track", "reject-via"]));
  expect(clean.tracks.map((track) => track.net)).toEqual(["A"]);
  expect(clean.vias).toEqual([]);
});

test("route geometry resolves native name-only net records through the extracted net table", () => {
  const track = new Track(create(TrackSchema, { id: { value: "native-track" }, net: { name: "SIGNAL" }, layer: BoardLayer.BL_F_Cu }));
  const via = new Via(
    create(ViaSchema, {
      id: { value: "native-via" },
      net: { name: "GND" },
      padStack: { copperLayers: [{ size: toVector2({ x: 600000, y: 600000 }) }] },
    }),
  );
  const geometry = routeGeometry(
    [track, via],
    new Map([
      ["SIGNAL", 13],
      ["GND", 2],
    ]),
  );
  expect(geometry.map(({ net, netName }) => ({ net, netName }))).toEqual([
    { net: 13, netName: "SIGNAL" },
    { net: 2, netName: "GND" },
  ]);
});
