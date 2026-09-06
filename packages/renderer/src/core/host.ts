/**
 * BaseCanvasHost: the docs/contracts.md `CanvasHost` over an ItemStore-shaped object.
 * Subclasses supply `toRenderItems(item)` and `drawOrder()`.
 */
import { Application } from 'pixi.js';
import type { Box, RenderItem, Vec2 } from './model.js';
import { EMPTY_BOX, boxUnion, boxIsEmpty } from './model.js';
import { type Theme, colorToHex, uiColors } from './theme.js';
import { Camera, CameraController, type CameraState, type CameraControllerOptions, type CameraAnimationOptions, animateCamera } from './camera.js';
import { Scene, type SceneOptions } from './scene.js';
import { Picker } from './picker.js';
import { Overlays, type OverlayOptions } from './overlays.js';
import { RatsnestLayer, type RatsnestEdge } from './ratsnest.js';
import { MarkerLayer, type MarkerSpec } from './markers.js';

// ---------------------------------------------------------------------------
// Contract types (structural copies of docs/contracts.md so this package has no
// dependency on @kicad-web/client)
// ---------------------------------------------------------------------------

export interface StoredItemLike {
  id: string;
  type: string;
  layer?: string;
  net?: string;
  parent?: string;
  proto: unknown;
  bbox?: Box;
}

export interface StoreDiffLike {
  added: StoredItemLike[];
  updated: StoredItemLike[];
  removed: string[];
  revision?: number;
}

export interface ItemStoreLike {
  readonly kind: string;
  all(): Iterable<StoredItemLike>;
  get(id: string): StoredItemLike | undefined;
  subscribe(cb: (diff: StoreDiffLike) => void): () => void;
}

export interface PickResult {
  id: string;
  /** screen px from the pointer to the item (0 = inside) */
  distance: number;
  /** store item owning the hit (footprint for a pad); same as id for top-level items */
  owner: string;
  /** KIID of the picked object without any `@layer` suffix (pad / via / zone KIID) */
  ref: string;
  layer: string;
  net?: string;
}

export interface CanvasHost {
  mount(el: HTMLElement, store: ItemStoreLike, theme: Theme): void;
  unmount(): void;
  setTheme(theme: Theme): void;
  setCamera(cam: Partial<CameraState>): void;
  getCamera(): CameraState;
  zoomToFit(): void;
  setLayerVisible(layer: string, visible: boolean): void;
  setLayerOpacity(layer: string, alpha: number): void;
  setActiveLayer(layer: string): void;
  setSelection(ids: string[]): void;
  setHighlightNets(nets: string[]): void;
  pick(screenX: number, screenY: number, tolerancePx?: number): PickResult[];
  screenToWorld(x: number, y: number): Vec2;
  worldToScreen(x: number, y: number): Vec2;
  onPick(cb: (hits: PickResult[], ev: PointerEvent) => void): () => void;
  onHover(cb: (hit: PickResult | null, ev: PointerEvent) => void): () => void;
  onCameraChange(cb: (cam: CameraState) => void): () => void;
}

export interface BoxSelectEvent {
  /** world nm */
  box: Box;
  /** items whose bbox is fully inside (drag left→right) or touching (right→left) the box */
  hits: PickResult[];
  /** true when the drag went right→left (KiCad "touching" selection) */
  touching: boolean;
}

/**
 * Renderer destroy options for `Application.destroy(rendererDestroyOptions, ...)`.
 *
 * MUST NOT be `true`, and must never set `releaseGlobalResources`: several hosts can be
 * mounted at once (the editor canvas plus a library preview), and Pixi's "global resources"
 * are process-wide pools shared by *every* renderer — `BigPool`, `TexturePool`, `CanvasPool`
 * and the batcher's `batchPool`.
 *
 * `AbstractRenderer.destroy(true)` calls `GlobalResourceRegistry.release()`, which clears all
 * of them. The batcher pool's `clear()` walks the whole `batchPool` array and `destroy()`s
 * every entry, including the slots above its stack pointer — and those hold `Batch` objects
 * that other, still-live renderers have checked out and are actively drawing with.
 * `Batch.destroy()` nulls `textures`, so the surviving host's next frame parks the dead batch
 * back in the pool (`Batcher.begin`), pulls it out again (`Batcher.break` -> `getBatchFromPool`)
 * and throws `Cannot read properties of null (reading 'clear')` on `batch.textures.clear()`.
 *
 * `{ removeView: true }` gives `ViewSystem.destroy` the same canvas removal that `true` did
 * (it reads `options.removeView`) without touching the shared pools. Nothing else here owns
 * those pools, so we simply never release them; they are bounded caches that Pixi reuses.
 */
const RENDERER_DESTROY_OPTIONS = { removeView: true } as const;

export interface CanvasHostOptions {
  /** what a left-button drag does; default rubber-band selection */
  leftDrag?: 'rubberband' | 'pan' | 'none';
  pickTolerancePx?: number;
  hoverTolerancePx?: number;
  preference?: 'webgl' | 'webgpu';
  antialias?: boolean;
  overlays?: OverlayOptions;
  scene?: SceneOptions;
  camera?: Omit<CameraControllerOptions, 'onFrame'>;
  /** override the theme background */
  background?: number;
}

export abstract class BaseCanvasHost implements CanvasHost {
  protected readonly kind: 'board' | 'schematic' = 'board';
  protected el?: HTMLElement;
  protected store?: ItemStoreLike;
  theme: Theme;
  readonly camera = new Camera();
  scene: Scene;
  picker: Picker;
  overlays: Overlays;
  /** unrouted connections (`setRatsnest`) */
  ratsnest: RatsnestLayer;
  /** DRC / ERC marker glyphs (`setMarkers`) */
  markers: MarkerLayer;
  protected app?: Application;
  protected controller?: CameraController;
  protected flipped = false;
  /** resolves when the WebGL/WebGPU context is up and the first frame can be drawn */
  ready: Promise<void> = Promise.resolve();
  readonly options: CanvasHostOptions;

  private ro?: ResizeObserver;
  private unsubStore?: () => void;
  private unsubCamera?: () => void;
  private pickCbs = new Set<(hits: PickResult[], ev: PointerEvent) => void>();
  private hoverCbs = new Set<(hit: PickResult | null, ev: PointerEvent) => void>();
  private boxCbs = new Set<(ev: BoxSelectEvent, pointer: PointerEvent) => void>();
  private cameraCbs = new Set<(cam: CameraState) => void>();
  private raf = 0;
  private selectionIds: string[] = [];
  private hoverId: string | null = null;
  private pendingHover: PointerEvent | null = null;
  private drag: { start: Vec2; pointerId: number; dragging: boolean } | null = null;
  private detachFns: Array<() => void> = [];
  private fitPending = true;
  private cancelAnimation: (() => void) | null = null;

  constructor(theme: Theme, options: CanvasHostOptions = {}) {
    this.theme = theme;
    this.options = options;
    this.scene = new Scene(theme, options.scene);
    this.picker = new Picker(() => this.scene.items());
    // `kind` is overridden by a subclass field initialised after this constructor; the
    // schematic host re-keys the overlays / markers to 'schematic' in its own constructor.
    this.overlays = new Overlays(theme, this.kind, options.overlays);
    this.ratsnest = new RatsnestLayer(theme);
    this.ratsnest.dimAlpha = this.scene.dimAlpha;
    this.markers = new MarkerLayer(theme, this.kind);
    this.scene.root.addChild(this.ratsnest.root, this.markers.root);
  }

  /** Convert one store item into render items. */
  protected abstract toRenderItems(item: StoredItemLike): RenderItem[];
  /** Layer draw order, bottom-most first. */
  protected abstract drawOrder(): string[];

  // ------------------------------------------------------------------ lifecycle

  mount(el: HTMLElement, store: ItemStoreLike, theme: Theme): void {
    if (this.el) this.unmount();
    this.el = el;
    this.store = store;
    this.theme = theme;
    this.scene.setTheme(theme);
    this.overlays.setTheme(theme, this.kind);
    this.scene.setDrawOrder(this.drawOrder());
    this.fitPending = true;
    this.loadAll();
    this.unsubStore = store.subscribe((diff) => this.applyStoreDiff(diff));
    this.unsubCamera = this.camera.onChange((cam) => {
      this.requestRender();
      for (const cb of this.cameraCbs) cb(cam);
    });
    this.ready = this.initApp(el);
  }

  private async initApp(el: HTMLElement): Promise<void> {
    const app = new Application();
    const width = Math.max(1, el.clientWidth);
    const height = Math.max(1, el.clientHeight);
    await app.init({
      preference: this.options.preference ?? 'webgl',
      antialias: this.options.antialias ?? true,
      resolution: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
      autoDensity: true,
      width,
      height,
      background: this.options.background ?? colorToHex(uiColors(this.theme, this.kind).background),
      backgroundAlpha: 1,
      autoStart: false,
      sharedTicker: false,
    });
    if (this.el !== el) {
      app.destroy(RENDERER_DESTROY_OPTIONS);
      return; // unmounted while initialising
    }
    this.app = app;
    const canvas = app.canvas;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.style.outline = 'none';
    el.appendChild(canvas);
    app.stage.addChild(this.scene.root, this.overlays.root);
    this.camera.setViewport(width, height);
    const leftDrag = this.options.leftDrag ?? 'rubberband';
    const camOpts = { ...(this.options.camera ?? {}) };
    if (leftDrag === 'pan') camOpts.panButtons = [...(camOpts.panButtons ?? [1]), 0];
    this.controller = new CameraController(this.camera, canvas, { ...camOpts, onFrame: () => this.requestRender() });
    this.attachPointer(canvas);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(el);
    }
    if (this.fitPending) this.zoomToFit();
    this.requestRender();
  }

  /**
   * Switch to another store (a different schematic sheet) without tearing down the canvas:
   * the scene is rebuilt from the new store and the store subscription moves with it. The
   * camera is left where it is; `SchematicCanvasHost` layers per-sheet camera memory on top.
   */
  setStore(store: ItemStoreLike): void {
    if (store === this.store) return;
    this.unsubStore?.();
    this.store = store;
    this.hoverId = null;
    this.overlays.setHover(null);
    this.loadAll();
    this.unsubStore = store.subscribe((diff) => this.applyStoreDiff(diff));
    this.refreshSelection();
    this.requestRender();
  }

  /** The store currently rendered. */
  get currentStore(): ItemStoreLike | undefined {
    return this.store;
  }

  unmount(): void {
    this.cancelAnimation?.();
    this.cancelAnimation = null;
    this.unsubStore?.();
    this.unsubCamera?.();
    this.unsubStore = undefined;
    this.unsubCamera = undefined;
    this.ro?.disconnect();
    this.ro = undefined;
    this.controller?.detach();
    this.controller = undefined;
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.app) {
      this.app.stage.removeChild(this.scene.root, this.overlays.root);
      this.app.canvas.remove();
      this.app.destroy(RENDERER_DESTROY_OPTIONS, { children: false });
      this.app = undefined;
    }
    this.scene.clear();
    this.el = undefined;
    this.store = undefined;
    this.picker.invalidate();
  }

  private resize(): void {
    if (!this.el || !this.app) return;
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    if (w === this.camera.width && h === this.camera.height) return;
    this.app.renderer.resize(w, h);
    this.camera.setViewport(w, h);
    this.requestRender();
  }

  // ------------------------------------------------------------------ store

  private loadAll(): void {
    if (!this.store) return;
    this.scene.clear();
    const upsert: Array<{ owner: string; items: RenderItem[] }> = [];
    for (const it of this.store.all()) upsert.push({ owner: it.id, items: this.safeConvert(it) });
    this.scene.apply({ upsert });
    this.picker.invalidate();
    this.requestRender();
  }

  private safeConvert(it: StoredItemLike): RenderItem[] {
    try {
      return this.toRenderItems(it);
    } catch (err) {
      console.warn(`[renderer] failed to convert ${it.type} ${it.id}:`, err);
      return [];
    }
  }

  protected applyStoreDiff(diff: StoreDiffLike): void {
    const upsert = [...diff.added, ...diff.updated].map((it) => ({ owner: it.id, items: this.safeConvert(it) }));
    this.scene.apply({ upsert, remove: diff.removed });
    this.picker.invalidate();
    this.refreshSelection();
    this.requestRender();
  }

  /** Re-run the adapter for every item (e.g. after pad polygons / text shapes arrive). */
  rebuildAll(): void {
    this.loadAll();
    this.refreshSelection();
  }

  /** Re-run the adapter for the given store items. */
  rebuildItems(ids: string[]): void {
    if (!this.store) return;
    const upsert: Array<{ owner: string; items: RenderItem[] }> = [];
    const remove: string[] = [];
    for (const id of ids) {
      const it = this.store.get(id);
      if (it) upsert.push({ owner: id, items: this.safeConvert(it) });
      else remove.push(id);
    }
    this.scene.apply({ upsert, remove });
    this.picker.invalidate();
    this.refreshSelection();
    this.requestRender();
  }

  // ------------------------------------------------------------------ rendering

  requestRender(): void {
    if (this.raf || !this.app) return;
    if (typeof requestAnimationFrame !== 'function') return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (!this.app) return;
    if (this.camera.maybeRebase()) {
      this.scene.setOrigin(this.camera.originX, this.camera.originY);
      this.ratsnest.setOrigin(this.camera.originX, this.camera.originY);
      this.markers.setOrigin(this.camera.originX, this.camera.originY);
    }
    const t = this.camera.rootTransform();
    this.scene.root.position.set(t.x, t.y);
    this.scene.root.scale.set(t.scaleX, t.scaleY);
    if (this.pendingHover) {
      const ev = this.pendingHover;
      this.pendingHover = null;
      this.updateHover(ev);
    }
    this.ratsnest.update();
    this.markers.update(this.camera.zoom);
    this.overlays.redraw(this.camera);
    this.app.render();
  };

  /** Render synchronously (tests / screenshots). */
  renderNow(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.frame();
  }

  // ------------------------------------------------------------------ CanvasHost API

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.scene.setTheme(theme);
    this.overlays.setTheme(theme, this.kind);
    this.ratsnest.setTheme(theme);
    this.markers.setTheme(theme);
    if (this.app) this.app.renderer.background.color = this.options.background ?? colorToHex(uiColors(theme, this.kind).background);
    this.requestRender();
  }

  setCamera(cam: Partial<CameraState>): void {
    this.fitPending = false;
    this.camera.setState(cam);
  }

  getCamera(): CameraState {
    return this.camera.getState();
  }

  /** Union bbox of every render item. */
  contentBox(): Box {
    let b = EMPTY_BOX;
    for (const it of this.scene.items()) b = boxUnion(b, it.bbox);
    return b;
  }

  zoomToFit(): void {
    const b = this.contentBox();
    if (boxIsEmpty(b)) return;
    this.fitPending = false;
    this.camera.zoomToBox(b);
  }

  setLayerVisible(layer: string, visible: boolean): void {
    const severity = MarkerLayer.severityOfLayer(layer);
    if (severity) this.markers.setSeverityVisible(severity, visible);
    else if (layer === 'board.ratsnest') this.ratsnest.setVisible(visible);
    else this.scene.setLayerVisible(layer, visible);
    this.requestRender();
  }

  setLayerOpacity(layer: string, alpha: number): void {
    this.scene.setLayerAlpha(layer, alpha);
    this.requestRender();
  }

  setActiveLayer(_layer: string): void {
    this.scene.setDrawOrder(this.drawOrder());
    this.requestRender();
  }

  /** View from the back (mirrored X, back layers on top). */
  flipView(flipped: boolean): void {
    this.flipped = flipped;
    this.camera.setFlip(flipped);
    this.scene.setDrawOrder(this.drawOrder());
    this.requestRender();
  }

  get isFlipped(): boolean {
    return this.flipped;
  }

  setSelection(ids: string[]): void {
    this.selectionIds = [...ids];
    this.refreshSelection();
    this.requestRender();
  }

  private refreshSelection(): void {
    const items: RenderItem[] = [];
    for (const id of this.selectionIds) {
      const owned = this.scene.ownerItems(id);
      if (owned.length) items.push(...owned);
      else {
        const it = this.scene.getItem(id);
        if (it) items.push(it);
      }
    }
    this.overlays.setSelection(items);
    const refs = new Set<string>(this.selectionIds);
    for (const it of items) refs.add(it.ref ?? it.id);
    this.ratsnest.setSelectedRefs(refs);
    if (this.hoverId && !this.scene.getItem(this.hoverId)) {
      this.hoverId = null;
      this.overlays.setHover(null);
    }
  }

  setHighlightNets(nets: string[]): void {
    this.scene.setNetHighlight(nets);
    this.ratsnest.setHighlightNets(nets);
    this.requestRender();
  }

  pick(screenX: number, screenY: number, tolerancePx = this.options.pickTolerancePx ?? 6): PickResult[] {
    const w = this.camera.screenToWorld(screenX, screenY);
    const tol = tolerancePx / this.camera.zoom;
    const zoom = this.camera.zoom;
    // markers are drawn above everything, so they come first
    const markerHits: PickResult[] = this.markers.pick(w, tol).map((h) => ({ id: `marker:${h.id}`, owner: 'marker', ref: h.id, layer: h.layer, distance: h.distance * zoom }));
    const hits = this.picker
      .pick(w, tol, { layers: (l) => this.scene.isLayerVisible(l) })
      .map((h) => ({ id: h.id, owner: h.owner, ref: h.ref, layer: h.layer, net: h.net, distance: h.distance * zoom }));
    return markerHits.length ? [...markerHits, ...hits] : hits;
  }

  // ------------------------------------------------------------------ ratsnest / markers

  /**
   * Unrouted connections (airlines) from `GetRatsnest`: one edge per `RatsnestEdge`
   * (`a` = source_position, `b` = target_position). Edges of highlighted nets or touching a
   * selected item are emphasised; the rest is dimmed while any emphasis is active.
   */
  setRatsnest(edges: RatsnestEdge[]): void {
    this.ratsnest.setEdges(edges);
    this.requestRender();
  }

  setRatsnestVisible(visible: boolean): void {
    this.ratsnest.setVisible(visible);
    this.requestRender();
  }

  /**
   * DRC / ERC markers. Picking a marker yields `{ id: 'marker:<id>', ref: <id>, owner: 'marker',
   * layer: 'board.drc_error' | ... }`. Per-severity visibility goes through
   * `setLayerVisible('board.drc_warning' | 'schematic.erc_warning' | ..., visible)`.
   */
  setMarkers(markers: MarkerSpec[]): void {
    this.markers.setMarkers(markers);
    this.requestRender();
  }

  setMarkersVisible(visible: boolean): void {
    this.markers.setVisible(visible);
    this.requestRender();
  }

  /**
   * Animate the camera to a marker (ease-out; an immediate jump with
   * `prefers-reduced-motion` or `durationMs: 0`) and show its violation legend. `zoom`
   * sets a target zoom (px per nm); by default the zoom is kept unless the glyph would be
   * smaller than ~12 px, in which case the view zooms in to 40 px/mm. Returns false for an
   * unknown id.
   */
  focusMarker(id: string | null, opts: CameraAnimationOptions & { zoom?: number } = {}): boolean {
    this.cancelAnimation?.();
    this.cancelAnimation = null;
    if (id === null) {
      this.markers.setFocused(null);
      this.requestRender();
      return true;
    }
    const m = this.markers.get(id);
    if (!m) return false;
    this.markers.setFocused(id);
    this.fitPending = false;
    let zoom = opts.zoom;
    if (zoom === undefined && this.camera.zoom < 1e-5) zoom = 4e-5;
    this.cancelAnimation = animateCamera(this.camera, { x: m.position.x, y: m.position.y, zoom }, {
      durationMs: opts.durationMs,
      reducedMotion: opts.reducedMotion,
      onDone: () => {
        this.cancelAnimation = null;
        opts.onDone?.();
      },
    });
    this.requestRender();
    return true;
  }

  /** Marker currently focused (legend shown), if any. */
  get focusedMarker(): string | null {
    return this.markers.focused;
  }

  /** Items in a world box (for the app's own box-select tools). */
  pickBox(box: Box, touching = false): PickResult[] {
    const items = touching ? this.picker.queryBox(box, { layers: (l) => this.scene.isLayerVisible(l) }) : this.picker.queryInside(box, { layers: (l) => this.scene.isLayerVisible(l) });
    return items.map((it) => ({ id: it.id, owner: it.owner ?? it.id, ref: it.ref ?? it.id, layer: it.layer, net: it.net, distance: 0 }));
  }

  screenToWorld(x: number, y: number): Vec2 {
    return this.camera.screenToWorld(x, y);
  }

  worldToScreen(x: number, y: number): Vec2 {
    return this.camera.worldToScreen(x, y);
  }

  onPick(cb: (hits: PickResult[], ev: PointerEvent) => void): () => void {
    this.pickCbs.add(cb);
    return () => this.pickCbs.delete(cb);
  }

  onHover(cb: (hit: PickResult | null, ev: PointerEvent) => void): () => void {
    this.hoverCbs.add(cb);
    return () => this.hoverCbs.delete(cb);
  }

  onBoxSelect(cb: (ev: BoxSelectEvent, pointer: PointerEvent) => void): () => void {
    this.boxCbs.add(cb);
    return () => this.boxCbs.delete(cb);
  }

  onCameraChange(cb: (cam: CameraState) => void): () => void {
    this.cameraCbs.add(cb);
    return () => this.cameraCbs.delete(cb);
  }

  /** Render item by id (pad / track / ...). */
  getRenderItem(id: string): RenderItem | undefined {
    return this.scene.getItem(id);
  }

  /** The Pixi canvas, once ready. */
  get canvas(): HTMLCanvasElement | undefined {
    return this.app?.canvas;
  }

  // ------------------------------------------------------------------ pointer

  private attachPointer(canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (ev: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, fn as EventListener);
      this.detachFns.push(() => canvas.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => this.onPointerMove(e));
    on('pointerup', (e) => this.onPointerUp(e));
    on('pointercancel', (e) => this.onPointerUp(e));
    on('pointerleave', (e) => {
      if (this.hoverId !== null) {
        this.hoverId = null;
        this.overlays.setHover(null);
        for (const cb of this.hoverCbs) cb(null, e);
        this.requestRender();
      }
    });
  }

  private local(e: PointerEvent): Vec2 {
    // `currentTarget` is only set while the event dispatches; hover updates are deferred to
    // the next frame, so fall back to the canvas element.
    const target = (e.currentTarget as HTMLElement | null) ?? this.app?.canvas;
    if (!target) return { x: e.clientX, y: e.clientY };
    const r = target.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    this.drag = { start: this.local(e), pointerId: e.pointerId, dragging: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.drag && e.pointerId === this.drag.pointerId && (e.buttons & 1) === 1) {
      const d = Math.hypot(p.x - this.drag.start.x, p.y - this.drag.start.y);
      if (!this.drag.dragging && d > 4) this.drag.dragging = true;
      if (this.drag.dragging && (this.options.leftDrag ?? 'rubberband') === 'rubberband') {
        this.overlays.setRubberBand(boxFromCorners(this.drag.start, p));
        this.requestRender();
      }
      return;
    }
    if (e.buttons === 0) {
      this.pendingHover = e;
      this.requestRender();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    const p = this.local(e);
    if (drag.dragging) {
      if ((this.options.leftDrag ?? 'rubberband') === 'rubberband') {
        this.overlays.setRubberBand(null);
        const a = this.camera.screenToWorld(drag.start.x, drag.start.y);
        const b = this.camera.screenToWorld(p.x, p.y);
        const box = boxFromCorners(a, b);
        const touching = p.x < drag.start.x;
        const hits = this.pickBox(box, touching);
        for (const cb of this.boxCbs) cb({ box, hits, touching }, e);
        this.requestRender();
      }
      return;
    }
    if (e.button !== 0) return;
    const hits = this.pick(p.x, p.y);
    for (const cb of this.pickCbs) cb(hits, e);
  }

  private updateHover(e: PointerEvent): void {
    const p = this.local(e);
    const hits = this.pick(p.x, p.y, this.options.hoverTolerancePx ?? this.options.pickTolerancePx ?? 6);
    const top = hits[0] ?? null;
    const id = top?.id ?? null;
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.overlays.setHover(id ? (this.scene.getItem(id) ?? null) : null);
    for (const cb of this.hoverCbs) cb(top, e);
  }
}

function boxFromCorners(a: Vec2, b: Vec2): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
