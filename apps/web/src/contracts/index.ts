// Local mirror of docs/contracts.md.
//
// SWAP SEAM: when `@kicad-web/client` (ItemStore) and `@kicad-web/renderer` (CanvasHost)
// land, this file becomes:
//
//   export type { DocumentKind, StoredItem, StoreDiff, ItemStore } from '@kicad-web/client/store';
//   export type { Theme, Camera, PickResult, CanvasHost } from '@kicad-web/renderer';
//
// Nothing else in apps/web imports those packages directly.

export type DocumentKind = 'board' | 'schematic' | 'footprint';

export interface StoredItem {
  id: string; // KIID
  type: string; // kiapi KiCadObjectType enum name, e.g. 'KOT_PCB_FOOTPRINT'
  layer?: string; // primary layer id, e.g. 'BL_F_Cu' (board) — undefined for schematic
  net?: string; // net name, when applicable
  parent?: string; // KIID of the containing footprint/group/sheet, if any
  proto: unknown; // decoded protobuf message; in the mock, a plain camelCase object
  bbox?: { x: number; y: number; w: number; h: number }; // nm
}

export interface StoreDiff {
  added: StoredItem[];
  updated: StoredItem[];
  removed: string[];
  revision: number;
}

export interface ItemStore {
  readonly kind: DocumentKind;
  readonly document: unknown; // kiapi DocumentSpecifier
  readonly revision: number;
  get(id: string): StoredItem | undefined;
  all(): Iterable<StoredItem>;
  byType(type: string): Iterable<StoredItem>;
  byLayer(layer: string): Iterable<StoredItem>;
  byNet(net: string): Iterable<StoredItem>;
  subscribe(cb: (diff: StoreDiff) => void): () => void;
}

/** KiCad colour theme: per-layer colours plus UI colours. */
export interface Theme {
  name: string;
  layers: Record<string, string>; // layer id -> css colour
  ui: {
    background: string;
    grid: string;
    cursor: string;
    selection: string;
    hover: string;
    highlight: string;
    ratsnest: string;
    text: string;
    pinName: string;
    wire: string;
    bus: string;
    label: string;
    symbolBody: string;
    symbolOutline: string;
    sheet: string;
  };
}

export interface Camera {
  x: number; // world nm at viewport centre
  y: number;
  zoom: number; // px per nm
}

export interface PickResult {
  id: string;
  distance: number; // px, nearest first
}

export interface CanvasHost {
  mount(el: HTMLElement, store: ItemStore, theme: Theme): void;
  unmount(): void;
  setTheme(theme: Theme): void;
  setCamera(cam: Partial<Camera>): void;
  getCamera(): Camera;
  zoomToFit(): void;
  setLayerVisible(layer: string, visible: boolean): void;
  setLayerOpacity(layer: string, alpha: number): void;
  setActiveLayer(layer: string): void;
  setSelection(ids: string[]): void;
  setHighlightNets(nets: string[]): void;
  pick(screenX: number, screenY: number, tolerancePx?: number): PickResult[];
  screenToWorld(x: number, y: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  onPick(cb: (hits: PickResult[], ev: PointerEvent) => void): () => void;
  onHover(cb: (hit: PickResult | null, ev: PointerEvent) => void): () => void;
  onCameraChange(cb: (cam: Camera) => void): () => void;
}
