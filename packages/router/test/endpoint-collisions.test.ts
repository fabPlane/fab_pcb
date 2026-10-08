import { expect, test } from "bun:test";
import { BoardLayer } from "@fp-pcb/proto";
import { endpointCollisions } from "../src/endpoint-collisions";
import type { RouteInput } from "../src/types";
import { collisionBoard } from "./collision-fixture";

const F = BoardLayer.BL_F_Cu,
  B = BoardLayer.BL_B_Cu;
const mm = (n: number) => n * 1e6;
const probe = (b: RouteInput) => endpointCollisions(b, b.connections);

test("exact pad collision, mm units, identities, honest text and immutable input", () => {
  const b = collisionBoard(),
    before = structuredClone(b);
  const r = probe(b);
  expect(r.collisions).toHaveLength(1);
  expect(r.collisions[0]).toMatchObject({
    endpoint: { uuid: "endpoint", ref: "endpoint", pin: "1", layer: "F.Cu" },
    blocker: { uuid: "blocker", type: "pad", net: "B" },
    requiredClearanceMm: 0.2,
    test: "endpoint-track-width",
  });
  expect(r.collisions[0]!.measuredClearanceMm).toBeCloseTo(0.1);
  expect(r.text).toContain("tested against the board before routing");
  expect(r.text).toContain("does not establish that every escape is blocked");
  expect(b).toEqual(before);
});
test("no collision and same-net neighbour", () => {
  const b = collisionBoard();
  b.pads[2]!.position.x = mm(2);
  expect(probe(b).physicalBlockerEstablished).toBe(false);
  b.pads[2]!.position.x = 0;
  b.pads[2]!.net = "A";
  expect(probe(b).collisions).toEqual([]);
});
test("via collision respects layers and same-net copper", () => {
  const b = collisionBoard();
  b.pads.pop();
  b.vias.push({ id: "via", net: "B", netCode: 2, position: { x: mm(0.4), y: 0 }, diameter: mm(0.4), drill: mm(0.2), layers: [F, B] });
  expect(probe(b).collisions[0]!.blocker).toEqual({ uuid: "via", type: "via", net: "B" });
  b.vias[0]!.layers = [B];
  expect(probe(b).total).toBe(0);
  b.vias[0]!.layers = [F];
  b.vias[0]!.net = "A";
  expect(probe(b).total).toBe(0);
});
test("track capsule collision including zero-length track", () => {
  const b = collisionBoard();
  b.pads.pop();
  b.tracks.push({
    id: "track",
    net: "B",
    netCode: 2,
    start: { x: mm(-2), y: mm(0.3) },
    end: { x: mm(2), y: mm(0.3) },
    width: mm(0.2),
    layer: F,
  });
  expect(probe(b).collisions[0]!.measuredClearanceMm).toBeCloseTo(0.1);
  b.tracks[0]!.start = { ...b.tracks[0]!.end };
  expect(probe(b).total).toBe(0);
  b.tracks[0]!.start = b.tracks[0]!.end = { x: 0, y: mm(0.3) };
  expect(probe(b).total).toBe(1);
});
test("rotated rectangle uses KiCad orientation, not its AABB", () => {
  const b = collisionBoard(),
    p = b.pads[2]!;
  p.shape = "rect";
  p.size = { x: mm(2), y: mm(0.2) };
  p.rotation = 45;
  p.position = { x: mm(0.7), y: mm(-0.7) };
  expect(probe(b).total).toBe(1);
  p.position.y = mm(0.7);
  expect(probe(b).total).toBe(0);
});
test("oval and roundrect rounded corners are not rectangular obstacles", () => {
  const b = collisionBoard(),
    p = b.pads[2]!;
  p.position = { x: mm(1.2), y: mm(0.6) };
  p.size = { x: mm(2), y: mm(1) };
  p.shape = "oval";
  expect(probe(b).total).toBe(0);
  p.position = { x: mm(1.1), y: 0 };
  expect(probe(b).total).toBe(1);
  p.shape = "roundrect";
  p.cornerRadius = mm(0.5);
  p.position = { x: mm(1.2), y: mm(0.6) };
  expect(probe(b).total).toBe(0);
  p.position.y = 0;
  expect(probe(b).total).toBe(1);
  delete p.cornerRadius;
  expect(probe(b).unsupported).toBe(2);
  expect(probe(b).total).toBe(0);
});
test("net-class rules and both pad overrides use the larger rule, clamped to board minimum", () => {
  const b = collisionBoard(),
    p = b.pads[2]!;
  p.position.x = mm(0.9); // 0.3 mm measured clearance
  expect(probe(b).total).toBe(0);
  b.rules.perNet.set("B", { ...b.rules.default, clearance: mm(0.4) });
  expect(probe(b).collisions[0]!.requiredClearanceMm).toBe(0.4);
  p.clearance = mm(0.1);
  expect(probe(b).total).toBe(0);
  b.pads[0]!.clearance = mm(0.5);
  expect(probe(b).collisions[0]!.requiredClearanceMm).toBe(0.5);
  p.position.x = mm(0.65);
  b.pads[0]!.clearance = 0;
  p.clearance = 0;
  expect(probe(b).collisions[0]!.requiredClearanceMm).toBe(0.1);
});
test("custom bounds exclude distant envelopes but never prove occupied copper", () => {
  const b = collisionBoard(),
    p = b.pads[2]!;
  p.shape = "custom";
  p.bounds = { x: mm(-1), y: mm(-1), w: mm(2), h: mm(2) };
  expect(probe(b).unsupported).toBe(1);
  expect(probe(b).total).toBe(0);
  delete p.bounds;
  expect(probe(b).unsupported).toBe(2);
});
test("unsupported offset pads and arc chords are counted once per comparison", () => {
  const b = collisionBoard();
  b.pads[2]!.collisionGeometryUnsupported = true;
  b.tracks.push(
    ...[1, 2].map(() => ({
      id: "arc",
      net: "B",
      netCode: 2,
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      width: mm(0.2),
      layer: F,
      collisionGeometryUnsupported: true,
    })),
  );
  expect(probe(b).unsupported).toBe(4);
  expect(probe(b).total).toBe(0);
});
test("all endpoint copper layers, native pad center, unique probes and cap", () => {
  const b = collisionBoard();
  b.pads[0]!.layers = [F, B];
  b.pads[2]!.layers = [F, B];
  b.connections.push(b.connections[0]!);
  b.connections[0]!.from.position.x = mm(100);
  expect(probe(b).total).toBe(2);
  expect(probe(b).testedEndpoints).toBe(3);
  const p = b.pads[2]!;
  b.pads.push(...Array.from({ length: 20 }, (_, i) => ({ ...p, id: `extra-${i}` })));
  const r = probe(b);
  expect(r.collisions).toHaveLength(24);
  expect(r.total).toBe(42);
  expect(r.truncated).toBe(true);
});
