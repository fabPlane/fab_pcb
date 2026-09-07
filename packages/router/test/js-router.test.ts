/** The JS router on the synthetic two-net board: input translation, routing, output conversion. */
import { describe, expect, test } from "bun:test";
import { BoardLayer } from "@kicad-web/proto";
import { mm } from "@kicad-web/client";
import { segmentDistance } from "../src/geometry";
import { JsRouter, LayerNames, buildSimpleRouteJson, tracesToItems } from "../src/js-router";
import type { RouteProgress } from "../src/types";
import { twoNetBoard, F, B } from "./fixtures";

describe("buildSimpleRouteJson", () => {
  test("layers, obstacles (inflated), connections and rules in mm", () => {
    const input = twoNetBoard();
    const { srj, layers, notes } = buildSimpleRouteJson(input);
    expect(srj.layerCount).toBe(2);
    expect(layers.name(F)).toBe("top");
    expect(layers.name(B)).toBe("bottom");
    expect(srj.obstacles.length).toBe(5);
    const mid = srj.obstacles.find((o) => o.obstacleId === "m1")!;
    expect(mid.center).toEqual({ x: 15, y: 15 });
    // 3 mm pad + 2 * (clearance 0.2 + width/2 0.125 + safety 0.05)
    expect(mid.width).toBeCloseTo(3.75, 6);
    expect(mid.layers).toEqual(["top", "bottom"]);
    expect(mid.connectedTo).toEqual([]);
    expect(srj.obstacles.find((o) => o.obstacleId === "a1")!.connectedTo).toEqual(["A"]);
    expect(srj.connections.map((c) => c.name).sort()).toEqual(["A", "B"]);
    const a = srj.connections.find((c) => c.name === "A")!;
    expect(a.pointsToConnect.length).toBe(2);
    expect(a.pointsToConnect[0]).toMatchObject({ x: 5, y: 5, layers: ["top", "bottom"] });
    expect(srj.bounds.minX).toBeLessThan(0);
    expect(srj.bounds.maxX).toBeGreaterThan(30);
    expect(srj.outline?.length).toBe(4);
    expect(srj.minViaHoleDiameter).toBeCloseTo(0.4, 6);
    expect(notes).toEqual([]);
  });

  test("a layer filter keeps only those layers and drops points/obstacles that are not on them", () => {
    const input = twoNetBoard();
    input.pads.push({
      ...input.pads[0]!,
      id: "smd",
      net: "",
      netCode: 0,
      layers: [B],
      through: false,
      drill: 0,
      position: { x: mm(2), y: mm(2) },
    });
    const { srj, layers } = buildSimpleRouteJson(input, { layers: [F] });
    expect(layers.count).toBe(1);
    expect(layers.name(F)).toBe("top");
    expect(srj.obstacles.find((o) => o.obstacleId === "smd")).toBeUndefined();
    expect(srj.connections[0]!.pointsToConnect[0]).toMatchObject({ layer: "top" });
  });

  test("names inner layers inner1..n", () => {
    const names = new LayerNames([BoardLayer.BL_B_Cu, BoardLayer.BL_In1_Cu, BoardLayer.BL_F_Cu, BoardLayer.BL_In2_Cu]);
    expect(names.layers.map((l) => names.name(l))).toEqual(["top", "inner1", "inner2", "bottom"]);
    expect(names.layer("inner2")).toBe(BoardLayer.BL_In2_Cu);
  });
});

describe("tracesToItems", () => {
  test("wires become tracks per layer run, vias become through vias, widths come from the net class", () => {
    const input = twoNetBoard();
    const layers = new LayerNames([F, B]);
    const { tracks, vias, routedNets } = tracesToItems(
      [
        {
          connection_name: "A",
          route: [
            { route_type: "wire", x: 5, y: 5, width: 0.45, layer: "top" },
            { route_type: "wire", x: 10, y: 5, width: 0.45, layer: "top" },
            { route_type: "via", x: 10, y: 5, from_layer: "top", to_layer: "bottom" },
            { route_type: "wire", x: 10, y: 5, width: 0.45, layer: "bottom" },
            { route_type: "wire", x: 25, y: 25, width: 0.45, layer: "bottom" },
          ],
        },
      ],
      input,
      layers,
    );
    expect(tracks).toEqual([
      { net: "A", netCode: 1, start: { x: mm(5), y: mm(5) }, end: { x: mm(10), y: mm(5) }, width: mm(0.25), layer: F },
      { net: "A", netCode: 1, start: { x: mm(10), y: mm(5) }, end: { x: mm(25), y: mm(25) }, width: mm(0.25), layer: B },
    ]);
    expect(vias).toEqual([{ net: "A", netCode: 1, position: { x: mm(10), y: mm(5) }, diameter: mm(0.8), drill: mm(0.4), layers: [F, B] }]);
    expect([...routedNets]).toEqual(["A"]);
  });
});

describe("JsRouter", () => {
  test("routes the two crossing nets, reports progress, keeps clear of the other net's pads", async () => {
    const input = twoNetBoard();
    const progress: RouteProgress[] = [];
    const res = await new JsRouter().route(input, { maxTimeMs: 60_000 }, (p) => progress.push(p));
    expect(res.router).toBe("js");
    expect(res.unrouted).toEqual([]);
    expect(res.totalConnections).toBe(2);
    expect(res.timedOut).toBe(false);
    expect(res.tracks.length).toBeGreaterThan(0);
    expect(progress[0]!.phase).toBe("start");
    expect(progress[progress.length - 1]).toMatchObject({ phase: "done", percent: 100, routed: 2, total: 2 });
    // every track is inside the board and on a known layer
    for (const t of res.tracks) {
      expect([F, B]).toContain(t.layer);
      for (const p of [t.start, t.end]) {
        expect(p.x).toBeGreaterThanOrEqual(-mm(0.01));
        expect(p.x).toBeLessThanOrEqual(mm(30.01));
        expect(p.y).toBeGreaterThanOrEqual(-mm(0.01));
        expect(p.y).toBeLessThanOrEqual(mm(30.01));
      }
      expect(t.width).toBe(mm(0.25));
    }
    // tracks of net A keep clearance from B's pads and from the unconnected pad, and vice versa
    const clearance = mm(0.2) + mm(0.25) / 2;
    for (const t of res.tracks) {
      for (const pad of input.pads) {
        if (pad.net === t.net) continue;
        const half = Math.max(pad.size.x, pad.size.y) / 2; // pads here are circles/squares; use the circumscribed radius
        const d = segmentDistance(pad.position, t.start, t.end);
        expect(d, `${t.net} track vs pad ${pad.id}`).toBeGreaterThanOrEqual(half + clearance - mm(0.05));
      }
    }
    // every via is a through via with the class size
    for (const v of res.vias) expect(v).toMatchObject({ diameter: mm(0.8), drill: mm(0.4), layers: [F, B] });
    expect(res.log.some((l) => /nets in \d+ ms/.test(l))).toBe(true);
  }, 60_000);

  test("single-layer routing creates no vias", async () => {
    const res = await new JsRouter().route(twoNetBoard(), { layers: [F], maxTimeMs: 60_000 });
    expect(res.vias).toEqual([]);
    for (const t of res.tracks) expect(t.layer).toBe(F);
  }, 60_000);

  test("a net filter limits the connections to route and the result counts", async () => {
    const input = twoNetBoard();
    input.connections = input.connections.filter((c) => c.net === "A");
    const res = await new JsRouter().route(input, {});
    expect(res.totalConnections).toBe(1);
    expect(res.unrouted).toEqual([]);
    for (const t of res.tracks) expect(t.net).toBe("A");
  }, 60_000);
});

describe("JsRouter cancellation", () => {
  test("an already-aborted signal rejects with RouteCancelled before any solving", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new JsRouter().route(twoNetBoard(), { signal: ac.signal })).rejects.toMatchObject({ name: "RouteCancelled" });
  });

  test("aborting from a progress callback stops the step loop", async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = new JsRouter({ yieldEveryMs: 1 }).route(twoNetBoard(), { signal: ac.signal }, () => {
      if (++calls === 2) ac.abort();
    });
    await expect(p).rejects.toMatchObject({ name: "RouteCancelled" });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThan(20);
  }, 60_000);
});
