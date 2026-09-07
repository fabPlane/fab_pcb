/** Hand-written `RouteInput`s for the unit tests: a tiny two-layer board with two crossing nets. */
import { BoardLayer } from "@fp-pcb/proto";
import { mm } from "@fp-pcb/client";
import type { RouteConnection, RouteInput, RoutePad } from "../src/types";

export const F = BoardLayer.BL_F_Cu;
export const B = BoardLayer.BL_B_Cu;

function pad(id: string, footprint: string, number: string, net: string, netCode: number, x: number, y: number, through = true): RoutePad {
  return {
    id,
    footprint,
    number,
    net,
    netCode,
    position: { x: mm(x), y: mm(y) },
    size: { x: mm(1.6), y: mm(1.6) },
    shape: "circle",
    rotation: 0,
    layers: through ? [F, B] : [F],
    through,
    drill: through ? mm(0.8) : 0,
  };
}

function conn(a: RoutePad, b: RoutePad): RouteConnection {
  return {
    net: a.net,
    netCode: a.netCode,
    from: { itemId: a.id, position: a.position, layers: a.layers },
    to: { itemId: b.id, position: b.position, layers: b.layers },
    length: Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y),
  };
}

/**
 * 30 x 30 mm board, two through-hole nets on the diagonals (A: top-left to bottom-right, B: the
 * other diagonal) and an unconnected 3 x 3 mm pad in the middle they must avoid. Routable on one
 * layer (around the outside) or on two (one via).
 */
export function twoNetBoard(): RouteInput {
  const a1 = pad("a1", "R1", "1", "A", 1, 5, 5);
  const a2 = pad("a2", "R2", "1", "A", 1, 25, 25);
  const b1 = pad("b1", "R3", "1", "B", 2, 25, 5);
  const b2 = pad("b2", "R4", "1", "B", 2, 5, 25);
  const mid: RoutePad = { ...pad("m1", "J1", "1", "", 0, 15, 15), size: { x: mm(3), y: mm(3) }, shape: "rect" };
  const rules = { netClass: "Default", clearance: mm(0.2), trackWidth: mm(0.25), viaDiameter: mm(0.8), viaDrill: mm(0.4) };
  return {
    boardName: "two-net.kicad_pcb",
    outline: [
      [
        { x: 0, y: 0 },
        { x: mm(30), y: 0 },
        { x: mm(30), y: mm(30) },
        { x: 0, y: mm(30) },
      ],
    ],
    bounds: { x: 0, y: 0, w: mm(30), h: mm(30) },
    copperLayers: [
      { id: F, name: "BL_F_Cu", userName: "F.Cu", index: 0 },
      { id: B, name: "BL_B_Cu", userName: "B.Cu", index: 1 },
    ],
    nets: [
      { name: "A", code: 1, netClass: "Default" },
      { name: "B", code: 2, netClass: "Default" },
    ],
    pads: [a1, a2, b1, b2, mid],
    tracks: [],
    vias: [],
    keepouts: [],
    zones: [],
    obstacles: [],
    connections: [conn(a1, a2), conn(b1, b2)],
    rules: {
      minClearance: mm(0.1),
      minTrackWidth: mm(0.1),
      minViaDiameter: mm(0.4),
      minViaDrill: mm(0.2),
      edgeClearance: mm(0.2),
      holeToHole: mm(0.25),
      default: rules,
      perNet: new Map([
        ["A", rules],
        ["B", rules],
      ]),
    },
  };
}
