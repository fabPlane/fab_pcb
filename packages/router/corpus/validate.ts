import { pointInPolygon, segmentDistance } from "../src/geometry";
import type { NewTrack, RouteInput, RouteResult } from "../src/types";

export type CorpusViolation = {
  rule: "invalid_output" | "unknown_net" | "outside_board" | "pad_clearance" | "tracks_crossing" | "track_clearance";
  detail: string;
};

const finitePoint = (point: { x: number; y: number }) => Number.isFinite(point.x) && Number.isFinite(point.y);
const orient = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const intersects = (a: NewTrack, b: NewTrack) => {
  const o1 = orient(a.start, a.end, b.start);
  const o2 = orient(a.start, a.end, b.end);
  const o3 = orient(b.start, b.end, a.start);
  const o4 = orient(b.start, b.end, a.end);
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    const overlap = (a1: number, a2: number, b1: number, b2: number) =>
      Math.max(Math.min(a1, a2), Math.min(b1, b2)) <= Math.min(Math.max(a1, a2), Math.max(b1, b2));
    return overlap(a.start.x, a.end.x, b.start.x, b.end.x) && overlap(a.start.y, a.end.y, b.start.y, b.end.y);
  }
  return o1 * o2 <= 0 && o3 * o4 <= 0;
};
const trackDistance = (a: NewTrack, b: NewTrack) =>
  intersects(a, b)
    ? 0
    : Math.min(
        segmentDistance(a.start, b.start, b.end),
        segmentDistance(a.end, b.start, b.end),
        segmentDistance(b.start, a.start, a.end),
        segmentDistance(b.end, a.start, a.end),
      );

/** Fast router-output checks. KiCad DRC remains the authoritative integration oracle. */
export function validateRouteOutput(input: RouteInput, result: RouteResult): CorpusViolation[] {
  const violations: CorpusViolation[] = [];
  const nets = new Set(input.nets.map((net) => net.name));
  const outline = input.outline[0];
  for (const track of result.tracks) {
    if (!finitePoint(track.start) || !finitePoint(track.end) || !Number.isFinite(track.width) || track.width <= 0)
      violations.push({ rule: "invalid_output", detail: `${track.net}: invalid coordinate or width` });
    if (!nets.has(track.net)) violations.push({ rule: "unknown_net", detail: track.net });
    if (outline && (!pointInPolygon(track.start, outline) || !pointInPolygon(track.end, outline)))
      violations.push({ rule: "outside_board", detail: `${track.net}: segment endpoint outside outline` });
    const clearance = input.rules.perNet.get(track.net)?.clearance ?? input.rules.default.clearance;
    for (const pad of input.pads) {
      if (pad.net === track.net || !pad.layers.includes(track.layer)) continue;
      const radius = Math.hypot(pad.size.x, pad.size.y) / 2;
      if (segmentDistance(pad.position, track.start, track.end) < radius + track.width / 2 + clearance)
        violations.push({ rule: "pad_clearance", detail: `${track.net} track vs ${pad.id} (${pad.net})` });
    }
  }
  for (let i = 0; i < result.tracks.length; i++) {
    const a = result.tracks[i]!;
    for (let j = i + 1; j < result.tracks.length; j++) {
      const b = result.tracks[j]!;
      if (a.net === b.net || a.layer !== b.layer) continue;
      const distance = trackDistance(a, b);
      if (distance === 0) violations.push({ rule: "tracks_crossing", detail: `${a.net} vs ${b.net}` });
      else {
        const clearance = Math.max(
          input.rules.perNet.get(a.net)?.clearance ?? input.rules.default.clearance,
          input.rules.perNet.get(b.net)?.clearance ?? input.rules.default.clearance,
        );
        if (distance < a.width / 2 + b.width / 2 + clearance) violations.push({ rule: "track_clearance", detail: `${a.net} vs ${b.net}` });
      }
    }
  }
  return violations;
}
