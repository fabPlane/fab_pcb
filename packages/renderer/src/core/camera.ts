/**
 * Float64 camera: world nm -> screen CSS px, plus the "moving origin".
 *
 * Pixi only sees float32 coordinates. Every item's geometry is built relative to its own
 * anchor (small numbers), item containers are positioned at (anchor - origin), and the
 * scene root is placed so that `origin` lands at the right screen position. When the
 * camera drifts more than `rebaseThresholdPx` screen pixels away from the origin the
 * origin is moved to the camera centre and all item positions are re-derived — so a 500 mm
 * board keeps sub-micron precision at any zoom.
 */
import type { Box, Vec2 } from './model.js';
import { boxIsEmpty } from './model.js';

/** docs/contracts.md Camera: world nm at the viewport centre; zoom = px per nm. */
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface RootTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export type CameraListener = (cam: CameraState) => void;

export class Camera {
  x = 0;
  y = 0;
  /** px per nm. 1e-5 => 1 mm = 10 px. */
  zoom = 1e-5;
  minZoom = 1e-9; // 1 px = 1 m
  maxZoom = 0.1; // 1 px = 10 nm
  /** viewport size in CSS px */
  width = 1;
  height = 1;
  /** mirror X (view from the back of the board) */
  flipX = false;

  originX = 0;
  originY = 0;
  rebaseThresholdPx = 50_000;

  private listeners = new Set<CameraListener>();
  private version = 0;

  get revision(): number {
    return this.version;
  }

  getState(): CameraState {
    return { x: this.x, y: this.y, zoom: this.zoom };
  }

  setState(s: Partial<CameraState>): void {
    if (s.x !== undefined) this.x = s.x;
    if (s.y !== undefined) this.y = s.y;
    if (s.zoom !== undefined) this.zoom = this.clampZoom(s.zoom);
    this.changed();
  }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.changed();
  }

  setFlip(flip: boolean): void {
    if (this.flipX !== flip) {
      this.flipX = flip;
      this.changed();
    }
  }

  onChange(cb: CameraListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    this.version++;
    const s = this.getState();
    for (const cb of this.listeners) {
      try {
        cb(s);
      } catch (err) {
        console.error('[renderer] camera listener failed:', err);
      }
    }
  }

  private clampZoom(z: number): number {
    if (!(z > 0)) return this.zoom;
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  private get sx(): number {
    return this.flipX ? -1 : 1;
  }

  // ------------------------------------------------------------------ transforms

  worldToScreen(wx: number, wy: number): Vec2 {
    return { x: this.width / 2 + this.sx * (wx - this.x) * this.zoom, y: this.height / 2 + (wy - this.y) * this.zoom };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return { x: this.x + (this.sx * (sx - this.width / 2)) / this.zoom, y: this.y + (sy - this.height / 2) / this.zoom };
  }

  /** Visible world rectangle. */
  visibleBox(): Box {
    const a = this.screenToWorld(0, 0);
    const b = this.screenToWorld(this.width, this.height);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  /** Transform for the scene root container (children are positioned relative to the origin). */
  rootTransform(): RootTransform {
    const o = this.worldToScreen(this.originX, this.originY);
    return { x: o.x, y: o.y, scaleX: this.sx * this.zoom, scaleY: this.zoom };
  }

  /** Re-base the origin when the camera has drifted far from it. Returns true if it moved. */
  maybeRebase(): boolean {
    const dx = (this.x - this.originX) * this.zoom;
    const dy = (this.y - this.originY) * this.zoom;
    if (Math.hypot(dx, dy) <= this.rebaseThresholdPx) return false;
    this.originX = Math.round(this.x);
    this.originY = Math.round(this.y);
    return true;
  }

  // ------------------------------------------------------------------ navigation

  panByPixels(dxPx: number, dyPx: number): void {
    this.x -= (this.sx * dxPx) / this.zoom;
    this.y -= dyPx / this.zoom;
    this.changed();
  }

  /** Multiply zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = this.clampZoom(this.zoom * factor);
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.changed();
  }

  zoomToBox(box: Box, paddingPx = 24): void {
    if (boxIsEmpty(box) || box.w <= 0 && box.h <= 0) return;
    const w = Math.max(box.w, 1);
    const h = Math.max(box.h, 1);
    const availW = Math.max(1, this.width - 2 * paddingPx);
    const availH = Math.max(1, this.height - 2 * paddingPx);
    this.zoom = this.clampZoom(Math.min(availW / w, availH / h));
    this.x = box.x + box.w / 2;
    this.y = box.y + box.h / 2;
    this.changed();
  }

  centerOn(wx: number, wy: number): void {
    this.x = wx;
    this.y = wy;
    this.changed();
  }
}

// ---------------------------------------------------------------------------
// Input controller: wheel / trackpad / pinch / touch / keyboard
// ---------------------------------------------------------------------------

export interface CameraControllerOptions {
  /** Buttons that pan when dragged (0 left, 1 middle, 2 right). Default [1]. */
  panButtons?: number[];
  /** wheel: 'zoom' (KiCad style: wheel zooms, shift/ctrl scroll), 'pan' (trackpad style), 'auto'. */
  wheelMode?: 'zoom' | 'pan' | 'auto';
  zoomStep?: number;
  keyboard?: boolean;
  /** Inertial panning after a fling; disabled automatically with prefers-reduced-motion. */
  inertia?: boolean;
  /** Called when the controller wants a redraw. */
  onFrame?: () => void;
}

interface PointerInfo {
  x: number;
  y: number;
}

export class CameraController {
  private pointers = new Map<number, PointerInfo>();
  private panning = false;
  private panButton = -1;
  private last: Vec2 | null = null;
  private velocity: Vec2 = { x: 0, y: 0 };
  private lastMoveTime = 0;
  private pinchDist = 0;
  private raf = 0;
  private detachFns: Array<() => void> = [];
  readonly options: Required<Omit<CameraControllerOptions, 'onFrame'>> & { onFrame?: () => void };

  constructor(
    readonly camera: Camera,
    readonly el: HTMLElement,
    options: CameraControllerOptions = {},
  ) {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.options = {
      panButtons: options.panButtons ?? [1],
      wheelMode: options.wheelMode ?? 'auto',
      zoomStep: options.zoomStep ?? 1.15,
      keyboard: options.keyboard ?? true,
      inertia: reduced ? false : (options.inertia ?? true),
      onFrame: options.onFrame,
    };
    this.attach();
  }

  get isPanning(): boolean {
    return this.panning;
  }

  private attach(): void {
    const el = this.el;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.detachFns.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('pointerdown', (e) => this.onPointerDown(e));
    on('pointermove', (e) => this.onPointerMove(e));
    on('pointerup', (e) => this.onPointerUp(e));
    on('pointercancel', (e) => this.onPointerUp(e));
    on('contextmenu', (e) => {
      if (this.options.panButtons.includes(2)) e.preventDefault();
    });
    if (this.options.keyboard) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      on('keydown', (e) => this.onKey(e));
    }
  }

  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  private local(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const mode = this.options.wheelMode;
    // pinch gestures arrive as ctrl+wheel in Chrome/Safari/Firefox
    const pinch = e.ctrlKey || e.metaKey;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * this.camera.height : e.deltaY;
    const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaMode === 2 ? e.deltaX * this.camera.width : e.deltaX;
    const wantPan = mode === 'pan' ? !pinch : mode === 'auto' ? !pinch && (e.deltaX !== 0 || e.shiftKey) : e.shiftKey && !pinch;
    if (wantPan) {
      if (e.shiftKey && dx === 0) this.camera.panByPixels(-dy, 0);
      else this.camera.panByPixels(-dx, -dy);
    } else {
      const factor = pinch ? Math.exp(-dy * 0.01) : dy < 0 ? this.options.zoomStep : 1 / this.options.zoomStep;
      this.camera.zoomAt(p.x, p.y, factor);
    }
    this.options.onFrame?.();
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (e.pointerType === 'touch') {
      this.stopInertia();
      if (this.pointers.size === 1) {
        this.panning = true;
        this.last = p;
        this.el.setPointerCapture?.(e.pointerId);
      } else if (this.pointers.size === 2) {
        this.pinchDist = this.pinchDistance();
      }
      return;
    }
    if (this.options.panButtons.includes(e.button)) {
      this.stopInertia();
      this.panning = true;
      this.panButton = e.button;
      this.last = p;
      this.velocity = { x: 0, y: 0 };
      this.lastMoveTime = performance.now();
      this.el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private pinchCenter(): Vec2 {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      const prevCenter = this.pinchCenter();
      this.pointers.set(e.pointerId, p);
      const d = this.pinchDistance();
      const c = this.pinchCenter();
      if (this.pinchDist > 0 && d > 0) this.camera.zoomAt(c.x, c.y, d / this.pinchDist);
      this.camera.panByPixels(c.x - prevCenter.x, c.y - prevCenter.y);
      this.pinchDist = d;
      this.options.onFrame?.();
      return;
    }
    this.pointers.set(e.pointerId, p);
    if (this.panning && this.last) {
      const dx = p.x - this.last.x;
      const dy = p.y - this.last.y;
      const now = performance.now();
      const dt = Math.max(1, now - this.lastMoveTime);
      this.velocity = { x: dx / dt, y: dy / dt };
      this.lastMoveTime = now;
      this.last = p;
      this.camera.panByPixels(dx, dy);
      this.options.onFrame?.();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (e.pointerType === 'touch') {
      if (this.pointers.size === 0) this.panning = false;
      else if (this.pointers.size === 1) this.last = [...this.pointers.values()][0]!;
      return;
    }
    if (this.panning && e.button === this.panButton) {
      this.panning = false;
      this.panButton = -1;
      this.el.releasePointerCapture?.(e.pointerId);
      if (this.options.inertia && performance.now() - this.lastMoveTime < 60) this.startInertia();
    }
  }

  private startInertia(): void {
    const step = () => {
      const v = this.velocity;
      if (Math.hypot(v.x, v.y) < 0.02) {
        this.raf = 0;
        return;
      }
      this.camera.panByPixels(v.x * 16, v.y * 16);
      this.velocity = { x: v.x * 0.9, y: v.y * 0.9 };
      this.options.onFrame?.();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private stopInertia(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.velocity = { x: 0, y: 0 };
  }

  private onKey(e: KeyboardEvent): void {
    const stepPx = e.shiftKey ? 200 : 40;
    const cx = this.camera.width / 2;
    const cy = this.camera.height / 2;
    switch (e.key) {
      case 'ArrowLeft':
        this.camera.panByPixels(stepPx, 0);
        break;
      case 'ArrowRight':
        this.camera.panByPixels(-stepPx, 0);
        break;
      case 'ArrowUp':
        this.camera.panByPixels(0, stepPx);
        break;
      case 'ArrowDown':
        this.camera.panByPixels(0, -stepPx);
        break;
      case '+':
      case '=':
        this.camera.zoomAt(cx, cy, this.options.zoomStep);
        break;
      case '-':
      case '_':
        this.camera.zoomAt(cx, cy, 1 / this.options.zoomStep);
        break;
      default:
        return;
    }
    e.preventDefault();
    this.options.onFrame?.();
  }
}

// ---------------------------------------------------------------------------
// Camera animation (focusMarker, "zoom to selection")
// ---------------------------------------------------------------------------

/** `prefers-reduced-motion: reduce` (false outside a browser). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface CameraAnimationOptions {
  /** total duration in ms (default 320); 0 or reduced motion jumps immediately */
  durationMs?: number;
  /** force an immediate jump (defaults to `prefersReducedMotion()`) */
  reducedMotion?: boolean;
  /** called when the animation ends or is cancelled by a new one */
  onDone?: () => void;
}

/**
 * Ease the camera to `target` (missing fields keep their value). Zoom interpolates
 * geometrically so a pan+zoom feels uniform. Returns a cancel function. Without
 * `requestAnimationFrame` (tests) or with reduced motion the camera jumps at once.
 */
export function animateCamera(camera: Camera, target: Partial<CameraState>, opts: CameraAnimationOptions = {}): () => void {
  const from = camera.getState();
  const to: CameraState = { x: target.x ?? from.x, y: target.y ?? from.y, zoom: target.zoom ?? from.zoom };
  const duration = opts.durationMs ?? 320;
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  if (reduced || duration <= 0 || typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') {
    camera.setState(to);
    opts.onDone?.();
    return () => {};
  }
  const start = performance.now();
  const lnz0 = Math.log(from.zoom);
  const lnz1 = Math.log(to.zoom);
  let raf = 0;
  let cancelled = false;
  const step = (now: number): void => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    camera.setState({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, zoom: Math.exp(lnz0 + (lnz1 - lnz0) * e) });
    if (t < 1) raf = requestAnimationFrame(step);
    else opts.onDone?.();
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
  };
}
