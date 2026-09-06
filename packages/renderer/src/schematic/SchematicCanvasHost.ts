import { BaseCanvasHost, type CanvasHostOptions, type ItemStoreLike, type PickResult, type StoredItemLike } from '../core/host.js';
import type { RenderItem } from '../core/model.js';
import type { CameraState } from '../core/camera.js';
import { KICAD_DEFAULT_THEME, type Theme } from '../core/theme.js';
import { SCHEMATIC_DRAW_ORDER } from './schematicLayers.js';
import { type SchematicAdapterContext, schematicItemToRenderItems } from './schematicAdapter.js';
import { type TextGlyphOptions, createTextGlyphBuilder } from './textGlyphs.js';

export interface SchematicCanvasHostOptions extends CanvasHostOptions {
  adapter?: SchematicAdapterContext;
  /** BitmapText fallback for text without server shapes; `false` disables it (text-glyphs draw nothing) */
  textGlyphs?: TextGlyphOptions | false;
}

/** Items the store may list separately although their parent symbol / sheet draws them. */
const CHILD_TYPES = new Set(['KOT_SCH_PIN', 'KOT_SCH_FIELD', 'KOT_SCH_SHEET_PIN']);

/**
 * CanvasHost for schematics. Renders one sheet's ItemStore at a time; `setStore` switches
 * sheets cheaply and remembers the camera per store. Layer ids are theme keys
 * (`schematic.wire`, ...; see SCHEMATIC_DRAW_ORDER).
 */
export class SchematicCanvasHost extends BaseCanvasHost {
  protected override readonly kind = 'schematic' as const;
  adapter: SchematicAdapterContext;
  private cameras = new WeakMap<ItemStoreLike, CameraState>();

  constructor(theme: Theme = KICAD_DEFAULT_THEME, options: SchematicCanvasHostOptions = {}) {
    const scene = { ...(options.scene ?? {}) };
    if (options.textGlyphs !== false && !scene.primitiveBuilder) scene.primitiveBuilder = createTextGlyphBuilder(options.textGlyphs || {});
    super(theme, { ...options, scene, overlays: { gridUnit: 'mil', ...(options.overlays ?? {}) } });
    this.overlays.setTheme(theme, 'schematic');
    this.adapter = { ...(options.adapter ?? {}) };
  }

  protected toRenderItems(item: StoredItemLike): RenderItem[] {
    if (item.parent && CHILD_TYPES.has(item.type) && this.store?.get(item.parent)) return [];
    return schematicItemToRenderItems(item, this.adapter);
  }

  protected drawOrder(): string[] {
    return [...SCHEMATIC_DRAW_ORDER];
  }

  /** Schematics have no active-layer draw order; kept for the CanvasHost contract. */
  override setActiveLayer(_layer: string): void {
    /* no-op */
  }

  /** Switch sheets: the previous sheet's camera is remembered and restored when it comes back. */
  override setStore(store: ItemStoreLike): void {
    if (store === this.currentStore) return;
    if (this.currentStore) this.cameras.set(this.currentStore, this.getCamera());
    super.setStore(store);
    const cam = this.cameras.get(store);
    if (cam) this.setCamera(cam);
    else this.zoomToFit();
  }

  /** Forget the remembered camera of a sheet (e.g. when it is closed). */
  forgetCamera(store: ItemStoreLike): void {
    this.cameras.delete(store);
  }

  /** Update adapter extras (text shapes, Any decoder, ...) and rebuild everything. */
  setAdapterContext(patch: Partial<SchematicAdapterContext>): void {
    this.adapter = { ...this.adapter, ...patch };
    this.rebuildAll();
    this.requestRender();
  }

  /** True when a pick result is a symbol pin (`ref` = `<symbol kiid>:<pin number>`). */
  static isPinHit(hit: PickResult): boolean {
    return hit.id.includes('@pin:') && !hit.id.endsWith(':name') && !hit.id.endsWith(':number');
  }

  /** Nearest pin under a screen point, if any. */
  pickPin(screenX: number, screenY: number, tolerancePx?: number): PickResult | undefined {
    return this.pick(screenX, screenY, tolerancePx).find((h) => SchematicCanvasHost.isPinHit(h));
  }
}
