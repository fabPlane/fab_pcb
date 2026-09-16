/**
 * Spatial picking: a flatbush index over RenderItem bounding boxes plus exact per-primitive
 * distance tests. Distances are in world nm; the host converts the pixel tolerance.
 */
import Flatbush from 'flatbush';
import type { Box, RenderItem, Vec2 } from './model.js';
import { boxIsEmpty, boxIntersects } from './model.js';
import { distanceToPrimitive } from './geometry.js';

export interface PickHit {
  /** RenderItem id (pad / track / ... KIID) */
  id: string;
  /** store item that owns it (footprint KIID for a pad) */
  owner: string;
  /** KIID without layer suffix */
  ref: string;
  layer: string;
  net?: string;
  /** world nm from the query point to the painted geometry (0 = inside) */
  distance: number;
  item: RenderItem;
}

export interface PickOptions {
  /** only consider these layers (render-model layer ids) */
  layers?: (layer: string) => boolean;
  /** include non-pickable decorations */
  includeDecorations?: boolean;
  /** max hits to return (nearest first) */
  limit?: number;
}

export class Picker {
  private index: Flatbush | null = null;
  private indexed: RenderItem[] = [];
  private dirty = true;

  constructor(private readonly source: () => Iterable<RenderItem>) {}

  /** Call whenever the item set or any bbox changes. Rebuild is lazy. */
  invalidate(): void {
    this.dirty = true;
  }

  get size(): number {
    this.ensure();
    return this.indexed.length;
  }

  private ensure(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const items: RenderItem[] = [];
    for (const it of this.source()) if (!boxIsEmpty(it.bbox)) items.push(it);
    this.indexed = items;
    if (items.length === 0) {
      this.index = null;
      return;
    }
    const idx = new Flatbush(items.length);
    for (const it of items) idx.add(it.bbox.x, it.bbox.y, it.bbox.x + it.bbox.w, it.bbox.y + it.bbox.h);
    idx.finish();
    this.index = idx;
  }

  /** Items whose bbox intersects `box`. */
  queryBox(box: Box, opts: PickOptions = {}): RenderItem[] {
    this.ensure();
    if (!this.index) return [];
    const out: RenderItem[] = [];
    for (const i of this.index.search(box.x, box.y, box.x + box.w, box.y + box.h)) {
      const it = this.indexed[i]!;
      if (!opts.includeDecorations && it.pickable === false) continue;
      if (opts.layers && !opts.layers(it.layer)) continue;
      out.push(it);
    }
    return out;
  }

  /** Items fully inside `box` (bbox containment), for rubber-band selection. */
  queryInside(box: Box, opts: PickOptions = {}): RenderItem[] {
    return this.queryBox(box, opts).filter(
      (it) => it.bbox.x >= box.x && it.bbox.y >= box.y && it.bbox.x + it.bbox.w <= box.x + box.w && it.bbox.y + it.bbox.h <= box.y + box.h,
    );
  }

  /** Nearest-first hits within `tolerance` nm of `p`. */
  pick(p: Vec2, tolerance: number, opts: PickOptions = {}): PickHit[] {
    const q: Box = { x: p.x - tolerance, y: p.y - tolerance, w: 2 * tolerance, h: 2 * tolerance };
    const hits: PickHit[] = [];
    for (const it of this.queryBox(q, opts)) {
      if (!boxIntersects(it.bbox, q)) continue;
      let d = Infinity;
      if (!it.prims.length) d = boxDistance(it.bbox, p);
      for (const prim of it.prims) {
        const pd = distanceToPrimitive(p, prim);
        if (pd < d) d = pd;
        if (d === 0) break;
      }
      if (d <= tolerance)
        hits.push({ id: it.id, owner: it.owner ?? it.id, ref: it.ref ?? it.id, layer: it.layer, net: it.net, distance: d, item: it });
    }
    hits.sort((a, b) => a.distance - b.distance || bboxArea(a.item.bbox) - bboxArea(b.item.bbox));
    return opts.limit ? hits.slice(0, opts.limit) : hits;
  }
}

const bboxArea = (b: Box): number => b.w * b.h;

function boxDistance(b: Box, p: Vec2): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}
