import { BoardLayer } from "@fp-pcb/proto";
import { mm } from "@fp-pcb/client";
import type { RouteConnection, RouteInput, RoutePad, RouteRules } from "../src/types";

export type CorpusTier = "pr" | "nightly";

export interface CorpusCase {
  id: string;
  tier: CorpusTier;
  quality: "gate" | "observe";
  maxTimeMs: number;
  hardTimeoutMs: number;
  requireAllRouted: boolean;
  input: RouteInput;
}

const F = BoardLayer.BL_F_Cu;
const B = BoardLayer.BL_B_Cu;
const netRules = {
  netClass: "Default",
  clearance: mm(0.2),
  trackWidth: mm(0.25),
  viaDiameter: mm(0.8),
  viaDrill: mm(0.4),
};
const rules: RouteRules = {
  minClearance: mm(0.1),
  minTrackWidth: mm(0.1),
  minViaDiameter: mm(0.4),
  minViaDrill: mm(0.2),
  edgeClearance: mm(0.2),
  holeToHole: mm(0.25),
  default: netRules,
  perNet: new Map(),
};

function pad(id: string, net: string, netCode: number, x: number, y: number, size = 1.6, through = true): RoutePad {
  return {
    id,
    footprint: id.split("-")[0]!,
    number: id.split("-")[1] ?? "1",
    net,
    netCode,
    position: { x: mm(x), y: mm(y) },
    size: { x: mm(size), y: mm(size) },
    shape: through ? "circle" : "rect",
    rotation: 0,
    layers: through ? [F, B] : [F],
    through,
    drill: through ? mm(0.8) : 0,
  };
}

function connection(from: RoutePad, to: RoutePad): RouteConnection {
  return {
    net: from.net,
    netCode: from.netCode,
    from: { itemId: from.id, position: from.position, layers: from.layers },
    to: { itemId: to.id, position: to.position, layers: to.layers },
    length: Math.hypot(from.position.x - to.position.x, from.position.y - to.position.y),
  };
}

function board(name: string, width: number, height: number, pads: RoutePad[]): RouteInput {
  const connections: RouteConnection[] = [];
  const byNet = new Map<string, RoutePad[]>();
  for (const p of pads) byNet.set(p.net, [...(byNet.get(p.net) ?? []), p]);
  for (const endpoints of byNet.values()) {
    for (let i = 1; i < endpoints.length; i++) connections.push(connection(endpoints[i - 1]!, endpoints[i]!));
  }
  return {
    boardName: name,
    outline: [
      [
        { x: 0, y: 0 },
        { x: mm(width), y: 0 },
        { x: mm(width), y: mm(height) },
        { x: 0, y: mm(height) },
      ],
    ],
    bounds: { x: 0, y: 0, w: mm(width), h: mm(height) },
    copperLayers: [
      { id: F, name: "BL_F_Cu", userName: "F.Cu", index: 0 },
      { id: B, name: "BL_B_Cu", userName: "B.Cu", index: 1 },
    ],
    nets: [...byNet.keys()].map((name, index) => ({ name, code: index + 1, netClass: "Default" })),
    pads,
    tracks: [],
    vias: [],
    keepouts: [],
    zones: [],
    obstacles: [],
    connections,
    rules: { ...rules, perNet: new Map([...byNet.keys()].map((name) => [name, netRules])) },
  };
}

function crossingSmoke(): RouteInput {
  return board("crossing-smoke", 30, 30, [
    pad("J1-1", "A", 1, 5, 5),
    pad("J2-1", "A", 1, 25, 25),
    pad("J3-1", "B", 2, 25, 5),
    pad("J4-1", "B", 2, 5, 25),
  ]);
}

function finePitchFanout(): RouteInput {
  const pads: RoutePad[] = [];
  for (let i = 0; i < 8; i++) {
    const net = `USB_${i + 1}`;
    pads.push(pad(`U1-${i + 1}`, net, i + 1, 8, 8.25 + i * 0.5, 0.3, false));
    pads.push(pad(`J1-${i + 1}`, net, i + 1, 28, 5 + i * 2, 1.2));
  }
  return board("fine-pitch-fanout", 36, 24, pads);
}

function coarseParallelBus(): RouteInput {
  const pads: RoutePad[] = [];
  for (let i = 0; i < 16; i++) {
    const net = `D${i}`;
    pads.push(pad(`J1-${i + 1}`, net, i + 1, 5, 8 + i * 2.54));
    pads.push(pad(`J2-${i + 1}`, net, i + 1, 75, 8 + i * 2.54));
  }
  return board("coarse-parallel-bus", 80, 55, pads);
}

export const CORPUS: CorpusCase[] = [
  {
    id: "crossing-smoke",
    tier: "pr",
    quality: "gate",
    maxTimeMs: 60_000,
    hardTimeoutMs: 75_000,
    requireAllRouted: true,
    input: crossingSmoke(),
  },
  {
    id: "fine-pitch-fanout",
    tier: "nightly",
    quality: "observe",
    maxTimeMs: 120_000,
    hardTimeoutMs: 135_000,
    requireAllRouted: false,
    input: finePitchFanout(),
  },
  {
    id: "coarse-parallel-bus",
    tier: "nightly",
    quality: "observe",
    maxTimeMs: 120_000,
    hardTimeoutMs: 135_000,
    requireAllRouted: false,
    input: coarseParallelBus(),
  },
];

export function corpusCases(tier: CorpusTier): CorpusCase[] {
  return CORPUS.filter((testCase) => tier === "nightly" || testCase.tier === "pr");
}
