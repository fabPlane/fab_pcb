/**
 * Units and geometry helpers. KiCad's IPC API carries lengths as int64 nanometres (`bigint` on the
 * protobuf-es wire types) and angles as double degrees. Everything above the wire layer works in
 * plain `number` nanometres (exact up to 2^53 nm, about 9000 km) and degrees, so UI code never does
 * bigint arithmetic. Conversion happens at the wrapper boundary with the helpers in this file.
 */
import { create } from "@bufbuild/protobuf";
import {
  AngleSchema,
  Box2Schema,
  DistanceSchema,
  RatioSchema,
  Vector2Schema,
  Vector3Schema,
  type Angle,
  type Box2,
  type Distance,
  type Ratio,
  type Vector2,
  type Vector3,
} from "@kicad-web/proto";

export const NM_PER_MM = 1_000_000;
export const NM_PER_MIL = 25_400;
export const NM_PER_INCH = 25_400_000;

/** A point or size in nanometres. */
export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned box in nanometres (position + size), matching `kiapi.common.types.Box2`. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** bigint -> number, throwing if the value is outside the exactly-representable range. */
export function fromBigInt(v: bigint): number {
  if (v > MAX_SAFE || v < MIN_SAFE) throw new RangeError(`int64 value ${v} exceeds the safe integer range`);
  return Number(v);
}

/** number -> bigint (rounds to the nearest integer nanometre). */
export function toBigInt(v: number): bigint {
  if (!Number.isFinite(v)) throw new RangeError(`cannot convert ${v} to an int64`);
  return BigInt(Math.round(v));
}

/** Reads a nanometre value from a `Distance`, a raw int64 `bigint`, or a `number`; missing -> 0. */
export function nm(v: Distance | bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return fromBigInt(v);
  return fromBigInt(v.valueNm);
}

/** number nm -> int64 bigint for the wire types. */
export function toNm(v: number): bigint {
  return toBigInt(v);
}

/** Wraps a number of nanometres in a `Distance` message. */
export function toDistance(v: number): Distance {
  return create(DistanceSchema, { valueNm: toBigInt(v) });
}

/** Millimetres -> nanometres. */
export function mm(v: number): number {
  return v * NM_PER_MM;
}

/** Nanometres -> millimetres. */
export function toMm(v: number): number {
  return v / NM_PER_MM;
}

/** Mils (thousandths of an inch) -> nanometres. */
export function mil(v: number): number {
  return v * NM_PER_MIL;
}

/** Nanometres -> mils. */
export function toMil(v: number): number {
  return v / NM_PER_MIL;
}

/** Inches -> nanometres. */
export function inch(v: number): number {
  return v * NM_PER_INCH;
}

/** Nanometres -> inches. */
export function toInch(v: number): number {
  return v / NM_PER_INCH;
}

/** Reads degrees from an `Angle` (or passes a number through); missing -> 0. */
export function deg(a: Angle | number | null | undefined): number {
  if (a === null || a === undefined) return 0;
  return typeof a === "number" ? a : a.valueDegrees;
}

/** Wraps degrees in an `Angle` message. */
export function toAngle(degrees: number): Angle {
  return create(AngleSchema, { valueDegrees: degrees });
}

/** Degrees -> radians. */
export function rad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Normalises an angle into [0, 360). */
export function normalizeDeg(degrees: number): number {
  const d = degrees % 360;
  return d < 0 ? d + 360 : d;
}

/** Reads a `Ratio` (or a number); missing -> 0. */
export function ratio(r: Ratio | number | null | undefined): number {
  if (r === null || r === undefined) return 0;
  return typeof r === "number" ? r : r.value;
}

export function toRatio(v: number): Ratio {
  return create(RatioSchema, { value: v });
}

/** `Vector2` -> `{x, y}` in nanometres; missing -> origin. */
export function vec2(v: Vector2 | null | undefined): Vec2 {
  if (!v) return { x: 0, y: 0 };
  return { x: fromBigInt(v.xNm), y: fromBigInt(v.yNm) };
}

/** `{x, y}` nanometres -> `Vector2`. */
export function toVector2(v: Vec2): Vector2 {
  return create(Vector2Schema, { xNm: toBigInt(v.x), yNm: toBigInt(v.y) });
}

export function vec3(v: Vector3 | null | undefined): Vec3 {
  if (!v) return { x: 0, y: 0, z: 0 };
  return { x: fromBigInt(v.xNm), y: fromBigInt(v.yNm), z: fromBigInt(v.zNm) };
}

export function toVector3(v: Vec3): Vector3 {
  return create(Vector3Schema, { xNm: toBigInt(v.x), yNm: toBigInt(v.y), zNm: toBigInt(v.z) });
}

/** `Box2` -> `{x, y, w, h}` in nanometres. */
export function box2(b: Box2 | null | undefined): Box {
  if (!b) return { x: 0, y: 0, w: 0, h: 0 };
  const p = vec2(b.position);
  const s = vec2(b.size);
  return { x: p.x, y: p.y, w: s.x, h: s.y };
}

export function toBox2(b: Box): Box2 {
  return create(Box2Schema, { position: toVector2({ x: b.x, y: b.y }), size: toVector2({ x: b.w, y: b.h }) });
}

// --- Vec2 arithmetic (all in nanometres, no bigint) ---------------------------------------------

export const ORIGIN: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });

export function vecAdd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vecSub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vecScale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function vecLength(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function vecDistance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function vecEquals(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Rotates `v` by `degrees` about `center` (KiCad's screen-space convention: y grows downward). */
export function vecRotate(v: Vec2, degrees: number, center: Vec2 = ORIGIN): Vec2 {
  const r = rad(degrees);
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = v.x - center.x;
  const dy = v.y - center.y;
  return { x: center.x + dx * c - dy * s, y: center.y + dx * s + dy * c };
}

// --- Box helpers ---------------------------------------------------------------------------------

export const EMPTY_BOX: Readonly<Box> = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });

export function boxIsEmpty(b: Box): boolean {
  return b.w <= 0 || b.h <= 0;
}

export function boxFromPoints(points: Iterable<Vec2>): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { ...EMPTY_BOX };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function boxUnion(a: Box, b: Box): Box {
  if (boxIsEmpty(a)) return { ...b };
  if (boxIsEmpty(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function boxInflate(b: Box, amount: number): Box {
  return { x: b.x - amount, y: b.y - amount, w: b.w + 2 * amount, h: b.h + 2 * amount };
}

export function boxContains(b: Box, p: Vec2): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function boxIntersects(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function boxCenter(b: Box): Vec2 {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Formats a nanometre length for humans, e.g. `1.2500 mm`. */
export function formatMm(v: number, digits = 4): string {
  return `${toMm(v).toFixed(digits)} mm`;
}
