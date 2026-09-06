# Contracts between packages

These are the interfaces that let agents work in parallel. Change them only by editing
this file first.

## Units

- World coordinates are KiCad nanometres as `number` (safe up to 2^53 nm ≈ 9000 km).
  Angles in degrees. Conversions live in `@kicad-web/client/units` (`nm`, `mm`, `mil`).
- KIIDs are strings (36-char UUID form, as in `kiapi.common.types.KIID.value`).

## ItemStore (`@kicad-web/client/store`) — producer A4, consumers A5/A6/A8

```ts
type DocumentKind = 'board' | 'schematic' | 'footprint';

interface StoredItem {
  id: string;                       // KIID
  type: string;                     // kiapi KiCadObjectType enum name, e.g. 'KOT_PCB_FOOTPRINT'
  layer?: string;                   // primary layer id, e.g. 'BL_F_Cu' (board) — undefined for schematic
  net?: string;                     // net name, when applicable
  parent?: string;                  // KIID of the containing footprint/group/sheet, if any
  proto: unknown;                   // the decoded protobuf message (protobuf-es Message)
  bbox?: { x: number; y: number; w: number; h: number }; // nm, filled lazily by consumers
}

interface StoreDiff {
  added: StoredItem[];
  updated: StoredItem[];            // same id, new proto
  removed: string[];                // KIIDs
  revision: number;                 // monotonic, per document
}

interface ItemStore {
  readonly kind: DocumentKind;
  readonly document: unknown;       // kiapi DocumentSpecifier
  readonly revision: number;
  get(id: string): StoredItem | undefined;
  all(): Iterable<StoredItem>;
  byType(type: string): Iterable<StoredItem>;
  byLayer(layer: string): Iterable<StoredItem>;
  byNet(net: string): Iterable<StoredItem>;
  subscribe(cb: (diff: StoreDiff) => void): () => void;
  // mutation goes through commits; consumers never call these directly
}
```

Schematic stores are per sheet: `schematic.sheet(path).store`.

## CanvasHost (`@kicad-web/renderer`) — producer A5/A6, consumer A8

```ts
interface Theme { /* KiCad colour theme: per-layer colours + ui colours; see renderer/core/theme */ }

interface Camera { x: number; y: number; zoom: number }  // world nm at viewport centre; zoom = px per nm

interface PickResult { id: string; distance: number }    // nearest first

interface CanvasHost {
  mount(el: HTMLElement, store: ItemStore, theme: Theme): void;
  unmount(): void;
  setTheme(theme: Theme): void;
  setCamera(cam: Partial<Camera>): void;
  getCamera(): Camera;
  zoomToFit(): void;
  setLayerVisible(layer: string, visible: boolean): void;
  setLayerOpacity(layer: string, alpha: number): void;
  setActiveLayer(layer: string): void;                   // board only: draw order + ratsnest emphasis
  setSelection(ids: string[]): void;
  setHighlightNets(nets: string[]): void;
  pick(screenX: number, screenY: number, tolerancePx?: number): PickResult[];
  screenToWorld(x: number, y: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  onPick(cb: (hits: PickResult[], ev: PointerEvent) => void): () => void;
  onHover(cb: (hit: PickResult | null, ev: PointerEvent) => void): () => void;
  onCameraChange(cb: (cam: Camera) => void): () => void;
  // move preview: the app moves items optimistically by patching the store; no renderer API needed
}
```

Board and schematic hosts are separate classes (`BoardCanvasHost`, `SchematicCanvasHost`)
sharing `renderer/core`.

## Render model (`@kicad-web/renderer/core`) — internal to A5/A6

Adapters convert protobuf items into a neutral `RenderItem` set so the core never imports
`@kicad-web/proto`:

```ts
type Primitive =
  | { kind: 'segment'; a: Vec2; b: Vec2; width: number }
  | { kind: 'arc'; start: Vec2; mid: Vec2; end: Vec2; width: number }
  | { kind: 'circle'; c: Vec2; r: number; width: number; fill: boolean }
  | { kind: 'polygon'; outline: Vec2[]; holes: Vec2[][]; fill: boolean; width: number }
  | { kind: 'bezier'; p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2; width: number }
  | { kind: 'text-shapes'; polys: Vec2[][] }        // from GetTextAsShapes
  | { kind: 'image'; c: Vec2; w: number; h: number; dataUrl: string };

interface RenderItem { id: string; layer: string; net?: string; prims: Primitive[]; bbox: Box }
```

## Bridge WebSocket protocol (`@kicad-web/client/transport/ws-bridge-protocol`) — producer A3

Binary frame: 4-byte big-endian correlation id + raw `ApiRequest`/`ApiResponse` bytes.
Text frame: JSON control messages `{type:'hello', sessionId, kicadToken}`,
`{type:'error', id, code, message}`, `{type:'server-state', state}`.
HTTP: `POST /sessions {path}`, `GET /sessions`, `DELETE /sessions/:id`, `GET /health`,
`/files/*` restricted to a workspace root.

## Commands (`tooling/coverage/commands.json`) — producer A2, consumer A4

Array of `{ command, group, requestType, responseType, handlers[], headless }`; the client's
`commands.ts` is generated from it.
