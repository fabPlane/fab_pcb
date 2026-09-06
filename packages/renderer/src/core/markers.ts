/**
 * DRC / ERC marker glyphs: KiCad's MARKER_BASE arrow polygon (common/marker_base.cpp
 * `MarkerShapeCorners`), filled in the theme's `board.drc_error` / `drc_warning` /
 * `drc_exclusion` (or `schematic.erc_*`) colour. Like pcbnew, the glyph grows as the view
 * zooms out (`PCB_MARKER::SetZoom( 1 / sqrt( zoomFactor ) )`), so it is drawn in world
 * space under the scene root with a per-frame scale, and picked here (`pick`) rather than
 * through the flatbush index. The focused marker also shows the error legend: the path
 * between `position` and `endPosition` with perpendicular end stops, or a collision cross.
 */
import { Container, Graphics } from 'pixi.js';
import type { Vec2 } from './model.js';
import { distanceToPrimitive } from './geometry.js';
import { type Theme, type ThemeColor, colorToHex, themeColor } from './theme.js';

export type MarkerSeverity = 'error' | 'warning' | 'exclusion';

export interface MarkerSpec {
  /** marker KIID (PCB_MARKER / SCH_MARKER id); becomes `PickResult.ref` */
  id: string;
  position: Vec2;
  severity: MarkerSeverity;
  /** board layer of the violation, if any (`BL_F_Cu`); informational */
  layer?: string;
  description: string;
  /** far end of the violation (second item / clearance path), for the legend of the focused marker */
  endPosition?: Vec2;
}

export interface MarkerHit {
  id: string;
  marker: MarkerSpec;
  /** world nm from the query point (0 = inside the glyph) */
  distance: number;
  /** theme key of the severity layer (`board.drc_error`) */
  layer: string;
}

/** MarkerShapeCorners, in shape units (scaled by the marker scale). */
export const MARKER_SHAPE: readonly Vec2[] = Object.freeze([
  { x: 0, y: 0 },
  { x: 8, y: 1 },
  { x: 4, y: 3 },
  { x: 13, y: 8 },
  { x: 9, y: 9 },
  { x: 8, y: 13 },
  { x: 3, y: 4 },
  { x: 1, y: 8 },
]);

/** pcb_marker.cpp / sch_marker.cpp SCALING_FACTOR, nm per shape unit at GAL zoom 1. */
export const MARKER_BASE_SCALE_NM = { board: 162_500, schematic: 150_000 } as const;
/** GAL zoom factor 1.0 = 1 mm drawn 1 mm long at 96 dpi: px per nm. */
const GAL_UNIT_ZOOM = 96 / 25.4 / 1_000_000;

/** nm per shape unit for the current camera zoom (px per nm). */
export function markerScaleNm(zoom: number, kind: 'board' | 'schematic' = 'board'): number {
  const z = zoom > 0 ? zoom : GAL_UNIT_ZOOM;
  return MARKER_BASE_SCALE_NM[kind] * Math.sqrt(GAL_UNIT_ZOOM / z);
}

/** Theme key that colours a marker of the given severity. */
export function markerLayerKey(kind: 'board' | 'schematic', severity: MarkerSeverity): string {
  const prefix = kind === 'schematic' ? 'schematic.erc_' : 'board.drc_';
  return prefix + severity;
}

export const MARKER_LAYER_KEYS: readonly string[] = Object.freeze([
  'board.drc_error',
  'board.drc_warning',
  'board.drc_exclusion',
  'schematic.erc_error',
  'schematic.erc_warning',
  'schematic.erc_exclusion',
]);

const SEVERITIES: readonly MarkerSeverity[] = ['error', 'warning', 'exclusion'];

class MarkerObject extends Container {
  spec!: MarkerSpec;
  glyph = new Graphics();
}

export class MarkerLayer {
  readonly root = new Container();
  private objects = new Map<string, MarkerObject>();
  private legend = new Graphics();
  private colors!: Record<MarkerSeverity, ThemeColor>;
  private severityVisible: Record<MarkerSeverity, boolean> = { error: true, warning: true, exclusion: true };
  private originX = 0;
  private originY = 0;
  private scaleNm = MARKER_BASE_SCALE_NM.board;
  private zoom = 0;
  private focusedId: string | null = null;
  private legendDirty = true;
  /** background colour of the view, for the legend outline */
  private background: ThemeColor;

  constructor(
    theme: Theme,
    readonly kind: 'board' | 'schematic' = 'board',
  ) {
    this.root.label = 'markers';
    this.root.eventMode = 'none';
    this.root.zIndex = 1_000_001;
    this.root.addChild(this.legend);
    this.background = themeColor(theme, kind === 'schematic' ? 'schematic.background' : 'board.background');
    this.setTheme(theme);
  }

  setTheme(theme: Theme): void {
    this.colors = {
      error: themeColor(theme, markerLayerKey(this.kind, 'error')),
      warning: themeColor(theme, markerLayerKey(this.kind, 'warning')),
      exclusion: themeColor(theme, markerLayerKey(this.kind, 'exclusion')),
    };
    this.background = themeColor(theme, this.kind === 'schematic' ? 'schematic.background' : 'board.background');
    for (const o of this.objects.values()) this.colour(o);
    this.legendDirty = true;
  }

  private colour(o: MarkerObject): void {
    const c = this.colors[o.spec.severity];
    o.glyph.tint = colorToHex(c);
    o.glyph.alpha = c.a;
    o.visible = this.severityVisible[o.spec.severity];
  }

  setMarkers(markers: MarkerSpec[]): void {
    for (const o of this.objects.values()) o.destroy({ children: true });
    this.objects.clear();
    for (const m of markers) {
      const o = new MarkerObject();
      o.spec = m;
      o.label = `marker:${m.id}`;
      o.glyph.poly(MARKER_SHAPE.flatMap((p) => [p.x, p.y]), true).fill(0xffffff);
      o.addChild(o.glyph);
      o.position.set(m.position.x - this.originX, m.position.y - this.originY);
      o.scale.set(this.scaleNm);
      this.colour(o);
      this.objects.set(m.id, o);
      this.root.addChild(o);
    }
    if (this.focusedId && !this.objects.has(this.focusedId)) this.focusedId = null;
    this.legendDirty = true;
  }

  get markers(): MarkerSpec[] {
    return [...this.objects.values()].map((o) => o.spec);
  }

  get(id: string): MarkerSpec | undefined {
    return this.objects.get(id)?.spec;
  }

  get count(): number {
    return this.objects.size;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Per-severity visibility (routed from `setLayerVisible('board.drc_error', ...)`). */
  setSeverityVisible(severity: MarkerSeverity, visible: boolean): void {
    this.severityVisible[severity] = visible;
    for (const o of this.objects.values()) if (o.spec.severity === severity) o.visible = visible;
    this.legendDirty = true;
  }

  isSeverityVisible(severity: MarkerSeverity): boolean {
    return this.severityVisible[severity];
  }

  /** Severity for a marker layer key, or undefined if the key is not one. */
  static severityOfLayer(layer: string): MarkerSeverity | undefined {
    for (const s of SEVERITIES) if (layer === `board.drc_${s}` || layer === `schematic.erc_${s}`) return s;
    return undefined;
  }

  /** The marker whose legend (violation path) is drawn. */
  setFocused(id: string | null): void {
    if (this.focusedId === id) return;
    this.focusedId = id;
    this.legendDirty = true;
  }

  get focused(): string | null {
    return this.focusedId;
  }

  setOrigin(ox: number, oy: number): void {
    if (ox === this.originX && oy === this.originY) return;
    this.originX = ox;
    this.originY = oy;
    for (const o of this.objects.values()) o.position.set(o.spec.position.x - ox, o.spec.position.y - oy);
    this.legendDirty = true;
  }

  /** Current glyph scale (nm per shape unit) after the last `update`. */
  get scale(): number {
    return this.scaleNm;
  }

  /** Per frame: rescale the glyphs for the zoom and redraw the legend when needed. */
  update(zoom: number): void {
    if (zoom !== this.zoom) {
      this.zoom = zoom;
      this.scaleNm = markerScaleNm(zoom, this.kind);
      for (const o of this.objects.values()) o.scale.set(this.scaleNm);
      this.legendDirty = true;
    }
    if (this.legendDirty) this.drawLegend();
  }

  private drawLegend(): void {
    this.legendDirty = false;
    const g = this.legend;
    g.clear();
    const o = this.focusedId ? this.objects.get(this.focusedId) : undefined;
    if (!o || !o.visible) return;
    const m = o.spec;
    const s = this.scaleNm;
    const ox = this.originX;
    const oy = this.originY;
    // the legend contrasts with the background (PCB_PAINTER: legend in the background colour
    // over a halo of the opposite lightness)
    const dark = (this.background.r * 299 + this.background.g * 587 + this.background.b * 114) / 1000 < 128;
    const halo = dark ? 0xffffff : 0x000000;
    const len = 2.5 * s;
    const p0 = { x: m.position.x - ox, y: m.position.y - oy };
    if (!m.endPosition || (m.endPosition.x === m.position.x && m.endPosition.y === m.position.y)) {
      g.moveTo(p0.x - len, p0.y - len).lineTo(p0.x + len, p0.y + len);
      g.moveTo(p0.x - len, p0.y + len).lineTo(p0.x + len, p0.y - len);
    } else {
      const p1 = { x: m.endPosition.x - ox, y: m.endPosition.y - oy };
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = (-dy / d) * len;
      const ny = (dx / d) * len;
      g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
      g.moveTo(p0.x + nx, p0.y + ny).lineTo(p0.x - nx, p0.y - ny);
      g.moveTo(p1.x + nx, p1.y + ny).lineTo(p1.x - nx, p1.y - ny);
    }
    g.stroke({ width: 3, pixelLine: true, color: halo, alpha: 0.5 });
    g.stroke({ width: 1, pixelLine: true, color: colorToHex(this.background), alpha: 1 });
  }

  /** Glyph outline of a marker in world nm at the current scale. */
  outline(m: MarkerSpec): Vec2[] {
    const s = this.scaleNm;
    return MARKER_SHAPE.map((p) => ({ x: m.position.x + p.x * s, y: m.position.y + p.y * s }));
  }

  /** Markers within `tolerance` nm of `p`, nearest first. Hidden severities are skipped. */
  pick(p: Vec2, tolerance: number): MarkerHit[] {
    if (!this.root.visible) return [];
    const hits: MarkerHit[] = [];
    const reach = 14 * this.scaleNm + tolerance;
    for (const o of this.objects.values()) {
      if (!o.visible) continue;
      const m = o.spec;
      if (Math.abs(p.x - m.position.x) > reach || Math.abs(p.y - m.position.y) > reach) continue;
      const d = distanceToPrimitive(p, { kind: 'polygon', outline: this.outline(m), holes: [], fill: true, width: 0 });
      if (d <= tolerance) hits.push({ id: m.id, marker: m, distance: d, layer: markerLayerKey(this.kind, m.severity) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.objects.clear();
  }
}
