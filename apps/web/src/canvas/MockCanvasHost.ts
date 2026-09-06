// A plain Canvas2D CanvasHost that draws the mock stores (lines, rects, circles, text)
// so the shell is usable before `@kicad-web/renderer` lands. Implements the full
// CanvasHost contract; the extras (`setGrid`, `setBackgroundHint`) are opt-in.

import type { Camera, CanvasHost, DocumentKind, ItemStore, PickResult, StoredItem, Theme } from '@/contracts';
import { BOARD_LAYERS } from '@/lib/enums';
import { mockPalette, type MockPalette } from './theme';

type Vec = { xNm: number; yNm: number };

interface Listener<T extends unknown[]> {
  (...args: T): void;
}

const LAYER_ORDER = new Map<string, number>(BOARD_LAYERS.map((l, i) => [l, i]));

function layerOrder(layer: string | undefined): number {
  if (!layer) return 100;
  return LAYER_ORDER.get(layer) ?? 90;
}

function rgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)},${alpha})`;
}

export class MockCanvasHost implements CanvasHost {
  private el: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private store: ItemStore | null = null;
  private theme: MockPalette | null = null;
  private cam: Camera = { x: 0, y: 0, zoom: 0.00002 };
  private hidden = new Set<string>();
  private opacity = new Map<string, number>();
  private activeLayer = 'BL_F_Cu';
  private selection = new Set<string>();
  private highlightNets = new Set<string>();
  private hoverId: string | null = null;
  private pickSubs = new Set<Listener<[PickResult[], PointerEvent]>>();
  private hoverSubs = new Set<Listener<[PickResult | null, PointerEvent]>>();
  private camSubs = new Set<Listener<[Camera]>>();
  private unsubStore: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private drag: { x: number; y: number; camX: number; camY: number; moved: boolean; button: number } | null = null;
  private gridNm = 1_270_000;
  private showGrid = true;
  private cleanup: (() => void)[] = [];

  constructor(readonly kind: DocumentKind) {}

  // ------------------------------------------------------------------ lifecycle

  mount(el: HTMLElement, store: ItemStore, theme: Theme): void {
    this.unmount();
    this.el = el;
    this.store = store;
    this.theme = mockPalette(theme, this.kind);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;outline:none';
    canvas.tabIndex = -1;
    canvas.setAttribute('aria-label', `${this.kind} canvas`);
    el.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.unsubStore = store.subscribe(() => this.invalidate());

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(el);
    }
    this.resize();

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      canvas.addEventListener(type, fn, opts);
      this.cleanup.push(() => canvas.removeEventListener(type, fn, opts));
    };
    on('wheel', (ev) => this.onWheel(ev), { passive: false });
    on('pointerdown', (ev) => this.onPointerDown(ev));
    on('pointermove', (ev) => this.onPointerMove(ev));
    on('pointerup', (ev) => this.onPointerUp(ev));
    on('pointerleave', (ev) => {
      if (this.hoverId !== null) {
        this.hoverId = null;
        for (const cb of this.hoverSubs) cb(null, ev);
        this.invalidate();
      }
    });
    on('contextmenu', (ev) => ev.preventDefault());
    if (this.cam.zoom <= 0 || this.width === 0) this.cam.zoom = 0.00002;
    this.zoomToFit();
  }

  unmount(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.ro?.disconnect();
    this.ro = null;
    this.unsubStore?.();
    this.unsubStore = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.el = null;
    this.store = null;
  }

  private resize(): void {
    if (!this.el || !this.canvas) return;
    const rect = this.el.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.invalidate();
  }

  // ------------------------------------------------------------------- contract

  setTheme(theme: Theme): void {
    this.theme = mockPalette(theme, this.kind);
    this.invalidate();
  }

  setCamera(cam: Partial<Camera>): void {
    this.cam = { ...this.cam, ...cam };
    if (!(this.cam.zoom > 0)) this.cam.zoom = 0.00002;
    this.emitCamera();
    this.invalidate();
  }

  getCamera(): Camera {
    return { ...this.cam };
  }

  zoomToFit(): void {
    const b = this.bounds();
    if (!b || this.width === 0) return;
    const pad = 0.9;
    const zx = (this.width * pad) / Math.max(b.w, 1);
    const zy = (this.height * pad) / Math.max(b.h, 1);
    this.cam = { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom: Math.min(zx, zy) };
    this.emitCamera();
    this.invalidate();
  }

  setLayerVisible(layer: string, visible: boolean): void {
    if (visible) this.hidden.delete(layer);
    else this.hidden.add(layer);
    this.invalidate();
  }

  setLayerOpacity(layer: string, alpha: number): void {
    this.opacity.set(layer, alpha);
    this.invalidate();
  }

  setActiveLayer(layer: string): void {
    this.activeLayer = layer;
    this.invalidate();
  }

  setSelection(ids: string[]): void {
    this.selection = new Set(ids);
    this.invalidate();
  }

  setHighlightNets(nets: string[]): void {
    this.highlightNets = new Set(nets);
    this.invalidate();
  }

  /** Extra (not in the contract): grid spacing/visibility for the status bar toggle. */
  setGrid(nm: number, show: boolean): void {
    this.gridNm = nm;
    this.showGrid = show;
    this.invalidate();
  }

  pick(screenX: number, screenY: number, tolerancePx = 6): PickResult[] {
    if (!this.store) return [];
    const w = this.screenToWorld(screenX, screenY);
    const tolNm = tolerancePx / this.cam.zoom;
    const hits: (PickResult & { area: number })[] = [];
    for (const it of this.store.all()) {
      if (!this.visible(it)) continue;
      const b = it.bbox;
      if (!b) continue;
      const dx = Math.max(b.x - w.x, 0, w.x - (b.x + b.w));
      const dy = Math.max(b.y - w.y, 0, w.y - (b.y + b.h));
      const dist = Math.hypot(dx, dy);
      if (dist <= tolNm) hits.push({ id: it.id, distance: dist * this.cam.zoom, area: b.w * b.h, owner: it.parent ?? it.id, ref: it.id, layer: it.layer ?? '', net: it.net });
    }
    hits.sort((a, b) => a.distance - b.distance || a.area - b.area);
    return hits.map(({ area: _area, ...hit }) => hit);
  }

  screenToWorld(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.width / 2) / this.cam.zoom + this.cam.x, y: (y - this.height / 2) / this.cam.zoom + this.cam.y };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.cam.x) * this.cam.zoom + this.width / 2, y: (y - this.cam.y) * this.cam.zoom + this.height / 2 };
  }

  onPick(cb: (hits: PickResult[], ev: PointerEvent) => void): () => void {
    this.pickSubs.add(cb);
    return () => this.pickSubs.delete(cb);
  }

  onHover(cb: (hit: PickResult | null, ev: PointerEvent) => void): () => void {
    this.hoverSubs.add(cb);
    return () => this.hoverSubs.delete(cb);
  }

  onCameraChange(cb: (cam: Camera) => void): () => void {
    this.camSubs.add(cb);
    return () => this.camSubs.delete(cb);
  }

  // ----------------------------------------------------------------------- input

  private local(ev: MouseEvent): { x: number; y: number } {
    const r = this.canvas!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const p = this.local(ev);
    if (ev.ctrlKey || !ev.shiftKey) {
      const before = this.screenToWorld(p.x, p.y);
      const factor = Math.exp(-ev.deltaY * 0.0015);
      const zoom = Math.min(Math.max(this.cam.zoom * factor, 1e-7), 0.01);
      this.cam.zoom = zoom;
      const after = this.screenToWorld(p.x, p.y);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
    } else {
      this.cam.x += ev.deltaY / this.cam.zoom;
    }
    this.emitCamera();
    this.invalidate();
  }

  private onPointerDown(ev: PointerEvent): void {
    this.canvas?.focus();
    const p = this.local(ev);
    this.drag = { x: p.x, y: p.y, camX: this.cam.x, camY: this.cam.y, moved: false, button: ev.button };
    this.canvas?.setPointerCapture(ev.pointerId);
  }

  private onPointerMove(ev: PointerEvent): void {
    const p = this.local(ev);
    if (this.drag && (this.drag.button === 1 || this.drag.button === 2 || (this.drag.button === 0 && ev.shiftKey === false && ev.altKey))) {
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.drag.moved = true;
      this.cam.x = this.drag.camX - dx / this.cam.zoom;
      this.cam.y = this.drag.camY - dy / this.cam.zoom;
      this.emitCamera();
      this.invalidate();
      return;
    }
    if (this.drag && this.drag.button === 0) {
      const dx = p.x - this.drag.x;
      const dy = p.y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
    }
    const hit = this.pick(p.x, p.y)[0] ?? null;
    const id = hit?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      for (const cb of this.hoverSubs) cb(hit, ev);
      this.invalidate();
    } else {
      // still emit for cursor tracking
      for (const cb of this.hoverSubs) cb(hit, ev);
    }
  }

  private onPointerUp(ev: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvas?.releasePointerCapture(ev.pointerId);
    if (!d) return;
    if (d.button === 0 && !d.moved) {
      const p = this.local(ev);
      const hits = this.pick(p.x, p.y);
      for (const cb of this.pickSubs) cb(hits, ev);
    }
  }

  private emitCamera(): void {
    const c = this.getCamera();
    for (const cb of this.camSubs) cb(c);
  }

  // -------------------------------------------------------------------- drawing

  private bounds(): { x: number; y: number; w: number; h: number } | null {
    if (!this.store) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const it of this.store.all()) {
      const b = it.bbox;
      if (!b) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  invalidate(): void {
    if (this.raf || !this.ctx) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private visible(it: StoredItem): boolean {
    if (it.layer && this.hidden.has(it.layer)) return false;
    if (it.parent && this.store) {
      const parent = this.store.get(it.parent);
      if (parent?.layer && this.hidden.has(parent.layer) && it.type !== 'KOT_PCB_PAD') return false;
    }
    return true;
  }

  private alphaFor(it: StoredItem): number {
    let a = it.layer ? (this.opacity.get(it.layer) ?? 1) : 1;
    if (this.highlightNets.size > 0 && !(it.net && this.highlightNets.has(it.net))) a *= 0.18;
    return a;
  }

  private draw(): void {
    const ctx = this.ctx;
    const theme = this.theme;
    const store = this.store;
    if (!ctx || !theme || !store) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.ui.background;
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.showGrid) this.drawGrid(ctx, theme);

    const z = this.cam.zoom;
    const items = [...store.all()].filter((it) => this.visible(it));
    items.sort((a, b) => {
      const la = a.layer === this.activeLayer ? 1000 : layerOrder(a.layer);
      const lb = b.layer === this.activeLayer ? 1000 : layerOrder(b.layer);
      // draw later layers (higher index) first so front copper ends up on top; active layer last
      return lb - la;
    });

    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(z, z);
    ctx.translate(-this.cam.x, -this.cam.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const it of items) {
      ctx.globalAlpha = this.alphaFor(it);
      this.drawItem(ctx, it, theme, z);
    }

    // origin marker
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.ui.grid;
    ctx.lineWidth = 1 / z;
    const o = 3_000_000;
    ctx.beginPath();
    ctx.moveTo(-o, 0);
    ctx.lineTo(o, 0);
    ctx.moveTo(0, -o);
    ctx.lineTo(0, o);
    ctx.stroke();

    // hover + selection overlays
    for (const it of items) {
      const sel = this.selection.has(it.id);
      const hov = this.hoverId === it.id;
      if (!sel && !hov) continue;
      const b = it.bbox;
      if (!b) continue;
      ctx.strokeStyle = sel ? theme.ui.selection : theme.ui.hover;
      ctx.lineWidth = (sel ? 2 : 1) / z;
      ctx.setLineDash(sel ? [] : [4 / z, 3 / z]);
      const m = 2 / z;
      ctx.strokeRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  private drawGrid(ctx: CanvasRenderingContext2D, theme: MockPalette): void {
    let step = this.gridNm;
    const z = this.cam.zoom;
    while (step * z < 8) step *= 2;
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.width, this.height);
    const x0 = Math.floor(tl.x / step) * step;
    const y0 = Math.floor(tl.y / step) * step;
    ctx.fillStyle = rgba(theme.ui.grid, 0.55);
    const size = step * z >= 24 ? 1.5 : 1;
    for (let x = x0; x <= br.x; x += step) {
      for (let y = y0; y <= br.y; y += step) {
        const s = this.worldToScreen(x, y);
        ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
      }
    }
  }

  private drawItem(ctx: CanvasRenderingContext2D, it: StoredItem, theme: MockPalette, z: number): void {
    const p = it.proto as Record<string, any>;
    const colour = (layer?: string) => (layer ? theme.layers(layer) : theme.ui.text);
    switch (it.type) {
      case 'KOT_PCB_TRACE': {
        ctx.strokeStyle = colour(it.layer);
        ctx.lineWidth = Math.max(p.width?.valueNm ?? 0, 1 / z);
        ctx.beginPath();
        ctx.moveTo(p.start.xNm, p.start.yNm);
        ctx.lineTo(p.end.xNm, p.end.yNm);
        ctx.stroke();
        return;
      }
      case 'KOT_PCB_ARC': {
        ctx.strokeStyle = colour(it.layer);
        ctx.lineWidth = Math.max(p.width?.valueNm ?? 0, 1 / z);
        this.arcPath(ctx, p.start, p.mid, p.end);
        ctx.stroke();
        return;
      }
      case 'KOT_PCB_VIA': {
        const dia = p.padStack?.copperLayers?.[0]?.size?.xNm ?? 800_000;
        const drill = p.padStack?.drill?.diameter?.xNm ?? dia / 2;
        ctx.fillStyle = colour('BL_F_Cu');
        ctx.beginPath();
        ctx.arc(p.position.xNm, p.position.yNm, dia / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.ui.background;
        ctx.beginPath();
        ctx.arc(p.position.xNm, p.position.yNm, drill / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      case 'KOT_PCB_PAD': {
        const cl = p.padStack?.copperLayers?.[0];
        const w = cl?.size?.xNm ?? 1_000_000;
        const h = cl?.size?.yNm ?? 1_000_000;
        const x = p.position.xNm;
        const y = p.position.yNm;
        const parent = it.parent && this.store ? this.store.get(it.parent) : undefined;
        const rot = ((parent?.proto as any)?.orientation?.valueDegrees ?? 0) * (Math.PI / 180);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-rot);
        ctx.fillStyle = colour(p.type === 'PT_PTH' ? 'BL_F_Cu' : it.layer);
        const shape = cl?.shape ?? 'PSS_RECTANGLE';
        if (shape === 'PSS_CIRCLE' || shape === 'PSS_OVAL') {
          ctx.beginPath();
          ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (shape === 'PSS_ROUNDRECT') {
          const r = Math.min(w, h) * (cl?.cornerRoundingRatio ?? 0.25);
          this.roundRect(ctx, -w / 2, -h / 2, w, h, r);
          ctx.fill();
        } else {
          ctx.fillRect(-w / 2, -h / 2, w, h);
        }
        if (p.type === 'PT_PTH' && p.padStack?.drill) {
          ctx.fillStyle = theme.ui.background;
          ctx.beginPath();
          ctx.arc(0, 0, (p.padStack.drill.diameter?.xNm ?? 800_000) / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        const px = Math.min(w, h) * z;
        if (px > 9 && p.number) {
          ctx.fillStyle = theme.ui.background;
          ctx.font = `${Math.min(w, h) * 0.55}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(p.number), 0, 0);
        }
        ctx.restore();
        return;
      }
      case 'KOT_PCB_SHAPE': {
        ctx.strokeStyle = colour(it.layer);
        ctx.fillStyle = colour(it.layer);
        ctx.lineWidth = Math.max(p.shape?.attributes?.stroke?.width?.valueNm ?? 0, 1 / z);
        this.graphicShapePath(ctx, p.shape);
        if (p.shape?.attributes?.fill?.fillType === 'GFT_FILLED') ctx.fill();
        ctx.stroke();
        return;
      }
      case 'KOT_PCB_ZONE': {
        const c = colour(it.layer);
        ctx.strokeStyle = c;
        ctx.fillStyle = rgba(c, 0.25);
        ctx.lineWidth = 1 / z;
        for (const poly of p.outline?.polygons ?? []) {
          ctx.beginPath();
          const nodes = poly.outline?.nodes ?? [];
          nodes.forEach((n: any, i: number) => (i === 0 ? ctx.moveTo(n.point.xNm, n.point.yNm) : ctx.lineTo(n.point.xNm, n.point.yNm)));
          ctx.closePath();
          if (p.filled) ctx.fill();
          ctx.setLineDash([4 / z, 4 / z]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }
      case 'KOT_PCB_TEXT': {
        this.text(ctx, p.text?.text ?? '', p.text?.position, p.text?.attributes, colour(it.layer), z, p.text?.attributes?.horizontalAlignment);
        return;
      }
      case 'KOT_PCB_FOOTPRINT': {
        const b = it.bbox;
        if (b) {
          ctx.strokeStyle = colour(it.layer === 'BL_B_Cu' ? 'BL_B_Fab' : 'BL_F_Fab');
          ctx.lineWidth = 1 / z;
          ctx.setLineDash([2 / z, 2 / z]);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.setLineDash([]);
        }
        const ref = p.referenceField;
        if (ref?.visible) this.text(ctx, ref.text?.text ?? '', ref.text?.position, ref.text?.attributes, colour(ref.text?.layer ?? 'BL_F_SilkS'), z);
        const val = p.valueField;
        if (val?.visible && this.cam.zoom * 1_000_000 > 6) this.text(ctx, val.text?.text ?? '', val.text?.position, val.text?.attributes, colour(val.text?.layer ?? 'BL_F_Fab'), z);
        return;
      }
      case 'KOT_SCH_LINE': {
        const isBus = p.layer === 'SLT_BUS';
        ctx.strokeStyle = isBus ? theme.ui.bus : p.layer === 'SLT_GRAPHIC' ? theme.ui.text : theme.ui.wire;
        const w = p.stroke?.width?.valueNm || (isBus ? 300_000 : 150_000);
        ctx.lineWidth = Math.max(w, 1 / z);
        ctx.beginPath();
        ctx.moveTo(p.start.xNm, p.start.yNm);
        ctx.lineTo(p.end.xNm, p.end.yNm);
        ctx.stroke();
        return;
      }
      case 'KOT_SCH_JUNCTION': {
        ctx.fillStyle = theme.ui.wire;
        ctx.beginPath();
        ctx.arc(p.position.xNm, p.position.yNm, (p.diameter?.valueNm || 900_000) / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      case 'KOT_SCH_NO_CONNECT': {
        const s = (p.size?.valueNm ?? 1_270_000) / 2;
        ctx.strokeStyle = theme.ui.wire;
        ctx.lineWidth = Math.max(150_000, 1 / z);
        ctx.beginPath();
        ctx.moveTo(p.position.xNm - s, p.position.yNm - s);
        ctx.lineTo(p.position.xNm + s, p.position.yNm + s);
        ctx.moveTo(p.position.xNm + s, p.position.yNm - s);
        ctx.lineTo(p.position.xNm - s, p.position.yNm + s);
        ctx.stroke();
        return;
      }
      case 'KOT_SCH_LOCAL_LABEL':
      case 'KOT_SCH_GLOBAL_LABEL':
      case 'KOT_SCH_HIER_LABEL': {
        const t = p.text?.text ?? '';
        const size = p.text?.attributes?.size?.yNm ?? 1_270_000;
        const b = it.bbox;
        if (it.type !== 'KOT_SCH_LOCAL_LABEL' && b) {
          ctx.strokeStyle = it.type === 'KOT_SCH_GLOBAL_LABEL' ? theme.ui.symbolOutline : theme.ui.sheet;
          ctx.lineWidth = Math.max(150_000, 1 / z);
          ctx.beginPath();
          ctx.moveTo(b.x, b.y + b.h / 2);
          ctx.lineTo(b.x + size / 2, b.y);
          ctx.lineTo(b.x + b.w, b.y);
          ctx.lineTo(b.x + b.w, b.y + b.h);
          ctx.lineTo(b.x + size / 2, b.y + b.h);
          ctx.closePath();
          ctx.stroke();
        }
        this.text(ctx, t, { xNm: p.position.xNm + size / 2 + 200_000, yNm: p.position.yNm }, p.text?.attributes, theme.ui.label, z, 'HA_LEFT');
        return;
      }
      case 'KOT_SCH_TEXT': {
        this.text(ctx, p.text?.text ?? '', p.text?.position, p.text?.attributes, theme.ui.text, z, p.text?.attributes?.horizontalAlignment ?? 'HA_LEFT');
        return;
      }
      case 'KOT_SCH_SHEET': {
        ctx.strokeStyle = theme.ui.sheet;
        ctx.fillStyle = rgba(theme.ui.sheet, 0.08);
        ctx.lineWidth = Math.max(p.borderStroke?.width?.valueNm ?? 150_000, 1 / z);
        ctx.fillRect(p.position.xNm, p.position.yNm, p.size.xNm, p.size.yNm);
        ctx.strokeRect(p.position.xNm, p.position.yNm, p.size.xNm, p.size.yNm);
        this.text(ctx, p.sheetName?.text?.text ?? '', { xNm: p.position.xNm, yNm: p.position.yNm - 900_000 }, p.sheetName?.text?.attributes, theme.ui.sheet, z, 'HA_LEFT');
        this.text(ctx, `File: ${p.sheetFile?.text?.text ?? ''}`, { xNm: p.position.xNm, yNm: p.position.yNm + p.size.yNm + 900_000 }, p.sheetFile?.text?.attributes, theme.ui.sheet, z, 'HA_LEFT');
        for (const pin of p.pins ?? []) {
          const left = pin.side === 'SPS_LEFT';
          this.text(ctx, pin.text?.text ?? '', { xNm: pin.position.xNm + (left ? 400_000 : -400_000), yNm: pin.position.yNm }, pin.text?.attributes, theme.ui.label, z, left ? 'HA_LEFT' : 'HA_RIGHT');
        }
        return;
      }
      case 'KOT_SCH_SYMBOL': {
        this.drawSymbol(ctx, it, p, theme, z);
        return;
      }
      default: {
        const b = it.bbox;
        if (!b) return;
        ctx.strokeStyle = colour(it.layer);
        ctx.lineWidth = 1 / z;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
    }
  }

  private drawSymbol(ctx: CanvasRenderingContext2D, it: StoredItem, p: Record<string, any>, theme: MockPalette, z: number): void {
    const b = it.bbox!;
    const pins: any[] = (p.definition?.items ?? []).map((c: any) => c.item).filter((x: any) => x && (x['@type']?.endsWith('SchematicPin') || x.number !== undefined));
    const isPower = p.definition?.type === 'SST_GLOBAL_POWER' || p.definition?.type === 'SST_LOCAL_POWER';
    const cx = p.position.xNm;
    const cy = p.position.yNm;
    const pinLen = pins[0]?.length?.valueNm ?? 2_540_000;
    // body = bbox shrunk by pin length on sides that have pins
    let bx = b.x;
    let by = b.y;
    let bw = b.w;
    let bh = b.h;
    if (!isPower && pins.length) {
      const hasL = pins.some((q) => q.orientation === 'SPO_RIGHT');
      const hasR = pins.some((q) => q.orientation === 'SPO_LEFT');
      const hasT = pins.some((q) => q.orientation === 'SPO_DOWN');
      const hasB = pins.some((q) => q.orientation === 'SPO_UP');
      if (hasL) {
        bx += pinLen;
        bw -= pinLen;
      }
      if (hasR) bw -= pinLen;
      if (hasT) {
        by += pinLen;
        bh -= pinLen;
      }
      if (hasB) bh -= pinLen;
    }
    ctx.lineWidth = Math.max(150_000, 1 / z);
    ctx.strokeStyle = theme.ui.symbolOutline;
    ctx.fillStyle = theme.ui.symbolBody;
    if (isPower) {
      ctx.strokeStyle = theme.ui.symbolOutline;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      const up = (p.valueField?.text?.text ?? '') !== 'GND';
      const dir = up ? -1 : 1;
      ctx.lineTo(cx, cy + dir * 1_270_000);
      ctx.moveTo(cx - 1_270_000, cy + dir * 1_270_000);
      ctx.lineTo(cx + 1_270_000, cy + dir * 1_270_000);
      if (!up) {
        ctx.moveTo(cx - 762_000, cy + 1_778_000);
        ctx.lineTo(cx + 762_000, cy + 1_778_000);
        ctx.moveTo(cx - 254_000, cy + 2_286_000);
        ctx.lineTo(cx + 254_000, cy + 2_286_000);
      }
      ctx.stroke();
      this.text(ctx, p.valueField?.text?.text ?? '', { xNm: cx, yNm: cy + dir * 2_540_000 }, p.valueField?.text?.attributes, theme.ui.text, z, 'HA_CENTER');
      return;
    }
    if (bw > 0 && bh > 0) {
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    }
    for (const pin of pins) {
      const px = cx + (pin.position?.xNm ?? 0);
      const py = cy + (pin.position?.yNm ?? 0);
      let ex = px;
      let ey = py;
      const len = pin.length?.valueNm ?? pinLen;
      switch (pin.orientation) {
        case 'SPO_RIGHT':
          ex = px + len;
          break;
        case 'SPO_LEFT':
          ex = px - len;
          break;
        case 'SPO_UP':
          ey = py - len;
          break;
        case 'SPO_DOWN':
          ey = py + len;
          break;
      }
      ctx.strokeStyle = theme.ui.symbolOutline;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (z * 1_000_000 > 4) {
        if (p.showPinNumbers) {
          this.text(ctx, String(pin.number ?? ''), { xNm: (px + ex) / 2, yNm: (py + ey) / 2 - 500_000 }, { size: { yNm: 900_000 } }, theme.ui.symbolOutline, z, 'HA_CENTER');
        }
        if (p.showPinNames && pin.name && pin.name !== '~') {
          const inside = 500_000;
          const horiz = pin.orientation === 'SPO_RIGHT' || pin.orientation === 'SPO_LEFT';
          const nx = horiz ? (pin.orientation === 'SPO_RIGHT' ? ex + inside : ex - inside) : ex;
          const ny = horiz ? ey : pin.orientation === 'SPO_DOWN' ? ey + inside + 400_000 : ey - inside - 400_000;
          this.text(ctx, pin.name.replace(/~\{([^}]*)\}/g, '$1'), { xNm: nx, yNm: ny }, { size: { yNm: 1_000_000 } }, theme.ui.pinName, z, horiz ? (pin.orientation === 'SPO_RIGHT' ? 'HA_LEFT' : 'HA_RIGHT') : 'HA_CENTER');
        }
      }
    }
    for (const f of [p.referenceField, p.valueField]) {
      if (f?.visible) this.text(ctx, f.text?.text ?? '', f.text?.position, f.text?.attributes, theme.ui.text, z, 'HA_LEFT');
    }
  }

  private text(ctx: CanvasRenderingContext2D, text: string, pos: Vec | undefined, attrs: any, colour: string, z: number, align: string = 'HA_CENTER'): void {
    if (!text || !pos) return;
    const size = attrs?.size?.yNm ?? 1_000_000;
    if (size * z < 4) return;
    ctx.save();
    ctx.translate(pos.xNm, pos.yNm);
    const angle = attrs?.angle?.valueDegrees ?? 0;
    if (angle) ctx.rotate((-angle * Math.PI) / 180);
    ctx.fillStyle = colour;
    ctx.font = `${attrs?.bold ? 'bold ' : ''}${attrs?.italic ? 'italic ' : ''}${size * 1.15}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = align === 'HA_LEFT' ? 'left' : align === 'HA_RIGHT' ? 'right' : 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  private arcPath(ctx: CanvasRenderingContext2D, a: Vec, m: Vec, b: Vec): void {
    // circle through three points
    const ax = a.xNm, ay = a.yNm, bx = m.xNm, by = m.yNm, cx = b.xNm, cy = b.yNm;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(cx, cy);
      return;
    }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    const a0 = Math.atan2(ay - uy, ax - ux);
    const a1 = Math.atan2(cy - uy, cx - ux);
    const am = Math.atan2(by - uy, bx - ux);
    // choose direction that passes through the midpoint
    const ccw = ((am - a0 + Math.PI * 2) % (Math.PI * 2)) > ((a1 - a0 + Math.PI * 2) % (Math.PI * 2));
    ctx.beginPath();
    ctx.arc(ux, uy, r, a0, a1, ccw);
  }

  private graphicShapePath(ctx: CanvasRenderingContext2D, shape: any): void {
    ctx.beginPath();
    if (!shape) return;
    if (shape.segment) {
      ctx.moveTo(shape.segment.start.xNm, shape.segment.start.yNm);
      ctx.lineTo(shape.segment.end.xNm, shape.segment.end.yNm);
    } else if (shape.rectangle) {
      const r = shape.rectangle;
      ctx.rect(r.topLeft.xNm, r.topLeft.yNm, r.bottomRight.xNm - r.topLeft.xNm, r.bottomRight.yNm - r.topLeft.yNm);
    } else if (shape.circle) {
      const c = shape.circle;
      const rad = Math.hypot(c.radiusPoint.xNm - c.center.xNm, c.radiusPoint.yNm - c.center.yNm);
      ctx.arc(c.center.xNm, c.center.yNm, rad, 0, Math.PI * 2);
    } else if (shape.arc) {
      this.arcPath(ctx, shape.arc.start, shape.arc.mid, shape.arc.end);
    } else if (shape.polygon) {
      for (const poly of shape.polygon.polygons ?? []) {
        (poly.outline?.nodes ?? []).forEach((n: any, i: number) => (i === 0 ? ctx.moveTo(n.point.xNm, n.point.yNm) : ctx.lineTo(n.point.xNm, n.point.yNm)));
        ctx.closePath();
      }
    } else if (shape.bezier) {
      const b = shape.bezier;
      ctx.moveTo(b.start.xNm, b.start.yNm);
      ctx.bezierCurveTo(b.control1.xNm, b.control1.yNm, b.control2.xNm, b.control2.yNm, b.end.xNm, b.end.yNm);
    }
  }
}
