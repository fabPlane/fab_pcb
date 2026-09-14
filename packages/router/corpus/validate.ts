import type { Vec2 } from "@fp-pcb/client";
import { pointInPolygon, segmentDistance } from "../src/geometry";
import type { NewTrack, NewVia, RouteInput, RoutePad, RouteResult } from "../src/types";

export type CorpusViolation = {
  rule:
    | "invalid_output"
    | "unknown_net"
    | "outside_board"
    | "edge_clearance"
    | "pad_clearance"
    | "tracks_crossing"
    | "track_clearance"
    | "via_pad_clearance"
    | "via_track_clearance"
    | "via_clearance"
    | "hole_clearance";
  detail: string;
};

const finitePoint = (point: Vec2) => Number.isFinite(point.x) && Number.isFinite(point.y);

// Route coordinates are integer nanometres. Scaling the differences to millimetres keeps the
// cross products well inside Number's exact-integer range on ordinary board-sized coordinates.
const orient = (a: Vec2, b: Vec2, c: Vec2) => {
  const scale = 1_000_000;
  return ((b.x - a.x) / scale) * ((c.y - a.y) / scale) - ((b.y - a.y) / scale) * ((c.x - a.x) / scale);
};

const segmentsIntersect = (a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2) => {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    const overlap = (a: number, b: number, c: number, d: number) =>
      Math.max(Math.min(a, b), Math.min(c, d)) <= Math.min(Math.max(a, b), Math.max(c, d));
    return overlap(a1.x, a2.x, b1.x, b2.x) && overlap(a1.y, a2.y, b1.y, b2.y);
  }
  return o1 * o2 <= 0 && o3 * o4 <= 0;
};

const segmentSeparation = (a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2) =>
  segmentsIntersect(a1, a2, b1, b2)
    ? 0
    : Math.min(segmentDistance(a1, b1, b2), segmentDistance(a2, b1, b2), segmentDistance(b1, a1, a2), segmentDistance(b2, a1, a2));

const trackDistance = (a: NewTrack, b: NewTrack) => segmentSeparation(a.start, a.end, b.start, b.end);
const clearanceFor = (input: RouteInput, net: string) => input.rules.perNet.get(net)?.clearance ?? input.rules.default.clearance;
const pairClearance = (input: RouteInput, a: string, b: string) => Math.max(clearanceFor(input, a), clearanceFor(input, b));
const padRadius = (pad: RoutePad) => (pad.shape === "circle" ? pad.size.x / 2 : Math.hypot(pad.size.x, pad.size.y) / 2);

function outlineSegments(input: RouteInput): Array<[Vec2, Vec2]> {
  const segments: Array<[Vec2, Vec2]> = [];
  for (const polygon of input.outline) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      if (start && end) segments.push([start, end]);
    }
  }
  return segments;
}

function insideBoard(input: RouteInput, point: Vec2): boolean {
  const outer = input.outline[0];
  if (!outer) return true;
  return pointInPolygon(point, outer) && !input.outline.slice(1).some((cutout) => pointInPolygon(point, cutout));
}

function pointToBoardEdge(point: Vec2, edges: Array<[Vec2, Vec2]>): number {
  return edges.reduce((distance, [start, end]) => Math.min(distance, segmentDistance(point, start, end)), Number.POSITIVE_INFINITY);
}

function trackToBoardEdge(track: NewTrack, edges: Array<[Vec2, Vec2]>): number {
  return edges.reduce(
    (distance, [start, end]) => Math.min(distance, segmentSeparation(track.start, track.end, start, end)),
    Number.POSITIVE_INFINITY,
  );
}

function validVia(via: NewVia): boolean {
  return (
    finitePoint(via.position) &&
    Number.isFinite(via.diameter) &&
    via.diameter > 0 &&
    Number.isFinite(via.drill) &&
    via.drill > 0 &&
    via.drill < via.diameter &&
    via.layers.length >= 2
  );
}

/** Fast router-output checks. KiCad DRC remains the authoritative integration oracle. */
export function validateRouteOutput(input: RouteInput, result: RouteResult): CorpusViolation[] {
  const violations: CorpusViolation[] = [];
  const nets = new Set(input.nets.map((net) => net.name));
  const edges = outlineSegments(input);

  for (const track of result.tracks) {
    if (!finitePoint(track.start) || !finitePoint(track.end) || !Number.isFinite(track.width) || track.width <= 0)
      violations.push({ rule: "invalid_output", detail: `${track.net}: invalid coordinate or width` });
    if (!nets.has(track.net)) violations.push({ rule: "unknown_net", detail: track.net });
    if (!insideBoard(input, track.start) || !insideBoard(input, track.end))
      violations.push({ rule: "outside_board", detail: `${track.net}: segment endpoint outside outline` });
    if (edges.length && trackToBoardEdge(track, edges) < track.width / 2 + input.rules.edgeClearance)
      violations.push({ rule: "edge_clearance", detail: `${track.net}: track too close to board edge` });
    const clearance = clearanceFor(input, track.net);
    for (const pad of input.pads) {
      if (pad.net === track.net || !pad.layers.includes(track.layer)) continue;
      if (segmentDistance(pad.position, track.start, track.end) < padRadius(pad) + track.width / 2 + clearance)
        violations.push({ rule: "pad_clearance", detail: `${track.net} track vs ${pad.id} (${pad.net})` });
    }
  }

  for (let index = 0; index < result.tracks.length; index++) {
    const a = result.tracks[index]!;
    for (let otherIndex = index + 1; otherIndex < result.tracks.length; otherIndex++) {
      const b = result.tracks[otherIndex]!;
      if (a.net === b.net || a.layer !== b.layer) continue;
      const distance = trackDistance(a, b);
      if (distance === 0) violations.push({ rule: "tracks_crossing", detail: `${a.net} vs ${b.net}` });
      else if (distance < a.width / 2 + b.width / 2 + pairClearance(input, a.net, b.net))
        violations.push({ rule: "track_clearance", detail: `${a.net} vs ${b.net}` });
    }
  }

  for (const via of result.vias) {
    if (!validVia(via)) violations.push({ rule: "invalid_output", detail: `${via.net}: invalid via geometry or layers` });
    if (!nets.has(via.net)) violations.push({ rule: "unknown_net", detail: via.net });
    if (!insideBoard(input, via.position)) violations.push({ rule: "outside_board", detail: `${via.net}: via outside outline` });
    if (edges.length && pointToBoardEdge(via.position, edges) < via.diameter / 2 + input.rules.edgeClearance)
      violations.push({ rule: "edge_clearance", detail: `${via.net}: via too close to board edge` });

    for (const pad of input.pads) {
      if (pad.net === via.net || !pad.layers.some((layer) => via.layers.includes(layer))) continue;
      if (
        Math.hypot(via.position.x - pad.position.x, via.position.y - pad.position.y) <
        via.diameter / 2 + padRadius(pad) + clearanceFor(input, via.net)
      )
        violations.push({ rule: "via_pad_clearance", detail: `${via.net} via vs ${pad.id} (${pad.net})` });
    }
    for (const track of [...input.tracks, ...result.tracks]) {
      if (track.net === via.net || !via.layers.includes(track.layer)) continue;
      if (
        segmentDistance(via.position, track.start, track.end) <
        via.diameter / 2 + track.width / 2 + pairClearance(input, via.net, track.net)
      )
        violations.push({ rule: "via_track_clearance", detail: `${via.net} via vs ${track.net} track` });
    }
  }

  for (let index = 0; index < result.vias.length; index++) {
    const a = result.vias[index]!;
    const otherVias = [...input.vias, ...result.vias.slice(index + 1)];
    for (const b of otherVias) {
      if (!a.layers.some((layer) => b.layers.includes(layer))) continue;
      const distance = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
      if (a.net !== b.net && distance < a.diameter / 2 + b.diameter / 2 + pairClearance(input, a.net, b.net))
        violations.push({ rule: "via_clearance", detail: `${a.net} vs ${b.net}` });
      if (distance < a.drill / 2 + b.drill / 2 + input.rules.holeToHole)
        violations.push({ rule: "hole_clearance", detail: `${a.net} vs ${b.net}` });
    }
  }

  return violations;
}
