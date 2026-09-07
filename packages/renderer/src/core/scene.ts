/**
 * Pixi scene: one Container per layer in a configurable draw order, one display object per
 * RenderItem, per-item rebuild on diffs, white geometry tinted per layer so theme changes
 * never rebuild geometry, GraphicsContext sharing for instanced items (pads by padstack
 * hash, text by content) and pre-triangulated meshes for big polygons (zone fills).
 */
import { Assets, Container, Graphics, GraphicsContext, Mesh, MeshGeometry, Sprite, Texture, earcut } from 'pixi.js';
import type { Primitive, RenderItem, Vec2 } from './model.js';
import { boxCenter, boxIsEmpty } from './model.js';
import { arcToPolylineFixed, bezierToPolyline, circleSegments, circleToPolygon, offsetPathPolygon, stadiumPolygon } from './geometry.js';
import { type Theme, type ThemeColor, colorToHex, layerColor, themeColor } from './theme.js';

/**
 * Hook for primitive kinds the font-free core does not draw itself (`text-glyphs`). Called
 * from `buildGraphics` for every primitive; return true to claim it (nothing else is drawn
 * for it). Display objects go into `host` relative to (ax, ay) in world nm.
 */
export type PrimitiveBuilder = (prim: Primitive, ax: number, ay: number, host: Container) => boolean;

const WHITE = 0xffffff;

/** Display object for one RenderItem. Geometry is relative to (anchorX, anchorY). */
export class ItemObject extends Container {
  anchorX = 0;
  anchorY = 0;
  item!: RenderItem;
  cacheKey?: string;
  /** base alpha from the layer colour, before net dimming */
  baseAlpha = 1;
  /** GPU resources owned by this object (non-shared contexts, mesh geometries) */
  disposables: Array<() => void> = [];
}

export interface LayerEntry {
  id: string;
  container: Container;
  visible: boolean;
  /** user opacity multiplier (setLayerOpacity) */
  alpha: number;
  color: ThemeColor;
}

export interface SceneDiff {
  /** replace everything previously produced by `owner` */
  upsert?: Array<{ owner: string; items: RenderItem[] }>;
  /** owners to remove */
  remove?: string[];
}

export interface SceneOptions {
  /** polygons with at least this many vertices become meshes */
  meshThreshold?: number;
  /** alpha multiplier for items outside the highlighted nets */
  dimAlpha?: number;
  /** builder for primitives the core leaves alone (`text-glyphs`); see PrimitiveBuilder */
  primitiveBuilder?: PrimitiveBuilder;
}

export class Scene {
  readonly root = new Container();
  private layers = new Map<string, LayerEntry>();
  private order: string[] = [];
  private entries = new Map<string, { objs: ItemObject[]; items: RenderItem[] }>();
  private byId = new Map<string, RenderItem>();
  private contextCache = new Map<string, { ctx: GraphicsContext; refs: number }>();
  private originX = 0;
  private originY = 0;
  private highlightNets: Set<string> | null = null;
  readonly meshThreshold: number;
  readonly dimAlpha: number;
  primitiveBuilder?: PrimitiveBuilder;
  /** bumped on every structural change (picker cache key) */
  revision = 0;

  constructor(
    public theme: Theme,
    opts: SceneOptions = {},
  ) {
    this.root.sortableChildren = true;
    // Render group: the root transform (pan / zoom) becomes a GPU uniform and the batched
    // child geometry stays cached between frames instead of being re-transformed on the CPU.
    this.root.isRenderGroup = true;
    this.meshThreshold = opts.meshThreshold ?? 200;
    this.dimAlpha = opts.dimAlpha ?? 0.2;
    this.primitiveBuilder = opts.primitiveBuilder;
  }

  // ------------------------------------------------------------------ queries

  items(): Iterable<RenderItem> {
    return this.byId.values();
  }

  get itemCount(): number {
    return this.byId.size;
  }

  getItem(id: string): RenderItem | undefined {
    return this.byId.get(id);
  }

  /** Render items produced by a store item. */
  ownerItems(owner: string): RenderItem[] {
    const e = this.entries.get(owner);
    if (!e) return [];
    const out: RenderItem[] = [];
    for (const it of e.items) if (this.byId.get(it.id) === it) out.push(it);
    return out;
  }

  objectsOf(owner: string): readonly ItemObject[] {
    return this.entries.get(owner)?.objs ?? [];
  }

  layerIds(): string[] {
    return [...this.layers.keys()];
  }

  get drawOrder(): readonly string[] {
    return this.order;
  }

  // ------------------------------------------------------------------ layers

  layer(id: string): LayerEntry {
    let e = this.layers.get(id);
    if (!e) {
      const container = new Container();
      container.label = id;
      const idx = this.order.indexOf(id);
      container.zIndex = idx >= 0 ? idx : this.order.length + this.layers.size;
      e = { id, container, visible: true, alpha: 1, color: layerColor(this.theme, id) };
      this.layers.set(id, e);
      this.root.addChild(container);
      this.root.sortChildren();
    }
    return e;
  }

  /** Draw order, bottom-most first. Layers not listed are stacked on top in creation order. */
  setDrawOrder(order: string[]): void {
    this.order = [...order];
    let extra = 0;
    for (const e of this.layers.values()) {
      const idx = this.order.indexOf(e.id);
      e.container.zIndex = idx >= 0 ? idx : this.order.length + extra++;
    }
    this.root.sortChildren();
  }

  setLayerVisible(id: string, visible: boolean): void {
    const e = this.layer(id);
    e.visible = visible;
    e.container.visible = visible;
  }

  isLayerVisible(id: string): boolean {
    return this.layers.get(id)?.visible ?? true;
  }

  setLayerAlpha(id: string, alpha: number): void {
    const e = this.layer(id);
    e.alpha = alpha;
    e.container.alpha = alpha;
  }

  getLayerAlpha(id: string): number {
    return this.layers.get(id)?.alpha ?? 1;
  }

  // ------------------------------------------------------------------ theme

  setTheme(theme: Theme): void {
    this.theme = theme;
    for (const e of this.layers.values()) e.color = layerColor(theme, e.id);
    for (const e of this.entries.values()) for (const o of e.objs) this.colourObject(o);
  }

  private colourObject(o: ItemObject): void {
    const c = this.itemColor(o.item);
    o.tint = colorToHex(c);
    o.baseAlpha = c.a;
    o.alpha = this.effectiveAlpha(o);
  }

  /** Colour an item is painted with: its own colour (or theme-key reference) or its layer colour. */
  itemColor(item: RenderItem): ThemeColor {
    const own = item.color;
    if (typeof own === 'string') return themeColor(this.theme, own);
    if (own && !this.theme.overrideSchItemColors) return own;
    return this.layer(item.layer).color;
  }

  private effectiveAlpha(o: ItemObject): number {
    if (!this.highlightNets) return o.baseAlpha;
    const net = o.item.net;
    return net !== undefined && this.highlightNets.has(net) ? o.baseAlpha : o.baseAlpha * this.dimAlpha;
  }

  // ------------------------------------------------------------------ net highlight

  setNetHighlight(nets: string[] | null): void {
    this.highlightNets = nets && nets.length ? new Set(nets) : null;
    for (const e of this.entries.values()) for (const o of e.objs) o.alpha = this.effectiveAlpha(o);
  }

  // ------------------------------------------------------------------ origin

  get origin(): Vec2 {
    return { x: this.originX, y: this.originY };
  }

  /** Move the float32 origin: every item object is re-positioned (no geometry rebuild). */
  setOrigin(ox: number, oy: number): void {
    if (ox === this.originX && oy === this.originY) return;
    this.originX = ox;
    this.originY = oy;
    for (const e of this.entries.values()) {
      for (const o of e.objs) o.position.set(o.anchorX - ox, o.anchorY - oy);
    }
  }

  // ------------------------------------------------------------------ diffs

  apply(diff: SceneDiff): void {
    if (diff.remove) for (const owner of diff.remove) this.removeOwner(owner);
    if (diff.upsert) {
      for (const { owner, items } of diff.upsert) {
        this.removeOwner(owner);
        if (!items.length) continue;
        const objs: ItemObject[] = [];
        for (const item of items) {
          if (item.owner === undefined) item.owner = owner;
          this.byId.set(item.id, item);
          if (!item.prims.length) continue; // bbox-only items (footprint bodies, groups) are pick-only
          const obj = this.build(item);
          objs.push(obj);
          this.layer(item.layer).container.addChild(obj);
        }
        this.entries.set(owner, { objs, items: [...items] });
      }
    }
    this.revision++;
  }

  clear(): void {
    for (const owner of [...this.entries.keys()]) this.removeOwner(owner);
    this.revision++;
  }

  private removeOwner(owner: string): void {
    const e = this.entries.get(owner);
    if (!e) return;
    // Only forget ids this entry still owns: a footprint child's id moves between the footprint
    // entry (drawn from the definition) and the child's own entry (drawn from the store item).
    for (const it of e.items) if (this.byId.get(it.id) === it) this.byId.delete(it.id);
    for (const o of e.objs) {
      this.releaseContext(o.cacheKey);
      o.removeFromParent();
      // Pixi never destroys externally supplied contexts / mesh geometries: do it ourselves
      o.destroy({ children: true, context: false, texture: false });
      for (const d of o.disposables) d();
      o.disposables = [];
    }
    this.entries.delete(owner);
  }

  private releaseContext(key: string | undefined): void {
    if (!key) return;
    const c = this.contextCache.get(key);
    if (!c) return;
    if (--c.refs <= 0) {
      this.contextCache.delete(key);
      c.ctx.destroy();
    }
  }

  get cachedContexts(): number {
    return this.contextCache.size;
  }

  // ------------------------------------------------------------------ building

  private build(item: RenderItem): ItemObject {
    const obj = new ItemObject();
    obj.item = item;
    const anchor = item.anchor ?? (boxIsEmpty(item.bbox) ? { x: 0, y: 0 } : boxCenter(item.bbox));
    obj.anchorX = Math.round(anchor.x);
    obj.anchorY = Math.round(anchor.y);
    obj.position.set(obj.anchorX - this.originX, obj.anchorY - this.originY);

    const ax = obj.anchorX;
    const ay = obj.anchorY;

    // instanced geometry via shared GraphicsContext
    let ctx: GraphicsContext | undefined;
    if (item.cacheKey) {
      const cached = this.contextCache.get(item.cacheKey);
      if (cached) {
        cached.refs++;
        ctx = cached.ctx;
      } else {
        ctx = new GraphicsContext();
        buildGraphics(ctx, item.prims, ax, ay, this.meshThreshold, obj, this.primitiveBuilder);
        this.contextCache.set(item.cacheKey, { ctx, refs: 1 });
      }
      obj.cacheKey = item.cacheKey;
      obj.addChild(new Graphics(ctx));
    } else {
      ctx = new GraphicsContext();
      const used = buildGraphics(ctx, item.prims, ax, ay, this.meshThreshold, obj, this.primitiveBuilder);
      if (used) {
        const g = new Graphics(ctx);
        obj.addChildAt(g, 0);
        const owned = ctx;
        obj.disposables.push(() => owned.destroy());
      } else {
        ctx.destroy();
      }
    }
    this.colourObject(obj);
    return obj;
  }

  destroy(): void {
    this.clear();
    for (const e of this.layers.values()) e.container.destroy({ children: true });
    this.layers.clear();
    this.root.destroy({ children: true });
  }
}

// ---------------------------------------------------------------------------
// Primitive -> Pixi
// ---------------------------------------------------------------------------

const HAIRLINE = { width: 1, pixelLine: true, color: WHITE } as const;

function flat(pts: Vec2[], ax: number, ay: number): number[] {
  const out = new Array<number>(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[2 * i] = pts[i]!.x - ax;
    out[2 * i + 1] = pts[i]!.y - ay;
  }
  return out;
}

/**
 * Emit `prims` into a GraphicsContext relative to (ax, ay). Wide strokes, arcs and circles
 * are tessellated here with zoom-independent segment counts and handed to Pixi as polygon
 * fills; only hairlines (width 0) use Pixi's stroke (1 px `pixelLine`). Meshes and sprites,
 * which cannot live in a GraphicsContext, are added to `host`. Returns true if the context
 * received any drawing instructions.
 */
export function buildGraphics(
  ctx: GraphicsContext,
  prims: Primitive[],
  ax: number,
  ay: number,
  meshThreshold: number,
  host: Container,
  builder?: PrimitiveBuilder,
): boolean {
  let used = false;
  let pendingFill = 0;
  const addFill = (poly: Vec2[]): void => {
    if (poly.length < 3) return;
    ctx.poly(flat(poly, ax, ay), true);
    pendingFill++;
  };
  const flushFill = (): void => {
    if (pendingFill) {
      ctx.fill(WHITE);
      pendingFill = 0;
      used = true;
    }
  };
  const hairline = (pts: Vec2[], closed: boolean): void => {
    if (pts.length < 2) return;
    flushFill();
    ctx.poly(flat(pts, ax, ay), closed).stroke(HAIRLINE);
    used = true;
  };
  const wideOutline = (pts: Vec2[], width: number, closed: boolean): void => {
    const m = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < m; i++) addFill(stadiumPolygon(pts[i]!, pts[(i + 1) % pts.length]!, width));
  };

  for (const p of prims) {
    if (builder && builder(p, ax, ay, host)) continue;
    switch (p.kind) {
      case 'segment':
        if (p.width > 0) addFill(stadiumPolygon(p.a, p.b, p.width));
        else hairline([p.a, p.b], false);
        break;
      case 'arc': {
        const pts = arcToPolylineFixed(p.start, p.mid, p.end);
        if (p.width > 0) addFill(offsetPathPolygon(pts, p.width));
        else hairline(pts, false);
        break;
      }
      case 'circle': {
        const outer = circleToPolygon(p.c, p.r + (p.fill ? 0 : p.width / 2), circleSegments(p.r + p.width / 2));
        if (p.fill) {
          addFill(outer);
          if (p.width > 0) addFill(circleToPolygon(p.c, p.r + p.width / 2, circleSegments(p.r + p.width / 2)));
        } else if (p.width > 0) {
          // ring: outer disc with the inner disc cut out
          flushFill();
          ctx.poly(flat(outer, ax, ay), true).fill(WHITE);
          const inner = p.r - p.width / 2;
          if (inner > 0) ctx.poly(flat(circleToPolygon(p.c, inner, circleSegments(inner)), ax, ay), true).cut();
          used = true;
        } else hairline(outer, true);
        break;
      }
      case 'polygon': {
        if (p.outline.length < 2) break;
        const big = p.mesh || p.outline.length + p.holes.reduce((n, h) => n + h.length, 0) >= meshThreshold;
        if (p.fill && p.outline.length >= 3) {
          if (big) {
            const mesh = buildMesh(p.outline, p.holes, ax, ay);
            if (mesh) {
              host.addChild(mesh);
              const geometry = mesh.geometry;
              if (host instanceof ItemObject) host.disposables.push(() => geometry.destroy());
            }
          } else {
            flushFill();
            ctx.poly(flat(p.outline, ax, ay), true).fill(WHITE);
            for (const h of p.holes) if (h.length >= 3) ctx.poly(flat(h, ax, ay), true).cut();
            used = true;
          }
        }
        if (!p.fill || p.width > 0) {
          const closed = p.outline.length >= 3;
          if (p.width > 0) {
            wideOutline(p.outline, p.width, closed);
            for (const h of p.holes) wideOutline(h, p.width, true);
          } else {
            hairline(p.outline, closed);
            for (const h of p.holes) hairline(h, true);
          }
        }
        break;
      }
      case 'bezier': {
        const pts = bezierToPolyline(p.p0, p.p1, p.p2, p.p3, 24);
        if (p.width > 0) addFill(offsetPathPolygon(pts, p.width));
        else hairline(pts, false);
        break;
      }
      case 'text-shapes':
        for (const poly of p.polys) {
          if (poly.length >= 3) addFill(poly);
          else if (poly.length === 2) hairline(poly, false);
        }
        break;
      case 'image': {
        const sprite = buildSprite(p, ax, ay);
        if (sprite) host.addChild(sprite);
        else hairline([{ x: p.c.x - p.w / 2, y: p.c.y - p.h / 2 }, { x: p.c.x + p.w / 2, y: p.c.y - p.h / 2 }, { x: p.c.x + p.w / 2, y: p.c.y + p.h / 2 }, { x: p.c.x - p.w / 2, y: p.c.y + p.h / 2 }], true);
        break;
      }
      case 'text-glyphs':
        // font-free core: nothing without a builder (the schematic layer supplies one)
        break;
    }
  }
  flushFill();
  return used;
}

/** Pre-triangulated polygon (earcut) as a Mesh with a white texture, tinted by its parent. */
export function buildMesh(outline: Vec2[], holes: Vec2[][], ax: number, ay: number): Mesh | undefined {
  const coords: number[] = flat(outline, ax, ay);
  const holeIdx: number[] = [];
  for (const h of holes) {
    if (h.length < 3) continue;
    holeIdx.push(coords.length / 2);
    coords.push(...flat(h, ax, ay));
  }
  const indices = earcut(coords, holeIdx.length ? holeIdx : undefined, 2);
  if (!indices.length) return undefined;
  const geometry = new MeshGeometry({
    positions: new Float32Array(coords),
    indices: new Uint32Array(indices),
    uvs: new Float32Array(coords.length),
  });
  const mesh = new Mesh({ geometry, texture: Texture.WHITE });
  mesh.label = 'zone-mesh';
  return mesh;
}

function buildSprite(p: Extract<Primitive, { kind: 'image' }>, ax: number, ay: number): Sprite | undefined {
  if (typeof document === 'undefined') return undefined;
  const sprite = new Sprite(Texture.EMPTY);
  sprite.anchor.set(0.5);
  sprite.position.set(p.c.x - ax, p.c.y - ay);
  sprite.width = p.w;
  sprite.height = p.h;
  sprite.tint = WHITE;
  Assets.load<Texture>(p.dataUrl)
    .then((tex) => {
      if (sprite.destroyed) return;
      sprite.texture = tex;
      sprite.width = p.w;
      sprite.height = p.h;
    })
    .catch(() => {
      /* keep the empty texture */
    });
  return sprite;
}
