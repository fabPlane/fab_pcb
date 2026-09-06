# Contracts between packages

These are the interfaces that let agents work in parallel. Change them only by editing
this file first.

## Units

- World coordinates are KiCad nanometres as `number` (safe up to 2^53 nm ≈ 9000 km).
  Angles in degrees. Conversions live in `@kicad-web/client/units` (`nm`, `mm`, `mil`).
- KIIDs are strings (36-char UUID form, as in `kiapi.common.types.KIID.value`).

## ItemStore (`@kicad-web/client/store`) — producer A4, consumers A5/A6/A8

```ts
type DocumentKind = 'board' | 'schematic' | 'footprint' | 'symbol';   // 'symbol' = headless library symbol (DOCTYPE_SYMBOL)

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

interface PickResult {                                   // nearest first
  id: string;        // render item id: the KIID, or `<kiid>@<suffix>` for per-layer / child geometry
  distance: number;  // screen px from the pointer (0 = inside)
  owner: string;     // store item that produced the hit: footprint / symbol / sheet KIID for their children, else == ref
  ref: string;       // what the UI should treat as picked: object KIID without suffix; schematic pins use `<symbol kiid>:<pin number>`
  layer: string;     // render-model layer id (`BL_F_Cu`, `schematic.wire`, ...)
  net?: string;      // net name when the item carries one
}

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
  setStore(store: ItemStore): void;                      // switch documents (schematic sheets) without remounting
  // move preview: the app moves items optimistically by patching the store; no renderer API needed

  // --- overlays (A5): world-space, above the scene; a theme switch never rebuilds geometry
  setRatsnest(edges: RatsnestEdge[]): void;              // GetRatsnest airlines
  setRatsnestVisible(visible: boolean): void;
  setMarkers(markers: MarkerSpec[]): void;               // DRC / ERC violations
  setMarkersVisible(visible: boolean): void;
  focusMarker(id: string | null, opts?: { durationMs?: number; reducedMotion?: boolean; zoom?: number; onDone?: () => void }): boolean;
  readonly focusedMarker: string | null;
}

interface RatsnestEdge {
  net: string;                 // net name; edges of highlighted nets draw at full alpha
  a: Vec2; b: Vec2;            // GetRatsnest source_position / target_position, nm
  source?: string; target?: string;   // KIIDs at each end; edges touching a selected item are emphasised
}

interface MarkerSpec {
  id: string;                  // PCB_MARKER / SCH_MARKER KIID; becomes PickResult.ref
  position: Vec2;
  severity: 'error' | 'warning' | 'exclusion';
  description: string;
  layer?: string;              // board layer of the violation, informational
  endPosition?: Vec2;          // far end of the violation, for the focused marker's legend
}
```

Markers are picked directly rather than through the spatial index: a hit is
`{ id: 'marker:<id>', ref: '<marker kiid>', owner: 'marker', layer: 'board.drc_error' }`.
Per-severity visibility goes through `setLayerVisible` on `board.drc_error` /
`board.drc_warning` / `board.drc_exclusion` (or `schematic.erc_*`). `focusMarker` eases the
camera to the marker (immediate under `prefers-reduced-motion`) and returns false for an
unknown id; `focusMarker(null)` clears the legend.

`BoardCanvasHost` additionally has `setLabelOptions({ padNumbers?, netNames?, minPxPerMm? })`
for pad numbers and net names on pads / vias / tracks, off by default and zoom-gated at
`minPxPerMm` (default 20). They live on the pseudo layers `board.pad_numbers`,
`board.pad_net_names`, `board.via_net_names`, `board.track_net_names`; `setLayerVisible` on one
of those is remembered and combined with the zoom gate.

The app owns the data: `apps/web/src/services/kicad/KicadCanvas.ts` calls `GetRatsnest` after
mount and after every store diff that touches copper, and the DRC/ERC panel drives
`setMarkers` / `focusMarker`. The renderer never issues IPC itself.

Board and schematic hosts are separate classes (`BoardCanvasHost`, `SchematicCanvasHost`)
sharing `renderer/core`. `setStore` rebuilds the scene from the new store and moves the store
subscription; `SchematicCanvasHost` additionally remembers the camera per store, so switching
between `schematic.sheet(path).store` instances restores each sheet's view (first visit: zoom to
fit). Selection ids are re-resolved against the new store; hover is cleared.

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
