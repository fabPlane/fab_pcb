import { BaseCanvasHost, type CanvasHostOptions, type StoredItemLike } from '../core/host.js';
import type { RenderItem } from '../core/model.js';
import { KICAD_DEFAULT_THEME, type Theme } from '../core/theme.js';
import { boardDrawOrder, boardLayerName, copperLayerList } from './boardLayers.js';
import { type BoardAdapterContext, boardItemToRenderItems } from './boardAdapter.js';

export interface BoardCanvasHostOptions extends CanvasHostOptions {
  adapter?: BoardAdapterContext;
  /** copper layers front to back; default 2-layer */
  copperLayers?: string[];
  activeLayer?: string;
}

const CHILD_TYPES = new Set(['KOT_PCB_PAD', 'KOT_PCB_SHAPE', 'KOT_PCB_TEXT', 'KOT_PCB_TEXTBOX', 'KOT_PCB_FIELD', 'KOT_PCB_ZONE', 'KOT_PCB_POINT']);

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

  constructor(theme: Theme = KICAD_DEFAULT_THEME, options: BoardCanvasHostOptions = {}) {
    super(theme, options);
    this.copperLayers = options.copperLayers ?? copperLayerList(2);
    this.activeLayer = boardLayerName(options.activeLayer ?? 'BL_F_Cu');
    this.adapter = { copperLayers: this.copperLayers, ...(options.adapter ?? {}) };
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
}
