import { BaseCanvasHost, type CanvasHostOptions, type ItemStoreLike, type StoreDiffLike, type StoredItemLike } from '../core/host.js';
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

const CHILD_TYPES = new Set([
  'KOT_PCB_PAD',
  'KOT_PCB_SHAPE',
  'KOT_PCB_TEXT',
  'KOT_PCB_TEXTBOX',
  'KOT_PCB_FIELD',
  'KOT_PCB_ZONE',
  'KOT_PCB_POINT',
]);
const MM = 1_000_000;

/**
 * CanvasHost for boards. A footprint child the store lists as an item of its own (a pad, a
 * footprint text — `parent` set) is rendered from that store item, owned by the footprint for
 * selection and picking; the copy inside the footprint's `definition.items` is skipped so
 * nothing is drawn twice. Children the store does not hold (silk, courtyard, library previews)
 * are rendered from the definition, decoded through `adapter.decodeAny` when they arrive as
 * `google.protobuf.Any`.
 */
export class BoardCanvasHost extends BaseCanvasHost {
  protected override readonly kind = 'board' as const;
  adapter: BoardAdapterContext;
  private copperLayers: string[];
  /** store children by footprint, and the reverse — see `toRenderItems` */
  private childrenOf = new Map<string, Set<string>>();
  private parentOf = new Map<string, string>();
  activeLayer: string;
  private labelMinZoom: number;
  private labelUserVisible = new Map<string, boolean>();
  private labelsShown: boolean | null = null;

  constructor(theme: Theme = KICAD_DEFAULT_THEME, options: BoardCanvasHostOptions = {}) {
    const scene = { ...(options.scene ?? {}) };
    // The font-free core draws nothing for `text-glyphs`; boards only emit them for labels,
    // so the BitmapText builder is installed here and gated by `labels` at the adapter.
    if (options.labels?.textGlyphs !== false && !scene.primitiveBuilder)
      scene.primitiveBuilder = createTextGlyphBuilder(options.labels?.textGlyphs || {});
    super(theme, { ...options, scene });
    this.copperLayers = options.copperLayers ?? copperLayerList(2);
    this.activeLayer = boardLayerName(options.activeLayer ?? 'BL_F_Cu');
    this.activeLayerId = this.activeLayer;
    const labels = options.labels;
    this.labelMinZoom = (labels?.minPxPerMm ?? 20) / MM;
    this.adapter = { copperLayers: this.copperLayers, ...(options.adapter ?? {}) };
    if (labels && (labels.padNumbers || labels.netNames))
      this.adapter.labels = { padNumbers: !!labels.padNumbers, netNames: !!labels.netNames };
    this.camera.onChange(() => this.updateLabelVisibility());
    this.updateLabelVisibility();
  }

  protected toRenderItems(item: StoredItemLike): RenderItem[] {
    const own = this.childrenOf.get(item.id);
    if (item.type === 'KOT_PCB_FOOTPRINT' && own?.size)
      return boardItemToRenderItems(item, { ...this.adapter, storeChild: (kiid) => own.has(kiid) });
    const parent = this.parentOf.get(item.id);
    return boardItemToRenderItems(item, this.adapter, parent);
  }

  override mount(el: HTMLElement, store: ItemStoreLike, theme: Theme): void {
    this.indexChildren(store);
    super.mount(el, store, theme);
  }

  override setStore(store: ItemStoreLike): void {
    if (store !== this.currentStore) this.indexChildren(store);
    super.setStore(store);
  }

  override unmount(): void {
    super.unmount();
    this.childrenOf.clear();
    this.parentOf.clear();
  }

  /** Selecting a footprint highlights the children the store renders for it. */
  override setSelection(ids: string[]): void {
    const all = new Set(ids);
    for (const id of ids) for (const c of this.childrenOf.get(id) ?? []) all.add(c);
    super.setSelection([...all]);
  }

  protected override applyStoreDiff(diff: StoreDiffLike): void {
    // Keep the child index current first, then rebuild every footprint whose set of store
    // children changed but is not itself in the diff: it switches between drawing a child from
    // its definition and leaving it to the store item, and its pickable body follows.
    const parents = new Set<string>();
    for (const id of diff.removed) {
      const p = this.parentOf.get(id);
      if (p) parents.add(p);
      this.unlink(id);
    }
    for (const it of [...diff.added, ...diff.updated]) {
      const prev = this.parentOf.get(it.id);
      const next = this.footprintParent(it);
      if (prev === next) continue;
      if (prev) parents.add(prev);
      this.unlink(it.id);
      if (next) {
        this.link(it.id, next);
        parents.add(next);
      }
    }
    super.applyStoreDiff(diff);
    const touched = new Set([...diff.added, ...diff.updated].map((i) => i.id));
    const rebuild = [...parents].filter((p) => !touched.has(p) && this.store?.get(p));
    if (rebuild.length) this.rebuildItems(rebuild);
  }

  private indexChildren(store: ItemStoreLike): void {
    this.childrenOf.clear();
    this.parentOf.clear();
    for (const it of store.all()) {
      const p = this.footprintParent(it, store);
      if (p) this.link(it.id, p);
    }
  }

  /** The footprint a store item belongs to (pads, footprint texts...; not group members). */
  private footprintParent(it: StoredItemLike, store = this.store): string | undefined {
    if (!it.parent || !CHILD_TYPES.has(it.type)) return undefined;
    return store?.get(it.parent)?.type === 'KOT_PCB_FOOTPRINT' ? it.parent : undefined;
  }

  private link(id: string, parent: string): void {
    this.parentOf.set(id, parent);
    let set = this.childrenOf.get(parent);
    if (!set) this.childrenOf.set(parent, (set = new Set()));
    set.add(id);
  }

  private unlink(id: string): void {
    const p = this.parentOf.get(id);
    if (p === undefined) return;
    this.parentOf.delete(id);
    const set = this.childrenOf.get(p);
    set?.delete(id);
    if (set && set.size === 0) this.childrenOf.delete(p);
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
