/** Small geometry helpers shared by the extractor and the adapters. All lengths in nm. */
import type { Box, Vec2 } from "@fp-pcb/client";
import { boxFromPoints, vecRotate } from "@fp-pcb/client";
import type { RoutePolygon } from "./types";

/** An open polyline (segment or arc end points) on Edge.Cuts, before chaining. */
export interface OutlinePiece {
  points: Vec2[];
  /** Already closed (circle, rectangle, closed polygon). */
  closed: boolean;
}

/** Points along an arc (start, mid, end given) sampled every `maxStepDeg` degrees. */
export function arcPoints(start: Vec2, mid: Vec2, end: Vec2, maxStepDeg = 10): Vec2[] {
  const d = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(d) < 1e-9) return [start, end];
  const a2 = start.x * start.x + start.y * start.y;
  const b2 = mid.x * mid.x + mid.y * mid.y;
  const c2 = end.x * end.x + end.y * end.y;
  const cx = (a2 * (mid.y - end.y) + b2 * (end.y - start.y) + c2 * (start.y - mid.y)) / d;
  const cy = (a2 * (end.x - mid.x) + b2 * (start.x - end.x) + c2 * (mid.x - start.x)) / d;
  const r = Math.hypot(start.x - cx, start.y - cy);
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  const am = Math.atan2(mid.y - cy, mid.x - cx);
  const a1 = Math.atan2(end.y - cy, end.x - cx);
  // Sweep direction: the one that passes through `mid`.
  const ccw = (from: number, to: number) => (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const sweepCcw = ccw(a0, a1);
  const midCcw = ccw(a0, am);
  const sweep = midCcw <= sweepCcw ? sweepCcw : sweepCcw - 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / ((maxStepDeg * Math.PI) / 180)));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  out[0] = start;
  out[steps] = end;
  return out;
}

export function circlePoints(center: Vec2, radius: number, segments = 36): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    out.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return out;
}

/**
 * Chains open outline pieces into closed polygons: pieces whose ends lie within `tolerance` are
 * joined (in either direction). Pieces that never close are dropped (a warning is left to the
 * caller). Closed pieces pass through. The result is sorted by area, largest first, so the outer
 * boundary comes first and cutouts follow.
 */
export function chainOutline(pieces: OutlinePiece[], tolerance = 10_000): RoutePolygon[] {
  const polys: RoutePolygon[] = pieces.filter((p) => p.closed).map((p) => p.points);
  const open = pieces.filter((p) => !p.closed && p.points.length >= 2).map((p) => [...p.points]);
  const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
  while (open.length) {
    const chain = open.shift()!;
    let progress = true;
    while (progress) {
      progress = false;
      const tail = chain[chain.length - 1]!;
      if (chain.length > 2 && near(tail, chain[0]!)) break;
      for (let i = 0; i < open.length; i++) {
        const cand = open[i]!;
        if (near(tail, cand[0]!)) {
          chain.push(...cand.slice(1));
        } else if (near(tail, cand[cand.length - 1]!)) {
          chain.push(...cand.slice(0, -1).reverse());
        } else continue;
        open.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (chain.length > 2 && near(chain[chain.length - 1]!, chain[0]!)) {
      chain.pop();
      polys.push(chain);
    }
  }
  return polys.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}

export function polygonArea(p: RoutePolygon): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j]!.x + p[i]!.x) * (p[j]!.y - p[i]!.y);
  return a / 2;
}

export function polygonBounds(p: RoutePolygon): Box {
  return boxFromPoints(p);
}

/** Axis-aligned bounding box of a `size` rectangle centred at `center` rotated by `deg` degrees. */
export function rotatedRectBounds(center: Vec2, size: Vec2, deg: number): Box {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const corners = [
    { x: center.x - hx, y: center.y - hy },
    { x: center.x + hx, y: center.y - hy },
    { x: center.x + hx, y: center.y + hy },
    { x: center.x - hx, y: center.y + hy },
  ].map((c) => vecRotate(c, deg, center));
  return boxFromPoints(corners);
}

/** True when `deg` is a multiple of 90 (within 1e-6). */
export function isAxisAligned(deg: number): boolean {
  const r = ((deg % 90) + 90) % 90;
  return r < 1e-6 || 90 - r < 1e-6;
}

/** Point-in-polygon (even-odd). */
export function pointInPolygon(pt: Vec2, poly: RoutePolygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from `p` to segment `ab`. */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
