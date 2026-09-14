/**
 * Screen-space overlays drawn above the scene: adaptive grid (mm / mil), origin and axes,
 * selection and hover highlights, rubber-band rectangle. Everything is redrawn from the
 * camera each frame the camera or the overlay state changes.
 */
import { Container, Graphics } from 'pixi.js';
import type { Box, Primitive, RenderItem, Vec2 } from './model.js';
import { arcFrom3, bezierToPolyline } from './geometry.js';
import { type Theme, type UiColors, colorToHex, uiColors } from './theme.js';
import type { Camera } from './camera.js';

export interface OverlayOptions {
  showGrid?: boolean;
  gridUnit?: 'mm' | 'mil';
  gridStyle?: 'lines' | 'dots';
  /** minimum pixel spacing before the grid steps to a coarser pitch */
  minGridPx?: number;
  showAxes?: boolean;
  /** fixed grid pitch in nm (disables adaptive selection) */
  gridPitchNm?: number;
}

export const MM = 1_000_000;
export const MIL = 25_400;
const MM_STEPS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000].map((v) => v * MM);
const MIL_STEPS = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000].map((v) => v * MIL);

export class Overlays {
  readonly root = new Container();
  private grid = new Graphics();
  private axes = new Graphics();
  private selectionG = new Graphics();
  private hoverG = new Graphics();
  private rubberG = new Graphics();
  private ui: UiColors;
  options: Required<Omit<OverlayOptions, 'gridPitchNm'>> & { gridPitchNm?: number };

  selection: RenderItem[] = [];
  hover: RenderItem | null = null;
  /** rubber band in screen px */
  rubberBand: Box | null = null;
  /** current adaptive grid pitch (nm), for a status bar */
  gridPitch = 0;

  constructor(theme: Theme, kind: 'board' | 'schematic' = 'board', options: OverlayOptions = {}) {
    this.ui = uiColors(theme, kind);
    this.options = {
      showGrid: options.showGrid ?? true,
      gridUnit: options.gridUnit ?? 'mm',
      gridStyle: options.gridStyle ?? 'lines',
      minGridPx: options.minGridPx ?? 12,
      showAxes: options.showAxes ?? true,
      gridPitchNm: options.gridPitchNm,
    };
    this.root.label = 'overlays';
    this.root.addChild(this.grid, this.axes, this.selectionG, this.hoverG, this.rubberG);
    this.root.eventMode = 'none';
  }

  setTheme(theme: Theme, kind: 'board' | 'schematic' = 'board'): void {
    this.ui = uiColors(theme, kind);
  }

  get colors(): UiColors {
    return this.ui;
  }

  setSelection(items: RenderItem[]): void {
    this.selection = items;
  }

  setHover(item: RenderItem | null): void {
    this.hover = item;
  }

  setRubberBand(box: Box | null): void {
    this.rubberBand = box;
  }

  /** Grid pitch (nm) for the current zoom. */
  pickGridPitch(zoom: number): number {
    if (this.options.gridPitchNm) return this.options.gridPitchNm;
    const steps = this.options.gridUnit === 'mil' ? MIL_STEPS : MM_STEPS;
    for (const s of steps) if (s * zoom >= this.options.minGridPx) return s;
    return steps[steps.length - 1]!;
  }

  redraw(camera: Camera): void {
    this.drawGrid(camera);
    this.drawAxes(camera);
    this.drawHighlight(this.selectionG, this.selection, camera, colorToHex(this.ui.selection), 0.55);
    this.drawHighlight(this.hoverG, this.hover ? [this.hover] : [], camera, colorToHex(this.ui.hover), 0.4);
    this.drawRubberBand();
  }

  private drawGrid(camera: Camera): void {
    const g = this.grid;
    g.clear();
    if (!this.options.showGrid) return;
    const pitch = this.pickGridPitch(camera.zoom);
    this.gridPitch = pitch;
    const vis = camera.visibleBox();
    const x0 = Math.floor(vis.x / pitch) * pitch;
    const y0 = Math.floor(vis.y / pitch) * pitch;
    const nx = Math.ceil(vis.w / pitch) + 1;
    const ny = Math.ceil(vis.h / pitch) + 1;
    if (nx > 800 || ny > 800) return;
    const color = colorToHex(this.ui.grid);
    const alpha = this.ui.grid.a * 0.5;
    if (this.options.gridStyle === 'dots') {
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= ny; j++) {
          const s = camera.worldToScreen(x0 + i * pitch, y0 + j * pitch);
          g.rect(Math.round(s.x) - 0.5, Math.round(s.y) - 0.5, 1, 1);
        }
      }
      g.fill({ color, alpha });
      return;
    }
    for (let i = 0; i <= nx; i++) {
      const s = camera.worldToScreen(x0 + i * pitch, 0);
      const x = Math.round(s.x) + 0.5;
      g.moveTo(x, 0).lineTo(x, camera.height);
    }
    for (let j = 0; j <= ny; j++) {
      const s = camera.worldToScreen(0, y0 + j * pitch);
      const y = Math.round(s.y) + 0.5;
      g.moveTo(0, y).lineTo(camera.width, y);
    }
    g.stroke({ width: 1, color, alpha, pixelLine: true });
  }

  private drawAxes(camera: Camera): void {
    const g = this.axes;
    g.clear();
    if (!this.options.showAxes) return;
    const o = camera.worldToScreen(0, 0);
    const color = colorToHex(this.ui.gridAxes);
    const alpha = this.ui.gridAxes.a;
    if (o.x >= -20 && o.x <= camera.width + 20 && o.y >= -20 && o.y <= camera.height + 20) {
      // origin marker: circle + cross
      g.circle(o.x, o.y, 6).stroke({ width: 1, color, alpha });
      g.moveTo(o.x - 14, o.y)
        .lineTo(o.x + 14, o.y)
        .moveTo(o.x, o.y - 14)
        .lineTo(o.x, o.y + 14)
        .stroke({ width: 1, color, alpha });
    }
    // faint full axes
    if (o.x >= 0 && o.x <= camera.width) g.moveTo(o.x + 0.5, 0).lineTo(o.x + 0.5, camera.height);
    if (o.y >= 0 && o.y <= camera.height) g.moveTo(0, o.y + 0.5).lineTo(camera.width, o.y + 0.5);
    g.stroke({ width: 1, color, alpha: alpha * 0.35, pixelLine: true });
  }

  private drawHighlight(g: Graphics, items: RenderItem[], camera: Camera, color: number, alpha: number): void {
    g.clear();
    if (!items.length) return;
    const zoom = camera.zoom;
    const pad = 3; // px halo
    for (const it of items) {
      for (const p of it.prims) drawPrimScreen(g, p, camera, zoom, pad);
      if (!it.prims.length) {
        const a = camera.worldToScreen(it.bbox.x, it.bbox.y);
        const b = camera.worldToScreen(it.bbox.x + it.bbox.w, it.bbox.y + it.bbox.h);
        g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)).stroke({ width: 2, color, alpha });
      }
    }
    g.fill({ color, alpha });
  }

  private drawRubberBand(): void {
    const g = this.rubberG;
    g.clear();
    const b = this.rubberBand;
    if (!b) return;
    const color = colorToHex(this.ui.selection);
    g.rect(b.x, b.y, b.w, b.h).fill({ color, alpha: 0.12 }).stroke({ width: 1, color, alpha: 0.9, pixelLine: true });
  }
}

/** Paint a primitive's silhouette in screen space (used as a translucent highlight). */
function drawPrimScreen(g: Graphics, p: Primitive, camera: Camera, zoom: number, pad: number): void {
  const W = (w: number): number => Math.max(w * zoom, 1) + 2 * pad;
  const s = (v: Vec2): Vec2 => camera.worldToScreen(v.x, v.y);
  switch (p.kind) {
    case 'segment': {
      const a = s(p.a);
      const b = s(p.b);
      strokeAsFill(g, [a, b], W(p.width));
      break;
    }
    case 'arc': {
      const geom = arcFrom3(p.start, p.mid, p.end);
      const pts: Vec2[] = [];
      if (geom) {
        const n = 24;
        for (let i = 0; i <= n; i++) {
          const a = geom.a0 + (geom.sweep * i) / n;
          pts.push(s({ x: geom.c.x + geom.r * Math.cos(a), y: geom.c.y + geom.r * Math.sin(a) }));
        }
      } else pts.push(s(p.start), s(p.end));
      strokeAsFill(g, pts, W(p.width));
      break;
    }
    case 'circle': {
      const c = s(p.c);
      const r = p.r * zoom;
      if (p.fill) g.circle(c.x, c.y, r + W(p.width) / 2);
      else {
        g.circle(c.x, c.y, r + W(p.width) / 2);
        g.circle(c.x, c.y, Math.max(0, r - W(p.width) / 2)).cut();
      }
      break;
    }
    case 'polygon': {
      const pts = p.outline.map(s);
      if (p.fill) {
        g.poly(
          pts.flatMap((q) => [q.x, q.y]),
          true,
        );
        for (const h of p.holes)
          g.poly(
            h.map(s).flatMap((q) => [q.x, q.y]),
            true,
          ).cut();
      } else strokeAsFill(g, [...pts, pts[0]!], W(p.width));
      break;
    }
    case 'bezier':
      strokeAsFill(g, bezierToPolyline(p.p0, p.p1, p.p2, p.p3, 16).map(s), W(p.width));
      break;
    case 'text-shapes':
      for (const poly of p.polys)
        if (poly.length >= 3)
          g.poly(
            poly.map(s).flatMap((q) => [q.x, q.y]),
            true,
          );
      break;
    case 'image': {
      const a = s({ x: p.c.x - p.w / 2, y: p.c.y - p.h / 2 });
      const b = s({ x: p.c.x + p.w / 2, y: p.c.y + p.h / 2 });
      g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      break;
    }
    case 'text-glyphs':
      if (p.outline.length >= 3)
        g.poly(
          p.outline.map(s).flatMap((q) => [q.x, q.y]),
          true,
        );
      break;
  }
}

/** Approximate a wide round-capped polyline as filled shapes (so one fill() call paints it). */
function strokeAsFill(g: Graphics, pts: Vec2[], width: number): void {
  const r = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    g.circle(a.x, a.y, r);
    if (len > 0) {
      const nx = (-dy / len) * r;
      const ny = (dx / len) * r;
      g.poly([a.x + nx, a.y + ny, b.x + nx, b.y + ny, b.x - nx, b.y - ny, a.x - nx, a.y - ny], true);
    }
  }
  const last = pts[pts.length - 1];
  if (last) g.circle(last.x, last.y, r);
}
