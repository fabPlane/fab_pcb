import { BaseCanvasHost, type CanvasHostOptions, type StoredItemLike } from '../core/host.js';
import type { RenderItem } from '../core/model.js';
import { KICAD_DEFAULT_THEME, type Theme } from '../core/theme.js';
import { LABEL_LAYERS, boardDrawOrder, boardLayerName, copperLayerList } from './boardLayers.js';
import { type BoardAdapterContext, type BoardLabelOptions, boardItemToRenderItems } from './boardAdapter.js';
import { type TextGlyphOptions, createTextGlyphBuilder } from '../schematic/textGlyphs.js';

export interface BoardLabelHostOptions extends BoardLabelOptions {
  /** labels are shown from this zoom on (px per mm; default 20, i.e. 1 mm >= 20 px) */
  minPxPerMm?: number;
  /** BitmapText options for the label glyphs; `false` disables the builder (labels draw nothing) */
  textGlyphs?: TextGlyphOptions | false;
}

export interface BoardCanvasHostOptions extends CanvasHostOptions {
  adapter?: BoardAdapterContext;
  /** copper layers front to back; default 2-layer */
  copperLayers?: string[];
  activeLayer?: string;
  /** pad number / net name labels at high zoom (`setLabelOptions`); off by default */
  labels?: BoardLabelHostOptions;
}

const CHILD_TYPES = new Set(['KOT_PCB_PAD', 'KOT_PCB_SHAPE', 'KOT_PCB_TEXT', 'KOT_PCB_TEXTBOX', 'KOT_PCB_FIELD', 'KOT_PCB_ZONE', 'KOT_PCB_POINT']);
const MM = 1_000_000;

/**
 * CanvasHost for boards. Footprint children are rendered from the footprint's
 * `definition.items`; if the store also lists them as separate items with `parent` set,
 * those are skipped so nothing is drawn twice.
 */
export class BoardCanvasHost extends BaseCanvasHost {
  protected override readonly kind = 'board' as const;
  adapter: BoardAdapterContext;
  private copperLayers: string[];
  activeLayer: string;
  private labelMinZoom: number;
  private labelUserVisible = new Map<string, boolean>();
  private labelsShown: boolean | null = null;

  constructor(theme: Theme = KICAD_DEFAULT_THEME, options: BoardCanvasHostOptions = {}) {
    const scene = { ...(options.scene ?? {}) };
    // The font-free core draws nothing for `text-glyphs`; boards only emit them for labels,
    // so the BitmapText builder is installed here and gated by `labels` at the adapter.
    if (options.labels?.textGlyphs !== false && !scene.primitiveBuilder) scene.primitiveBuilder = createTextGlyphBuilder(options.labels?.textGlyphs || {});
    super(theme, { ...options, scene });
    this.copperLayers = options.copperLayers ?? copperLayerList(2);
    this.activeLayer = boardLayerName(options.activeLayer ?? 'BL_F_Cu');
    const labels = options.labels;
    this.labelMinZoom = (labels?.minPxPerMm ?? 20) / MM;
    this.adapter = { copperLayers: this.copperLayers, ...(options.adapter ?? {}) };
    if (labels && (labels.padNumbers || labels.netNames)) this.adapter.labels = { padNumbers: !!labels.padNumbers, netNames: !!labels.netNames };
    this.camera.onChange(() => this.updateLabelVisibility());
    this.updateLabelVisibility();
  }

  protected toRenderItems(item: StoredItemLike): RenderItem[] {
    if (item.parent && CHILD_TYPES.has(item.type) && this.store) {
      const parent = this.store.get(item.parent);
      const def = (parent?.proto as { definition?: { items?: unknown[] } } | undefined)?.definition;
      if (parent?.type === 'KOT_PCB_FOOTPRINT' && def?.items?.length) return [];
    }
    return boardItemToRenderItems(item, this.adapter);
  }

  protected drawOrder(): string[] {
    return boardDrawOrder({ copperLayers: this.copperLayers, activeLayer: this.activeLayer, flipped: this.flipped });
  }

  override setActiveLayer(layer: string): void {
    this.activeLayer = boardLayerName(layer);
    super.setActiveLayer(this.activeLayer);
  }

  getCopperLayers(): readonly string[] {
    return this.copperLayers;
  }

  /** Copper layer list from GetBoardEnabledLayers / stackup (front to back). Rebuilds vias/pads. */
  setCopperLayers(layers: string[]): void {
    this.copperLayers = layers.map(boardLayerName);
    this.adapter = { ...this.adapter, copperLayers: this.copperLayers };
    this.scene.setDrawOrder(this.drawOrder());
    this.rebuildAll();
    this.requestRender();
  }

  /** Update adapter extras (pad polygons, text shapes...) and rebuild everything. */
  setAdapterContext(patch: Partial<BoardAdapterContext>): void {
    this.adapter = { ...this.adapter, ...patch, copperLayers: patch.copperLayers ?? this.copperLayers };
    this.rebuildAll();
    this.requestRender();
  }

  // ------------------------------------------------------------------ labels

  /**
   * Pad numbers inside pads and net names on pads / vias / tracks, drawn with the BitmapText
   * glyph path once the zoom reaches `minPxPerMm` (option; default 20 px/mm). Rebuilds the
   * scene when the set of labels changes.
   */
  setLabelOptions(opts: BoardLabelOptions & { minPxPerMm?: number }): void {
    if (opts.minPxPerMm !== undefined) this.labelMinZoom = opts.minPxPerMm / MM;
    const next = opts.padNumbers || opts.netNames ? { padNumbers: !!opts.padNumbers, netNames: !!opts.netNames } : undefined;
    const cur = this.adapter.labels;
    const changed = !!next !== !!cur || next?.padNumbers !== cur?.padNumbers || next?.netNames !== cur?.netNames;
    this.adapter = { ...this.adapter, labels: next };
    this.labelsShown = null;
    this.updateLabelVisibility();
    if (changed) this.rebuildAll();
    this.requestRender();
  }

  get labelOptions(): Readonly<BoardLabelOptions> {
    return this.adapter.labels ?? {};
  }

  /** True when the label layers are shown at the current zoom. */
  get labelsVisible(): boolean {
    return !!this.adapter.labels && this.camera.zoom >= this.labelMinZoom;
  }

  /** Label layers are zoom-gated: a user toggle is remembered and combined with the gate. */
  override setLayerVisible(layer: string, visible: boolean): void {
    if (LABEL_LAYERS.includes(layer)) {
      this.labelUserVisible.set(layer, visible);
      this.labelsShown = null;
      this.updateLabelVisibility();
      this.requestRender();
      return;
    }
    super.setLayerVisible(layer, visible);
  }

  private updateLabelVisibility(): void {
    const shown = this.camera.zoom >= this.labelMinZoom;
    if (shown === this.labelsShown) return;
    this.labelsShown = shown;
    for (const l of LABEL_LAYERS) this.scene.setLayerVisible(l, shown && (this.labelUserVisible.get(l) ?? true));
  }
}
