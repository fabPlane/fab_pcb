import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ArcSchema, BoardLayer, DrcErrorType, LockedState, TrackSchema, ViaSchema } from "@fp-pcb/proto";
import { Arc, Track, Via, toDistance, toVector2, type Board } from "@fp-pcb/client";
import type { RouteInput, RouteResult } from "../src/types";
import { createRouteJobs, persistAppliedRoute, routeGeometry, withoutRejectedCreatedCopper } from "../src/bridge-job";
import { applyRouteResult } from "../src/apply";
import { collisionBoard } from "./collision-fixture";

test("empty routing reports affected endpoints, effective rules and measured blockers before failing", async () => {
  const input = collisionBoard();
  const board = { save: async () => {}, getTracks: async () => [] } as unknown as Board;
  const jobs = createRouteJobs({
    openBoard: async () => board,
    extract: async () => input,
    routers: () => ({
      name: "freerouting",
      route: async () => ({
        router: "freerouting",
        tracks: [],
        vias: [],
        totalConnections: input.connections.length,
        unrouted: input.connections,
        timedOut: false,
        elapsedMs: 1,
        log: ["Auto-routing stage completed: 1 unrouted"],
      }),
    }),
    freerouting: { jar: "/test/router.jar", java: "/test/java", ok: true },
    apply: async () => {
      throw new Error("empty copper must never apply");
    },
  });
  const result = await jobs.wait(jobs.start({ id: "empty-detail", transport: null }, { router: "freerouting", refillZones: false }).id);
  expect(result.state).toBe("failed");
  expect(result.error).toContain("Auto-routing stage completed: 1 unrouted");
  expect(result.error).toContain("Remaining input connections: 1");
  expect(result.error).toContain("clearance");
  expect(result.error).toContain("blocker");
  expect(result.error).toContain("does not prove the board is unroutable");
});

for (const router of ["js", "freerouting"] as const)
  test(`${router} probes native leftover opens after application using pre-route obstacles`, async () => {
    const input = collisionBoard();
    const board = {
      drc: { run: async () => ({ markers: [] }) },
      save: async () => {},
      getTracks: async () => [],
      ratsnest: async () => ({
        edges: input.connections.map((c) => ({
          net: c.net,
          netCode: c.netCode,
          source: c.from.itemId,
          target: c.to.itemId,
          sourcePosition: c.from.position,
          targetPosition: c.to.position,
          length: c.length,
        })),
      }),
    } as unknown as Board;
    const jobs = createRouteJobs({
      openBoard: async () => board,
      extract: async () => input,
      freerouting: { jar: "/test/router.jar", java: "/test/java", ok: true },
      routers: () => ({
        name: router === "js" ? "fab-router" : "freerouting",
        route: async () => ({
          router: router === "js" ? "fab-router" : "freerouting",
          tracks: [{ net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }],
          vias: [],
          totalConnections: 1,
          unrouted: [],
          timedOut: false,
          elapsedMs: 1,
          log: [],
        }),
      }),
      apply: async () => ({ commitId: "commit", created: [], updated: [], deleted: [], value: [] }),
    });
    const info = await jobs.wait(
      jobs.start({ id: "collision-session", transport: null }, { router, refillZones: false, message: "test route" }).id,
    );
    expect(info.state).toBe("done");
    expect(info.summary?.routed).toBe(0); // Native open, despite the solver claiming success.
    expect(info.summary?.endpointCollisions).toMatchObject({ total: 1, physicalBlockerEstablished: true, obstacleSet: "pre-route" });
    expect(info.summary?.endpointCollisions?.collisions[0]?.blocker.uuid).toBe("blocker");
  });

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
    expect(info.summary?.log.some((line) => line.includes("saving the applied route without a fresh fill"))).toBe(true);
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

describe("route summary messages with fab_router diagnostics", () => {
  for (const scenario of ["complete", "no-progress", "native-opens"] as const) {
    test(`${scenario}: keeps diagnostics separate from the successful autoroute message`, async () => {
      const input = collisionBoard();
      const usable = scenario !== "no-progress";
      const edges =
        scenario === "native-opens"
          ? input.connections.map((c) => ({
              net: c.net,
              netCode: c.netCode,
              source: c.from.itemId,
              target: c.to.itemId,
              sourcePosition: c.from.position,
              targetPosition: c.to.position,
              length: c.length,
            }))
          : [];
      const diagnostics: NonNullable<RouteResult["diagnostics"]> = {
        text: `fab_router diagnostic paragraph: ${scenario}`,
        passes: 1,
        stoppedBy: scenario === "complete" ? "complete" : "stagnant",
        solverOpens: { before: 1, after: usable ? 0 : 1 },
        generated: { tracks: usable ? 1 : 0, vias: 0 },
        discarded: { tracks: 0, vias: 0 },
        remaining: { nets: usable ? 0 : 1, opens: usable ? 0 : 1, detail: [] },
        leftoverEndpoints: [],
        leftoverEndpointTotal: 0,
        physicalBlockerEstablished: false,
        collisions: [],
      };
      const result: RouteResult = {
        router: "fab-router",
        tracks: usable
          ? [
              {
                net: "A",
                netCode: 1,
                start: { x: 0, y: 0 },
                end: { x: 1, y: 0 },
                width: 1,
                layer: BoardLayer.BL_F_Cu,
              },
            ]
          : [],
        vias: [],
        unrouted: [],
        totalConnections: 1,
        timedOut: false,
        elapsedMs: 1,
        diagnostics,
        log: [diagnostics.text],
      };
      const commitMessages: string[] = [];
      const board = {
        drc: { run: async () => ({ markers: [] }) },
        save: async () => {},
        getTracks: async () => [],
        undo: async () => ({ applied: 1 }),
        ratsnest: async () => ({ edges }),
      } as unknown as Board;
      const jobs = createRouteJobs({
        openBoard: async () => board,
        extract: async () => input,
        capacityRouter: { name: "fab-router", route: async () => result },
        apply: async (_board, _result, options) => {
          commitMessages.push(options?.message ?? "");
          return { commitId: "commit", created: [], updated: [], deleted: [], value: [] };
        },
      });
      const info = await jobs.wait(jobs.start({ id: "message-session", transport: null }, { router: "js", refillZones: false }).id);
      expect(info.state).toBe("done");
      expect(info.summary?.message).toBe(scenario === "complete" ? "Autoroute (js): 1 connection" : diagnostics.text);
      expect(info.summary?.diagnostics?.text).toBe(diagnostics.text);
      expect(info.summary?.endpointCollisions).toBeDefined();
      expect(info.summary?.log).toContain(diagnostics.text);
      if (scenario === "complete") expect(commitMessages).toEqual(["Autoroute (js): 1 connection"]);
      if (!usable) expect(commitMessages).toEqual([]);
    });
  }
});

test("fab_router prunes and reports pre-existing scoped stubs in the same route commit", async () => {
  const input = collisionBoard();
  const stub = new Track(create(TrackSchema, { id: { value: "old-stub" }, net: { name: "A" } }));
  const outside = new Track(create(TrackSchema, { id: { value: "outside-stub" }, net: { name: "OTHER" } }));
  const locked = new Track(create(TrackSchema, { id: { value: "locked-stub" }, net: { name: "A" }, locked: LockedState.LS_LOCKED }));
  const result: RouteResult = {
    router: "fab-router",
    tracks: [{ net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }],
    vias: [],
    unrouted: [],
    totalConnections: 1,
    timedOut: false,
    elapsedMs: 1,
    log: [],
  };
  let removed: string[] = [];
  let undos = 0;
  const appliedRemovals: string[][] = [];
  const board = {
    save: async () => {},
    getTracks: async () => [stub, outside, locked].filter((t) => !removed.includes(t.id)),
    undo: async () => {
      undos++;
      removed = [];
      return { applied: 1 };
    },
    ratsnest: async () => ({ edges: [] }),
    drc: {
      run: async () => ({
        markers: [stub, outside, locked]
          .filter((t) => !removed.includes(t.id))
          .map((t) => ({ errorType: DrcErrorType.DRCET_DANGLING_TRACK, items: [{ value: t.id }] })),
      }),
    },
  } as unknown as Board;
  const jobs = createRouteJobs({
    openBoard: async () => board,
    extract: async () => input,
    capacityRouter: { name: "fab-router", route: async () => result },
    apply: async (_b, _r, opts) => {
      removed = [...(opts?.removeCopperIds ?? [])];
      appliedRemovals.push([...removed]);
      return { commitId: "commit", created: [], updated: [], deleted: [], value: [] };
    },
  });
  const info = await jobs.wait(
    jobs.start({ id: "stub-session", transport: null }, { router: "js", options: { nets: ["A"] }, refillZones: false, message: "repair" })
      .id,
  );
  expect(info.state).toBe("done");
  expect(appliedRemovals).toEqual([[], ["old-stub"]]);
  expect(undos).toBe(1);
  expect(info.summary?.retainedDanglingCopper).toEqual([{ id: "locked-stub", net: "A", reason: "locked" }]);
  expect(info.summary?.message).toContain("route is not native-clean");
  expect(info.summary?.removedExistingCopper).toEqual([{ id: "old-stub", net: "A" }]);
  expect(info.summary?.log.join("\n")).toContain("old-stub");
  expect((await board.getTracks()).map((t) => t.id)).toEqual(["outside-stub", "locked-stub"]);
});

test("native route application deletes reported stubs and creates replacement copper in one strict commit", async () => {
  const calls: string[] = [];
  const board = {
    commit: async (_message: string, action: (tx: any) => Promise<any>, _scope: unknown, opts: any) => {
      calls.push("begin");
      expect(opts.strict).toBe(true);
      const value = await action({
        delete: async (ids: string[]) => {
          expect(ids).toEqual(["old-stub"]);
          calls.push("delete");
        },
        create: async (items: any[]) => {
          expect(items).toHaveLength(1);
          calls.push("create");
          return items;
        },
      });
      calls.push("end");
      return { created: value };
    },
  } as unknown as Board;
  await applyRouteResult(
    board,
    {
      router: "fab-router",
      tracks: [{ net: "A", netCode: 1, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 1, layer: BoardLayer.BL_F_Cu }],
      vias: [],
      unrouted: [],
      totalConnections: 1,
      timedOut: false,
      elapsedMs: 1,
      log: [],
    },
    { removeCopperIds: ["old-stub"] },
  );
  expect(calls).toEqual(["begin", "delete", "create", "end"]);
});
