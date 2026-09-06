// Generic geometry helpers over the plain-object proto mirrors used by the mock.
// The real client will expose typed wrappers (Footprint.position etc.); these helpers
// operate structurally so the move/rotate/flip tools work for every item type today.

import type { StoredItem } from '@/contracts';
import { structuredCloneSafe } from './patch';

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

function isVec(v: unknown): v is { xNm: number; yNm: number } {
  return !!v && typeof v === 'object' && typeof (v as { xNm?: unknown }).xNm === 'number' && typeof (v as { yNm?: unknown }).yNm === 'number';
}

function walk(obj: unknown, fn: (vec: { xNm: number; yNm: number }) => void, key?: string): void {
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
    vec.xNm = Math.round(vec.xNm + dx);
    vec.yNm = Math.round(vec.yNm + dy);
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
    const x = vec.xNm - cx;
    const y = vec.yNm - cy;
    // KiCad's y axis points down, so a positive (CCW on screen) rotation is applied inverted
    vec.xNm = Math.round(cx + x * cos + y * sin);
    vec.yNm = Math.round(cy - x * sin + y * cos);
  });
  const orient = proto.orientation as { valueDegrees?: number } | undefined;
  if (orient && typeof orient.valueDegrees === 'number') orient.valueDegrees = ((orient.valueDegrees + deg) % 360 + 360) % 360;
  const transform = proto.transform as { orientation?: string } | undefined;
  if (transform && typeof transform.orientation === 'string') {
    const order = ['SSO_0', 'SSO_90', 'SSO_180', 'SSO_270'];
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
    vec.xNm = Math.round(2 * cx - vec.xNm);
  });
  const swap = (l: string) => (l.startsWith('BL_F_') ? l.replace('BL_F_', 'BL_B_') : l.startsWith('BL_B_') ? l.replace('BL_B_', 'BL_F_') : l);
  if (typeof proto.layer === 'string') proto.layer = swap(proto.layer);
  const ps = proto.padStack as { layers?: string[] } | undefined;
  if (ps?.layers) ps.layers = ps.layers.map(swap);
  const transform = proto.transform as { mirrorY?: boolean } | undefined;
  if (transform && typeof transform.mirrorY === 'boolean') transform.mirrorY = !transform.mirrorY;
  const bbox = item.bbox ? { ...item.bbox, x: 2 * cx - item.bbox.x - item.bbox.w } : undefined;
  return { ...item, proto, layer: item.layer ? swap(item.layer) : item.layer, bbox };
}

export function itemsCentre(items: StoredItem[]): { x: number; y: number } | null {
  const boxes = items.map((i) => i.bbox).filter((b): b is NonNullable<typeof b> => !!b);
  if (!boxes.length) return null;
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
    const dx = n.position.xNm - p.position.xNm;
    const dy = n.position.yNm - p.position.yNm;
    return { ...next, bbox: { ...prev.bbox, x: prev.bbox.x + dx, y: prev.bbox.y + dy } };
  }
  if (isVec(n.start) && isVec(n.end)) {
    const w = ((n.width as { valueNm?: number } | undefined)?.valueNm ?? 0) || 200_000;
    const x0 = Math.min(n.start.xNm, n.end.xNm) - w / 2;
    const y0 = Math.min(n.start.yNm, n.end.yNm) - w / 2;
    return { ...next, bbox: { x: x0, y: y0, w: Math.abs(n.end.xNm - n.start.xNm) + w, h: Math.abs(n.end.yNm - n.start.yNm) + w } };
  }
  return next;
}

export function childrenOf(store: { all(): Iterable<StoredItem> }, parentId: string): StoredItem[] {
  const out: StoredItem[] = [];
  for (const it of store.all()) if (it.parent === parentId) out.push(it);
  return out;
}
