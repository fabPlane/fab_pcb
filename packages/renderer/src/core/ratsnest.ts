/**
 * Ratsnest overlay: the unrouted connections ("airlines") as hairlines in the theme's
 * `board.ratsnest` colour, drawn in world space under the scene root so pan / zoom stays a
 * GPU uniform. Geometry is relative to the scene origin (rebuilt when the origin re-bases).
 *
 * Emphasis follows pcbnew: with a net highlight or a selection active, edges of the
 * highlighted nets or touching a selected item are drawn at full alpha and everything else
 * is dimmed; with neither, every edge uses the theme colour's own alpha.
 */
import { Container, Graphics } from 'pixi.js';
import type { Vec2 } from './model.js';
import { type Theme, type ThemeColor, colorToHex, themeColor } from './theme.js';

export interface RatsnestEdge {
  net: string;
  a: Vec2;
  b: Vec2;
  /** KIIDs of the items at each end (pad / via / track / zone), for selection emphasis */
  source?: string;
  target?: string;
}

export class RatsnestLayer {
  readonly root = new Container();
  private normal = new Graphics();
  private bright = new Graphics();
  private dim = new Graphics();
  private edges: RatsnestEdge[] = [];
  private color: ThemeColor;
  private highlight = new Set<string>();
  private selected = new Set<string>();
  private originX = 0;
  private originY = 0;
  private dirty = true;
  /** alpha multiplier for edges outside the emphasised set (matches Scene.dimAlpha) */
  dimAlpha = 0.2;

  constructor(theme: Theme) {
    this.color = themeColor(theme, 'board.ratsnest');
    this.root.label = 'ratsnest';
    this.root.eventMode = 'none';
    this.root.zIndex = 1_000_000;
    this.root.addChild(this.dim, this.normal, this.bright);
  }

  setTheme(theme: Theme): void {
    this.color = themeColor(theme, 'board.ratsnest');
    this.dirty = true;
  }

  setEdges(edges: RatsnestEdge[]): void {
    this.edges = edges;
    this.dirty = true;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  setHighlightNets(nets: string[]): void {
    this.highlight = new Set(nets);
    this.dirty = true;
  }

  /** KIIDs / render ids of the selected items (edges touching them are emphasised). */
  setSelectedRefs(refs: Iterable<string>): void {
    this.selected = new Set(refs);
    this.dirty = true;
  }

  setOrigin(ox: number, oy: number): void {
    if (ox === this.originX && oy === this.originY) return;
    this.originX = ox;
    this.originY = oy;
    this.dirty = true;
  }

  /** Classify an edge: 'bright' / 'dim' with emphasis active, 'normal' otherwise. */
  emphasis(e: RatsnestEdge): 'normal' | 'bright' | 'dim' {
    if (!this.highlight.size && !this.selected.size) return 'normal';
    if (this.highlight.has(e.net)) return 'bright';
    if ((e.source && this.selected.has(e.source)) || (e.target && this.selected.has(e.target))) return 'bright';
    return 'dim';
  }

  /** Rebuild the graphics if anything changed. Call once per frame. */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const ox = this.originX;
    const oy = this.originY;
    const color = colorToHex(this.color);
    const buckets = { normal: this.normal, bright: this.bright, dim: this.dim };
    const used = { normal: false, bright: false, dim: false };
    for (const g of Object.values(buckets)) g.clear();
    for (const e of this.edges) {
      const k = this.emphasis(e);
      buckets[k].moveTo(e.a.x - ox, e.a.y - oy).lineTo(e.b.x - ox, e.b.y - oy);
      used[k] = true;
    }
    if (used.normal) this.normal.stroke({ width: 1, pixelLine: true, color, alpha: this.color.a });
    if (used.bright) this.bright.stroke({ width: 1, pixelLine: true, color, alpha: 1 });
    if (used.dim) this.dim.stroke({ width: 1, pixelLine: true, color, alpha: this.color.a * this.dimAlpha });
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
