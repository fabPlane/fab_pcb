/**
 * Pure geometry helpers shared by the scene builders, the picker and the adapters.
 * All coordinates are world nm (y down, as in KiCad).
 */
import { type Vec2, type Primitive, vDist, vRotate } from './model.js';

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Arcs (KiCad start / mid / end representation)
// ---------------------------------------------------------------------------

export interface ArcGeom {
  c: Vec2;
  r: number;
  /** start angle (radians, atan2 convention on a y-down plane) */
  a0: number;
  /** signed sweep in radians: positive = increasing angle (clockwise on screen) */
  sweep: number;
}

/** Circle through three points; undefined when collinear. */
export function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | undefined {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return undefined;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}

const norm = (a: number): number => ((a % TAU) + TAU) % TAU;

export function arcFrom3(start: Vec2, mid: Vec2, end: Vec2): ArcGeom | undefined {
  const cir = circleFrom3(start, mid, end);
  if (!cir) return undefined;
  const a0 = Math.atan2(start.y - cir.c.y, start.x - cir.c.x);
  const am = Math.atan2(mid.y - cir.c.y, mid.x - cir.c.x);
  const a1 = Math.atan2(end.y - cir.c.y, end.x - cir.c.x);
  // sweep in the increasing direction, check that mid lies within it
  const sweepPos = norm(a1 - a0);
  const midPos = norm(am - a0);
  const sweep = midPos <= sweepPos ? sweepPos : -(TAU - sweepPos);
  return { c: cir.c, r: cir.r, a0, sweep };
}

export function arcPoint(g: ArcGeom, t: number): Vec2 {
  const a = g.a0 + g.sweep * t;
  return { x: g.c.x + g.r * Math.cos(a), y: g.c.y + g.r * Math.sin(a) };
}

/** Polyline approximation of an arc; `maxError` = max chord deviation in nm. */
export function arcToPolyline(start: Vec2, mid: Vec2, end: Vec2, maxError = 5000): Vec2[] {
  const g = arcFrom3(start, mid, end);
  if (!g) return [start, end];
  const n = arcSegmentCount(g.r, Math.abs(g.sweep), maxError);
  const pts: Vec2[] = [start];
  for (let i = 1; i < n; i++) pts.push(arcPoint(g, i / n));
  pts.push(end);
  return pts;
}

export function arcSegmentCount(r: number, sweep: number, maxError: number): number {
  if (r <= maxError) return Math.max(2, Math.ceil(sweep / (Math.PI / 4)));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - maxError / r)));
  return Math.max(2, Math.min(720, Math.ceil(sweep / step)));
}

export function circleToPolygon(c: Vec2, r: number, segments = 0, maxError = 5000): Vec2[] {
  const n = segments || Math.max(16, arcSegmentCount(r, TAU, maxError));
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

export function bezierToPolyline(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, segments = 24): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    pts.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return pts;
}

export function ellipseToPolygon(c: Vec2, rx: number, ry: number, rotDeg: number, a0Deg = 0, a1Deg = 360, segments = 64): Vec2[] {
  const pts: Vec2[] = [];
  const closed = Math.abs(a1Deg - a0Deg) >= 360;
  const n = closed ? segments : Math.max(2, Math.ceil((segments * Math.abs(a1Deg - a0Deg)) / 360));
  for (let i = 0; i <= (closed ? n - 1 : n); i++) {
    const a = ((a0Deg + ((a1Deg - a0Deg) * i) / n) * Math.PI) / 180;
    pts.push(vRotate({ x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) }, rotDeg, c));
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Zoom-independent tessellation for the GPU (Pixi's adaptive tessellation assumes
// pixel-sized units and explodes with nm coordinates)
// ---------------------------------------------------------------------------

/** Segments for a full circle of radius r (nm): ~60 um per segment, clamped to [8, 64]. */
export function circleSegments(r: number): number {
  return Math.min(64, Math.max(8, Math.ceil((TAU * r) / 60_000)));
}

/** Round-capped segment (stadium) as a convex polygon; a degenerate segment becomes a circle. */
export function stadiumPolygon(a: Vec2, b: Vec2, width: number): Vec2[] {
  const r = width / 2;
  const n = Math.max(3, Math.ceil(circleSegments(r) / 2));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return circleToPolygon(a, r, 2 * n);
  const th = Math.atan2(dy, dx);
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const ang = th - Math.PI / 2 + (i * Math.PI) / n;
    pts.push({ x: b.x + r * Math.cos(ang), y: b.y + r * Math.sin(ang) });
  }
  for (let i = 0; i <= n; i++) {
    const ang = th + Math.PI / 2 + (i * Math.PI) / n;
    pts.push({ x: a.x + r * Math.cos(ang), y: a.y + r * Math.sin(ang) });
  }
  return pts;
}

/**
 * Outline of a smooth polyline stroked with round caps (bisector offsets, one polygon).
 * Use for arcs / beziers; for sharp polylines use stadiumPolygon per segment.
 */
export function offsetPathPolygon(pts: Vec2[], width: number): Vec2[] {
  if (pts.length < 2) return pts.length ? circleToPolygon(pts[0]!, width / 2, circleSegments(width / 2)) : [];
  const r = width / 2;
  const n = pts.length;
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[Math.max(0, i - 1)]!;
    const q = pts[Math.min(n - 1, i + 1)]!;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const l = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / l, y: dx / l });
  }
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const nn = normals[i]!;
    left.push({ x: pts[i]!.x + nn.x * r, y: pts[i]!.y + nn.y * r });
    right.push({ x: pts[i]!.x - nn.x * r, y: pts[i]!.y - nn.y * r });
  }
  const capSegs = Math.max(3, Math.ceil(circleSegments(r) / 2));
  const cap = (c: Vec2, from: Vec2, to: Vec2): Vec2[] => {
    const a0 = Math.atan2(from.y - c.y, from.x - c.x);
    let a1 = Math.atan2(to.y - c.y, to.x - c.x);
    // sweep the short way round the outside of the path end
    let d = a1 - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    a1 = a0 + d;
    const out: Vec2[] = [];
    for (let i = 1; i < capSegs; i++) {
      const a = a0 + ((a1 - a0) * i) / capSegs;
      out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
    return out;
  };
  const last = n - 1;
  return [...left, ...cap(pts[last]!, left[last]!, right[last]!), ...right.reverse(), ...cap(pts[0]!, right[0]!, left[0]!)];
}

/** Arc polyline with a zoom-independent segment count. */
export function arcToPolylineFixed(start: Vec2, mid: Vec2, end: Vec2): Vec2[] {
  const g = arcFrom3(start, mid, end);
  if (!g) return [start, end];
  const n = Math.max(2, Math.ceil((circleSegments(g.r) * Math.abs(g.sweep)) / TAU));
  const pts: Vec2[] = [start];
  for (let i = 1; i < n; i++) pts.push(arcPoint(g, i / n));
  pts.push(end);
  return pts;
}

// ---------------------------------------------------------------------------
// Pad / rectangle shape generators (centred at origin, then rotated/translated)
// ---------------------------------------------------------------------------

export function rectPolygon(w: number, h: number): Vec2[] {
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

export function roundRectPolygon(w: number, h: number, radius: number, cornerSegs = 8): Vec2[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return rectPolygon(w, h);
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const pts: Vec2[] = [];
  const corners: Array<[number, number, number]> = [
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
    [hw, -hh, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = start + (i / cornerSegs) * (Math.PI / 2);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return pts;
}

export interface ChamferCorners {
  topLeft?: boolean;
  topRight?: boolean;
  bottomLeft?: boolean;
  bottomRight?: boolean;
}

/** KiCad chamfered rect: chamfer size = ratio * min(w,h); optional rounding on the other corners. */
export function chamferedRectPolygon(w: number, h: number, chamfer: number, corners: ChamferCorners, roundRadius = 0): Vec2[] {
  const hw = w / 2;
  const hh = h / 2;
  const c = Math.max(0, Math.min(chamfer, hw, hh));
  const arc = (cx: number, cy: number, start: number): Vec2[] => {
    const r = Math.min(roundRadius, hw, hh);
    if (r <= 0) return [{ x: cx + (cx > 0 ? r : -r), y: cy + (cy > 0 ? r : -r) }];
    const pts: Vec2[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = start + (i / 6) * (Math.PI / 2);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  };
  const rr = Math.min(roundRadius, hw, hh);
  const pts: Vec2[] = [];
  // y-down: "top" corners have negative y.
  // top-left
  if (corners.topLeft && c > 0) pts.push({ x: -hw, y: -hh + c }, { x: -hw + c, y: -hh });
  else pts.push(...arc(-hw + rr, -hh + rr, Math.PI));
  // top-right
  if (corners.topRight && c > 0) pts.push({ x: hw - c, y: -hh }, { x: hw, y: -hh + c });
  else pts.push(...arc(hw - rr, -hh + rr, (3 * Math.PI) / 2));
  // bottom-right
  if (corners.bottomRight && c > 0) pts.push({ x: hw, y: hh - c }, { x: hw - c, y: hh });
  else pts.push(...arc(hw - rr, hh - rr, 0));
  // bottom-left
  if (corners.bottomLeft && c > 0) pts.push({ x: -hw + c, y: hh }, { x: -hw, y: hh - c });
  else pts.push(...arc(-hw + rr, hh - rr, Math.PI / 2));
  return pts;
}

/** Oval (stadium) of size w x h: a rect with fully rounded short sides. */
export function ovalPolygon(w: number, h: number, segs = 12): Vec2[] {
  if (w === h) return circleToPolygon({ x: 0, y: 0 }, w / 2, 32);
  return roundRectPolygon(w, h, Math.min(w, h) / 2, segs);
}

/** KiCad trapezoid: delta.x changes the width difference between top/bottom, delta.y between left/right. */
export function trapezoidPolygon(w: number, h: number, delta: Vec2): Vec2[] {
  const hw = w / 2;
  const hh = h / 2;
  const dx = delta.x / 2;
  const dy = delta.y / 2;
  return [
    { x: -hw - dy, y: -hh + dx },
    { x: hw + dy, y: -hh - dx },
    { x: hw - dy, y: hh + dx },
    { x: -hw + dy, y: hh - dx },
  ];
}

export function transformPoly(poly: Vec2[], rotDeg: number, offset: Vec2, mirrorY = false): Vec2[] {
  return poly.map((p) => {
    const q = mirrorY ? { x: p.x, y: -p.y } : p;
    const r = vRotate(q, rotDeg);
    return { x: r.x + offset.x, y: r.y + offset.y };
  });
}

// ---------------------------------------------------------------------------
// Dashes
// ---------------------------------------------------------------------------

/** Split a polyline into on/off runs following `pattern` (nm, [dash, gap, dash, gap...]). Returns segments. */
export function dashPolyline(pts: Vec2[], pattern: number[]): Array<[Vec2, Vec2]> {
  const out: Array<[Vec2, Vec2]> = [];
  if (pts.length < 2 || pattern.length === 0 || pattern.some((v) => !(v > 0))) return out;
  let pi = 0;
  let remain = pattern[0]!;
  let on = true;
  let dashStart: Vec2 | null = pts[0]!;
  for (let i = 0; i + 1 < pts.length; i++) {
    let a = pts[i]!;
    const b = pts[i + 1]!;
    let len = vDist(a, b);
    while (len > 0) {
      if (remain > len) {
        // the rest of this segment stays in the current phase; break dashes at vertices
        if (on && dashStart) {
          out.push([dashStart, b]);
          dashStart = b;
        }
        remain -= len;
        len = 0;
      } else {
        const t = remain / len;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (on && dashStart) out.push([dashStart, p]);
        len -= remain;
        a = p;
        pi = (pi + 1) % pattern.length;
        remain = pattern[pi]!;
        on = !on;
        dashStart = on ? p : null;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hatching
// ---------------------------------------------------------------------------

/**
 * Hatch lines at `angleDeg` with spacing `pitch` clipped to a polygon with holes (even-odd).
 * Returns line segments.
 */
export function hatchPolygon(outline: Vec2[], holes: Vec2[][], pitch: number, angleDeg = 45, maxLines = 4000): Array<[Vec2, Vec2]> {
  const out: Array<[Vec2, Vec2]> = [];
  if (outline.length < 3 || pitch <= 0) return out;
  // rotate polygon so hatch lines become horizontal
  const rings = [outline, ...holes].map((r) => r.map((p) => vRotate(p, angleDeg)));
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings) for (const p of r) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const count = Math.floor((maxY - minY) / pitch);
  if (count > maxLines) pitch = (maxY - minY) / maxLines;
  const y0 = Math.ceil(minY / pitch) * pitch;
  for (let y = y0; y <= maxY; y += pitch) {
    const xs: number[] = [];
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i]!;
        const b = r[(i + 1) % r.length]!;
        if (a.y === b.y) continue;
        if ((y >= a.y && y < b.y) || (y >= b.y && y < a.y)) {
          xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      out.push([vRotate({ x: xs[i]!, y }, -angleDeg), vRotate({ x: xs[i + 1]!, y }, -angleDeg)]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Distances & containment (picking)
// ---------------------------------------------------------------------------

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return vDist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointPolylineDistance(p: Vec2, pts: Vec2[], closed = false): number {
  let best = Infinity;
  const n = pts.length;
  if (n === 1) return vDist(p, pts[0]!);
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const d = pointSegmentDistance(p, pts[i]!, pts[(i + 1) % n]!);
    if (d < best) best = d;
  }
  return best;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInPolygonWithHoles(p: Vec2, outline: Vec2[], holes: Vec2[][]): boolean {
  if (!pointInPolygon(p, outline)) return false;
  for (const h of holes) if (pointInPolygon(p, h)) return false;
  return true;
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]!.x + poly[i]!.x) * (poly[j]!.y - poly[i]!.y);
  return a / 2;
}

/** Distance from a point to the painted area of a primitive (0 when inside). */
export function distanceToPrimitive(p: Vec2, prim: Primitive): number {
  switch (prim.kind) {
    case 'segment':
      return Math.max(0, pointSegmentDistance(p, prim.a, prim.b) - prim.width / 2);
    case 'arc': {
      const g = arcFrom3(prim.start, prim.mid, prim.end);
      if (!g) return Math.max(0, pointSegmentDistance(p, prim.start, prim.end) - prim.width / 2);
      const ang = Math.atan2(p.y - g.c.y, p.x - g.c.x);
      const rel = g.sweep >= 0 ? norm(ang - g.a0) : norm(g.a0 - ang);
      if (rel <= Math.abs(g.sweep)) {
        return Math.max(0, Math.abs(vDist(p, g.c) - g.r) - prim.width / 2);
      }
      return Math.max(0, Math.min(vDist(p, prim.start), vDist(p, prim.end)) - prim.width / 2);
    }
    case 'circle': {
      const d = vDist(p, prim.c);
      if (prim.fill) return Math.max(0, d - prim.r - prim.width / 2);
      return Math.max(0, Math.abs(d - prim.r) - prim.width / 2);
    }
    case 'polygon': {
      if (prim.fill && pointInPolygonWithHoles(p, prim.outline, prim.holes)) return 0;
      let d = pointPolylineDistance(p, prim.outline, true);
      for (const h of prim.holes) d = Math.min(d, pointPolylineDistance(p, h, true));
      return Math.max(0, d - prim.width / 2);
    }
    case 'bezier':
      return Math.max(0, pointPolylineDistance(p, bezierToPolyline(prim.p0, prim.p1, prim.p2, prim.p3, 16)) - prim.width / 2);
    case 'text-shapes': {
      let d = Infinity;
      for (const poly of prim.polys) {
        if (poly.length >= 3 && pointInPolygon(p, poly)) return 0;
        d = Math.min(d, pointPolylineDistance(p, poly, poly.length >= 3));
      }
      return d;
    }
    case 'image': {
      const dx = Math.max(prim.c.x - prim.w / 2 - p.x, 0, p.x - (prim.c.x + prim.w / 2));
      const dy = Math.max(prim.c.y - prim.h / 2 - p.y, 0, p.y - (prim.c.y + prim.h / 2));
      return Math.hypot(dx, dy);
    }
    case 'text-glyphs': {
      if (prim.outline.length < 3) return vDist(p, prim.pos);
      if (pointInPolygon(p, prim.outline)) return 0;
      return pointPolylineDistance(p, prim.outline, true);
    }
  }
}
