/**
 * Neutral render model (docs/contracts.md "Render model"). The core never imports
 * @kicad-web/proto: adapters turn protobuf items into RenderItems.
 *
 * Units: world coordinates in KiCad nanometres as `number`; widths in nm; a width of
 * 0 means "hairline" (one device pixel regardless of zoom).
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Primitive =
  | { kind: 'segment'; a: Vec2; b: Vec2; width: number }
  | { kind: 'arc'; start: Vec2; mid: Vec2; end: Vec2; width: number }
  | { kind: 'circle'; c: Vec2; r: number; width: number; fill: boolean }
  | {
      kind: 'polygon';
      outline: Vec2[];
      holes: Vec2[][];
      fill: boolean;
      width: number;
      /** Hint: render as a pre-triangulated mesh (zone fills). Auto-enabled for big polygons. */
      mesh?: boolean;
    }
  | { kind: 'bezier'; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2; width: number }
  | { kind: 'text-shapes'; polys: Vec2[][] } // from GetTextAsShapes (filled glyph polygons)
  | { kind: 'image'; c: Vec2; w: number; h: number; dataUrl: string };

export interface RenderItem {
  /** Id of the thing this render item represents (pad KIID, track KIID, ...). */
  id: string;
  /** Layer id: a kiapi BoardLayer name (`BL_F_Cu`) or a theme key (`board.via_hole`, `schematic.wire`). */
  layer: string;
  net?: string;
  prims: Primitive[];
  bbox: Box;
  /** Store item that produced this render item (a footprint for its pads). Defaults to `id`. */
  owner?: string;
  /** KIID of the object this geometry belongs to when `id` carries a layer suffix (pad@BL_F_Cu). Defaults to `id`. */
  ref?: string;
  /** False for purely decorative geometry (drill holes, hatch) that should never be picked. */
  pickable?: boolean;
  /**
   * Instancing hint: prims that are identical for every item sharing `cacheKey`, expressed
   * around `anchor`. The scene builds the geometry once and reuses it (pads by padstack hash,
   * text by content).
   */
  cacheKey?: string;
  anchor?: Vec2;
}

// ---------------------------------------------------------------------------
// Vec2 helpers
// ---------------------------------------------------------------------------

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vLen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const vEq = (a: Vec2, b: Vec2, eps = 0): boolean => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/**
 * Rotate `p` about `c` by `deg` degrees using KiCad's convention (positive angle is
 * counter-clockwise on screen with a y-down axis; see RotatePoint()).
 */
export function vRotate(p: Vec2, deg: number, c: Vec2 = { x: 0, y: 0 }): Vec2 {
  if (deg === 0) return { x: p.x, y: p.y };
  const r = (deg * Math.PI) / 180;
  const s = Math.sin(r);
  const co = Math.cos(r);
  const x = p.x - c.x;
  const y = p.y - c.y;
  return { x: c.x + x * co + y * s, y: c.y + y * co - x * s };
}

// ---------------------------------------------------------------------------
// Box helpers
// ---------------------------------------------------------------------------

/** Sentinel for "no extent yet"; boxIsEmpty() recognises it. */
export const EMPTY_BOX: Box = Object.freeze({ x: Infinity, y: Infinity, w: -Infinity, h: -Infinity }) as Box;

export const boxIsEmpty = (b: Box): boolean => !(b.w >= 0 && b.h >= 0) || !Number.isFinite(b.x) || !Number.isFinite(b.y);

export function boxFromPoints(pts: Iterable<Vec2>, pad = 0): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return EMPTY_BOX;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

export function boxUnion(a: Box, b: Box): Box {
  if (boxIsEmpty(a)) return b;
  if (boxIsEmpty(b)) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export const boxExpand = (b: Box, d: number): Box => (boxIsEmpty(b) ? b : { x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
export const boxCenter = (b: Box): Vec2 => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const boxContains = (b: Box, p: Vec2): boolean => p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
export const boxIntersects = (a: Box, b: Box): boolean =>
  !boxIsEmpty(a) && !boxIsEmpty(b) && a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const boxCorners = (b: Box): Vec2[] => [
  { x: b.x, y: b.y },
  { x: b.x + b.w, y: b.y },
  { x: b.x + b.w, y: b.y + b.h },
  { x: b.x, y: b.y + b.h },
];

/** Conservative bounding box of one primitive (stroke width included). */
export function boxOfPrimitive(p: Primitive): Box {
  switch (p.kind) {
    case 'segment':
      return boxFromPoints([p.a, p.b], p.width / 2);
    case 'arc': {
      // exact enough: hull of the three points plus the radius-based sagitta bound
      const b = boxFromPoints([p.start, p.mid, p.end], p.width / 2);
      const r = vDist(p.start, p.mid) + vDist(p.mid, p.end);
      return boxExpand(b, Math.min(r, arcSagittaBound(p.start, p.mid, p.end)));
    }
    case 'circle':
      return { x: p.c.x - p.r - p.width / 2, y: p.c.y - p.r - p.width / 2, w: 2 * p.r + p.width, h: 2 * p.r + p.width };
    case 'polygon':
      return boxFromPoints(p.outline, p.width / 2);
    case 'bezier':
      return boxFromPoints([p.p0, p.p1, p.p2, p.p3], p.width / 2);
    case 'text-shapes': {
      let b = EMPTY_BOX;
      for (const poly of p.polys) b = boxUnion(b, boxFromPoints(poly));
      return b;
    }
    case 'image':
      return { x: p.c.x - p.w / 2, y: p.c.y - p.h / 2, w: p.w, h: p.h };
  }
}

function arcSagittaBound(s: Vec2, m: Vec2, e: Vec2): number {
  // distance from chord midpoint to arc midpoint bounds how far the arc bulges outside the hull
  const cm = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 };
  return vDist(cm, m);
}

export function boxOfPrimitives(prims: Iterable<Primitive>): Box {
  let b = EMPTY_BOX;
  for (const p of prims) b = boxUnion(b, boxOfPrimitive(p));
  return b;
}

/** Build a RenderItem computing its bbox from the primitives. */
export function makeRenderItem(
  id: string,
  layer: string,
  prims: Primitive[],
  extra: Partial<Omit<RenderItem, 'id' | 'layer' | 'prims' | 'bbox'>> = {},
): RenderItem {
  return { id, layer, prims, bbox: boxOfPrimitives(prims), ...extra };
}
