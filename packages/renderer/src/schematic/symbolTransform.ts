/**
 * SCH_SYMBOL orientation: KiCad's TRANSFORM (libs/kimath/include/transform.h) and the way
 * SCH_SYMBOL::SetOrientation composes it from an orientation angle and mirror flags, plus
 * SCH_PIN::PinDrawOrient. Library coordinates are y-down like the sheet (TRANSFORM defaults
 * to the identity), so `p' = T p + symbolPosition`.
 */
import type { Primitive, Vec2 } from '../core/model.js';
import { vAdd, vRotate } from '../core/model.js';
import { type HAlign, type VAlign, flipHAlign, flipVAlign, outlineExtents, textGlyphOutline } from './textMetrics.js';

/** p' = (x1*x + y1*y, x2*x + y2*y) — TRANSFORM::TransformCoordinate. */
export interface SymTransform {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const IDENTITY_TRANSFORM: Readonly<SymTransform> = Object.freeze({ x1: 1, y1: 0, x2: 0, y2: 1 });

// incremental transforms used by SCH_SYMBOL::SetOrientation
const ROTATE_CCW: SymTransform = { x1: 0, y1: 1, x2: -1, y2: 0 };
const ROTATE_CW: SymTransform = { x1: 0, y1: -1, x2: 1, y2: 0 };
const MIRROR_X: SymTransform = { x1: 1, y1: 0, x2: 0, y2: -1 };
const MIRROR_Y: SymTransform = { x1: -1, y1: 0, x2: 0, y2: 1 };

/**
 * `temp` applied after `old` (SCH_SYMBOL::SetOrientation: new = temp · old, so the existing
 * transform acts on the point first).
 */
export function composeTransform(temp: SymTransform, old: SymTransform): SymTransform {
  return {
    x1: old.x1 * temp.x1 + old.x2 * temp.y1,
    y1: old.y1 * temp.x1 + old.y2 * temp.y1,
    x2: old.x1 * temp.x2 + old.x2 * temp.y2,
    y2: old.y1 * temp.x2 + old.y2 * temp.y2,
  };
}

export type SymbolOrientation = 0 | 90 | 180 | 270;

/** SSO_0 = 1, SSO_90 = 2, SSO_180 = 3, SSO_270 = 4 (also accepts degrees or enum names). */
export function orientationFromEnum(v: number | string | undefined | null): SymbolOrientation {
  switch (v) {
    case 2:
    case 90:
    case 'SSO_90':
      return 90;
    case 3:
    case 180:
    case 'SSO_180':
      return 180;
    case 4:
    case 270:
    case 'SSO_270':
      return 270;
    default:
      return 0;
  }
}

/**
 * TRANSFORM for a SchematicSymbolTransform: rotation first (SYM_ORIENT_90 = one
 * counter-clockwise step on screen, 270 = one clockwise), then mirror X (y -> -y, "mirror
 * vertically"), then mirror Y (x -> -x) — the order SCH_SYMBOL::SetOrientation applies them.
 */
export function symbolTransform(
  orientation: SymbolOrientation | number | string | undefined,
  mirrorX = false,
  mirrorY = false,
): SymTransform {
  let t: SymTransform = { ...IDENTITY_TRANSFORM };
  const o =
    typeof orientation === 'number' && (orientation === 90 || orientation === 180 || orientation === 270 || orientation === 0)
      ? orientation
      : orientationFromEnum(orientation);
  if (o === 90) t = composeTransform(ROTATE_CCW, t);
  else if (o === 180) t = composeTransform(ROTATE_CCW, composeTransform(ROTATE_CCW, t));
  else if (o === 270) t = composeTransform(ROTATE_CW, t);
  if (mirrorX) t = composeTransform(MIRROR_X, t);
  if (mirrorY) t = composeTransform(MIRROR_Y, t);
  return t;
}

export const transformCoordinate = (t: SymTransform, p: Vec2): Vec2 => ({ x: t.x1 * p.x + t.y1 * p.y, y: t.x2 * p.x + t.y2 * p.y });
export const transformDet = (t: SymTransform): number => t.x1 * t.y2 - t.y1 * t.x2;
/** Library point -> sheet point. */
export const toSheet = (t: SymTransform, p: Vec2, origin: Vec2): Vec2 => vAdd(transformCoordinate(t, p), origin);
/** Inverse (transforms are signed permutations, so the inverse is the transpose). */
export const inverseTransform = (t: SymTransform): SymTransform => ({ x1: t.x1, y1: t.x2, x2: t.y1, y2: t.y2 });

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export type PinOrientation = 'right' | 'left' | 'up' | 'down';

/** SPO_RIGHT = 1, SPO_LEFT = 2, SPO_UP = 3, SPO_DOWN = 4. */
export function pinOrientationFromEnum(v: number | string | undefined | null): PinOrientation {
  switch (v) {
    case 2:
    case 'SPO_LEFT':
      return 'left';
    case 3:
    case 'SPO_UP':
      return 'up';
    case 4:
    case 'SPO_DOWN':
      return 'down';
    default:
      return 'right';
  }
}

/** Unit vector from the pin's connection point towards its root (into the symbol body). */
export function pinDirection(o: PinOrientation): Vec2 {
  switch (o) {
    case 'right':
      return { x: 1, y: 0 };
    case 'left':
      return { x: -1, y: 0 };
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
  }
}

/** Orientation of a pin after the symbol transform (SCH_PIN::PinDrawOrient). */
export function pinDrawOrientation(o: PinOrientation, t: SymTransform): PinOrientation {
  const end = transformCoordinate(t, pinDirection(o));
  if (end.x === 0) return end.y > 0 ? 'down' : 'up';
  return end.x < 0 ? 'left' : 'right';
}

// ---------------------------------------------------------------------------
// Primitives through a transform
// ---------------------------------------------------------------------------

/** KiCad angle (degrees, CCW positive) of a direction vector. */
function angleOf(d: Vec2): number {
  let a = (Math.atan2(-d.y, d.x) * 180) / Math.PI;
  a = ((a % 360) + 360) % 360;
  return Math.round(a * 1e6) / 1e6;
}

/**
 * A text-glyphs primitive through the symbol transform, keeping the text readable the way
 * eeschema does (SCH_FIELD::GetDrawRotation + bbox-centred drawing): mirrors become
 * justification flips, and a result that would read right-to-left or top-to-bottom is
 * turned around with both justifications flipped.
 */
export function transformTextGlyphs<T extends Extract<Primitive, { kind: 'text-glyphs' }>>(p: T, t: SymTransform, offset: Vec2): T {
  const pos = toSheet(t, p.pos, offset);
  let d = transformCoordinate(t, vRotate({ x: 1, y: 0 }, p.angle)); // reading direction
  let u = transformCoordinate(t, vRotate({ x: 0, y: -1 }, p.angle)); // towards the text top
  let halign: HAlign = p.halign;
  let valign: VAlign = p.valign;
  if (transformDet(t) < 0) {
    const readable = (d.x > 0.5 && Math.abs(d.y) < 0.5) || (d.y < -0.5 && Math.abs(d.x) < 0.5);
    if (readable) {
      u = { x: -u.x, y: -u.y };
      valign = flipVAlign(valign);
    } else {
      d = { x: -d.x, y: -d.y };
      halign = flipHAlign(halign);
    }
  }
  let angle = angleOf(d);
  if (angle >= 180 - 1e-6) {
    angle -= 180;
    halign = flipHAlign(halign);
    valign = flipVAlign(valign);
  }
  const { w, h } = outlineExtents(p.outline);
  return { ...p, pos, angle, halign, valign, outline: textGlyphOutline(pos, w, h, angle, halign, valign, p.mirrored) };
}

/** Any primitive through `T` then translated by `offset` (library -> sheet coordinates). */
export function transformPrimitive(p: Primitive, t: SymTransform, offset: Vec2): Primitive {
  const f = (v: Vec2): Vec2 => toSheet(t, v, offset);
  switch (p.kind) {
    case 'segment':
      return { ...p, a: f(p.a), b: f(p.b) };
    case 'arc': {
      // a mirrored arc keeps its three points; start/mid/end still describe it
      return { ...p, start: f(p.start), mid: f(p.mid), end: f(p.end) };
    }
    case 'circle':
      return { ...p, c: f(p.c) };
    case 'polygon':
      return { ...p, outline: p.outline.map(f), holes: p.holes.map((h) => h.map(f)) };
    case 'bezier':
      return { ...p, p0: f(p.p0), p1: f(p.p1), p2: f(p.p2), p3: f(p.p3) };
    case 'text-shapes':
      return { ...p, polys: p.polys.map((poly) => poly.map(f)) };
    case 'image':
      return { ...p, c: f(p.c) };
    case 'text-glyphs':
      return transformTextGlyphs(p, t, offset);
  }
}
