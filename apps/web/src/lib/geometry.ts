// Generic geometry helpers over kiapi message objects: the plain camelCase mirrors used by
// the mock (numbers, enum names) and real protobuf-es messages (bigint nm, numeric enums).
// They operate structurally so the move/rotate/flip tools work for every item type.

import { BoardLayer, SchematicSymbolOrientation } from '@kicad-web/proto';
import type { StoredItem } from '@/contracts';
import { structuredCloneSafe } from './patch';

type Nm = number | bigint;
type VecLike = { xNm: Nm; yNm: Nm };

/** Writes a number back in the representation the field already uses (bigint on real protos). */
function like(orig: Nm, v: number): Nm {
  return typeof orig === 'bigint' ? BigInt(Math.round(v)) : Math.round(v);
}

const num = (v: Nm): number => (typeof v === 'bigint' ? Number(v) : v);

/** Keys whose Vector2 value is a size/offset rather than a coordinate. */
const NON_POSITIONAL = new Set([
  'size',
  'diameter',
  'spacing',
  'extent',
  'offset',
  'trapezoidDelta',
  'knockoutMargin',
  'hatchingOffset',
  'transformOriginOffset',
  'anchor',
]);

const isNm = (v: unknown): v is Nm => typeof v === 'number' || typeof v === 'bigint';

function isVec(v: unknown): v is VecLike {
  return !!v && typeof v === 'object' && isNm((v as { xNm?: unknown }).xNm) && isNm((v as { yNm?: unknown }).yNm);
}

function walk(obj: unknown, fn: (vec: VecLike) => void, key?: string): void {
  if (!obj || typeof obj !== 'object') return;
  if (isVec(obj)) {
    if (!key || !NON_POSITIONAL.has(key)) fn(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const el of obj) walk(el, fn, key);
    return;
  }
  // symbol/footprint definitions carry coordinates relative to the instance: skip them
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'definition') continue;
    walk(v, fn, k);
  }
}

/** Returns a translated copy of the item (proto + bbox). */
export function translateItem(item: StoredItem, dx: number, dy: number): StoredItem {
  const proto = structuredCloneSafe(item.proto);
  walk(proto, (vec) => {
    vec.xNm = like(vec.xNm, num(vec.xNm) + dx);
    vec.yNm = like(vec.yNm, num(vec.yNm) + dy);
  });
  return { ...item, proto, bbox: item.bbox ? { ...item.bbox, x: item.bbox.x + dx, y: item.bbox.y + dy } : undefined };
}

/** Rotates an item about a centre. Positions rotate; `orientation`/`angle` fields are bumped. */
export function rotateItem(item: StoredItem, cx: number, cy: number, deg: number): StoredItem {
  const proto = structuredCloneSafe(item.proto) as Record<string, unknown>;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  walk(proto, (vec) => {
    const x = num(vec.xNm) - cx;
    const y = num(vec.yNm) - cy;
    // KiCad's y axis points down, so a positive (CCW on screen) rotation is applied inverted
    vec.xNm = like(vec.xNm, cx + x * cos + y * sin);
    vec.yNm = like(vec.yNm, cy - x * sin + y * cos);
  });
  const orient = proto.orientation as { valueDegrees?: number } | undefined;
  if (orient && typeof orient.valueDegrees === 'number') orient.valueDegrees = ((orient.valueDegrees + deg) % 360 + 360) % 360;
  const transform = proto.transform as { orientation?: string | number } | undefined;
  if (transform && typeof transform.orientation === 'string') {
    const order = ['SSO_0', 'SSO_90', 'SSO_180', 'SSO_270'];
    const i = order.indexOf(transform.orientation);
    if (i >= 0) transform.orientation = order[(i + Math.round(deg / 90) + 4) % 4]!;
  } else if (transform && typeof transform.orientation === 'number') {
    const order = [SchematicSymbolOrientation.SSO_0, SchematicSymbolOrientation.SSO_90, SchematicSymbolOrientation.SSO_180, SchematicSymbolOrientation.SSO_270];
    const i = order.indexOf(transform.orientation);
    if (i >= 0) transform.orientation = order[(i + Math.round(deg / 90) + 4) % 4]!;
  }
  let bbox = item.bbox;
  if (bbox) {
    const corners = [
      [bbox.x, bbox.y],
      [bbox.x + bbox.w, bbox.y],
      [bbox.x, bbox.y + bbox.h],
      [bbox.x + bbox.w, bbox.y + bbox.h],
    ].map(([x, y]) => {
      const rx = x! - cx;
      const ry = y! - cy;
      return [cx + rx * cos + ry * sin, cy - rx * sin + ry * cos] as const;
    });
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { ...item, proto, bbox };
}

/** Flips a board item to the other side about a vertical axis through `cx`. */
export function flipItem(item: StoredItem, cx: number): StoredItem {
  const proto = structuredCloneSafe(item.proto) as Record<string, unknown>;
  walk(proto, (vec) => {
    vec.xNm = like(vec.xNm, 2 * cx - num(vec.xNm));
  });
  const swap = (l: string) => (l.startsWith('BL_F_') ? l.replace('BL_F_', 'BL_B_') : l.startsWith('BL_B_') ? l.replace('BL_B_', 'BL_F_') : l);
  const swapEnum = (l: number) => {
    const name = BoardLayer[l];
    const flipped = name ? swap(name) : undefined;
    return flipped && flipped in BoardLayer ? BoardLayer[flipped as keyof typeof BoardLayer] : l;
  };
  if (typeof proto.layer === 'string') proto.layer = swap(proto.layer);
  else if (typeof proto.layer === 'number') proto.layer = swapEnum(proto.layer);
  const ps = proto.padStack as { layers?: (string | number)[] } | undefined;
  if (ps?.layers) ps.layers = ps.layers.map((l) => (typeof l === 'number' ? swapEnum(l) : swap(l)));
  const transform = proto.transform as { mirrorY?: boolean } | undefined;
  if (transform && typeof transform.mirrorY === 'boolean') transform.mirrorY = !transform.mirrorY;
  const bbox = item.bbox ? { ...item.bbox, x: 2 * cx - item.bbox.x - item.bbox.w } : undefined;
  return { ...item, proto, layer: item.layer ? swap(item.layer) : item.layer, bbox };
}

/** Anchor of an item without a bbox: its `position`, or the midpoint of `start`/`end`. */
export function itemAnchor(item: StoredItem): { x: number; y: number } | null {
  if (item.bbox) return { x: item.bbox.x + item.bbox.w / 2, y: item.bbox.y + item.bbox.h / 2 };
  const p = item.proto as Record<string, unknown>;
  if (isVec(p.position)) return { x: num(p.position.xNm), y: num(p.position.yNm) };
  if (isVec(p.start) && isVec(p.end)) return { x: (num(p.start.xNm) + num(p.end.xNm)) / 2, y: (num(p.start.yNm) + num(p.end.yNm)) / 2 };
  if (isVec(p.center)) return { x: num(p.center.xNm), y: num(p.center.yNm) };
  const t = p.text as { position?: unknown } | undefined;
  if (t && isVec(t.position)) return { x: num(t.position.xNm), y: num(t.position.yNm) };
  return null;
}

export function itemsCentre(items: StoredItem[]): { x: number; y: number } | null {
  const boxes = items.map((i) => i.bbox).filter((b): b is NonNullable<typeof b> => !!b);
  if (!boxes.length) {
    const pts = items.map(itemAnchor).filter((a): a is { x: number; y: number } => !!a);
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

export function snap(v: number, grid: number): number {
  if (grid <= 0) return v;
  return Math.round(v / grid) * grid;
}

/**
 * After a field edit, keep the denormalised bbox plausible: a change to `position` shifts
 * it, a change to `start`/`end` (tracks, wires) rebuilds it. The real client fills bbox
 * lazily from the renderer, so this only matters for the mock.
 */
export function refreshBbox(prev: StoredItem, next: StoredItem): StoredItem {
  if (!prev.bbox) return next;
  const p = prev.proto as Record<string, unknown>;
  const n = next.proto as Record<string, unknown>;
  if (isVec(p.position) && isVec(n.position) && (p.position.xNm !== n.position.xNm || p.position.yNm !== n.position.yNm)) {
    const dx = num(n.position.xNm) - num(p.position.xNm);
    const dy = num(n.position.yNm) - num(p.position.yNm);
    return { ...next, bbox: { ...prev.bbox, x: prev.bbox.x + dx, y: prev.bbox.y + dy } };
  }
  if (isVec(n.start) && isVec(n.end)) {
    const w = num((n.width as { valueNm?: Nm } | undefined)?.valueNm ?? 0) || 200_000;
    const sx = num(n.start.xNm);
    const sy = num(n.start.yNm);
    const ex = num(n.end.xNm);
    const ey = num(n.end.yNm);
    const x0 = Math.min(sx, ex) - w / 2;
    const y0 = Math.min(sy, ey) - w / 2;
    return { ...next, bbox: { x: x0, y: y0, w: Math.abs(ex - sx) + w, h: Math.abs(ey - sy) + w } };
  }
  return next;
}

export function childrenOf(store: { all(): Iterable<StoredItem> }, parentId: string): StoredItem[] {
  const out: StoredItem[] = [];
  for (const it of store.all()) if (it.parent === parentId) out.push(it);
  return out;
}
