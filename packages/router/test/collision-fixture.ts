import { BoardLayer } from "@fp-pcb/proto";
import type { RouteInput, RoutePad } from "../src/types";
const F = BoardLayer.BL_F_Cu,
  B = BoardLayer.BL_B_Cu;
const mm = (n: number) => n * 1e6;
export function collisionBoard(): RouteInput {
  const pad = (id: string, net: string, x: number): RoutePad => ({
    id,
    footprint: id,
    number: "1",
    net,
    netCode: net === "A" ? 1 : 2,
    position: { x: mm(x), y: 0 },
    size: { x: mm(1), y: mm(1) },
    shape: "circle",
    rotation: 0,
    layers: [F],
    through: false,
    drill: 0,
  });
  const rules = { netClass: "Default", clearance: mm(0.2), trackWidth: mm(0.2), viaDiameter: mm(0.6), viaDrill: mm(0.3) };
  return {
    boardName: "synthetic",
    outline: [],
    bounds: { x: 0, y: 0, w: mm(20), h: mm(20) },
    copperLayers: [
      { id: F, name: "BL_F_Cu", userName: "F.Cu", index: 0 },
      { id: B, name: "BL_B_Cu", userName: "B.Cu", index: 1 },
    ],
    nets: [
      { name: "A", code: 1, netClass: "Default" },
      { name: "B", code: 2, netClass: "Default" },
    ],
    pads: [pad("endpoint", "A", 0), pad("target", "A", 10), pad("blocker", "B", 0.7)],
    tracks: [],
    vias: [],
    zones: [],
    keepouts: [],
    obstacles: [],
    connections: [
      {
        net: "A",
        netCode: 1,
        length: mm(10),
        from: { itemId: "endpoint", position: { x: 0, y: 0 }, layers: [F] },
        to: { itemId: "target", position: { x: mm(10), y: 0 }, layers: [F] },
      },
    ],
    rules: {
      default: rules,
      perNet: new Map(),
      minClearance: mm(0.1),
      minTrackWidth: mm(0.1),
      minViaDiameter: mm(0.4),
      minViaDrill: mm(0.2),
      edgeClearance: mm(0.2),
      holeToHole: mm(0.2),
    },
  };
}
