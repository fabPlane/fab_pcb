# @kicad-web/app

Browser UI for kicad-web: docked editor shell (React + Zustand), the PixiJS board and
schematic canvases from `@kicad-web/renderer`, interactive placement tools, a schema-driven
properties panel, undo through KiCad's own stack, jobs with async progress, DRC/ERC with canvas
markers, a library browser, the schematic workflow (annotate / update PCB / fields table), a
three.js 3D view and a footprint editor. It talks to KiCad through `@kicad-web/client` over the
bridge.

## Running

Three service graphs implement the same `Services` interface (`src/services/types.ts`):

| mode | when | what |
|---|---|---|
| **mock** (default) | `bun run dev` with nothing set, or `?mock=1`, or `VITE_SERVICES=mock` | in-memory kitchen-sink board/schematic, Canvas2D mock host; what the e2e smoke tests run against |
| **kicad via bridge** (the default for real work) | `VITE_BRIDGE_URL=<bridge origin>` or `?bridge=<origin>` (`proxy` / `1` = same origin), or `VITE_SERVICES=kicad` | real KiCad through the bridge: `KicadSessionService`, `KicadDocumentService`, `KicadCommitBackend`, `KicadJobsService`, `KicadMarkerService` (`src/services/kicad/`) and the real `BoardCanvasHost` / `SchematicCanvasHost` |
| **kicad direct ws** | `VITE_KICAD_WS=ws://host:port/path` or `?kicad-ws=<url>` | the same services, but `NngWsTransport` dials `kicad-cli api-server --socket ws://…` itself: **no bridge in the request path** ([below](#direct-websocket-mode-vite_kicad_ws)) |

Real mode, step by step (macOS paths from this checkout):

```sh
# 1. the bridge: spawns one `kicad-cli api-server` per session, default port 4020
KICAD_CLI=/Users/hyper/projects/tensorfleet/kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli \
WORKSPACE_ROOT=/Users/hyper/projects/tensorfleet/kicad/qa/data \
bun run --filter @kicad-web/bridge start

# 2. the app, pointed at the bridge (or omit the variable and open http://localhost:5173/?bridge=http://127.0.0.1:4020)
VITE_BRIDGE_URL=http://127.0.0.1:4020 bun run --filter @kicad-web/app dev
```

`vite.config.ts` proxies `/sessions`, `/files`, `/health` and `/ws` to `BRIDGE_URL` (default
`http://127.0.0.1:${BRIDGE_PORT ?? 4020}`), so `?bridge=proxy` works without CORS; the built
`dist/` can also be served by the bridge itself (`STATIC_DIR=apps/web/dist`).

`?project=<path>` opens a file straight away (a `.kicad_pro`, `.kicad_pcb` or `.kicad_sch`
inside the bridge workspace root). The project screen's file browser is `GET /files/list`.

### Direct WebSocket mode (`VITE_KICAD_WS`)

KiCad's `--socket` takes `ws://host:port/path` as well as `ipc://` and `tcp://`, and nng's
WebSocket transport is something a browser can speak natively. In this mode the page dials the
api-server itself and the bridge is out of the request path entirely:

```sh
# 1. the server, listening on a WebSocket instead of a unix socket
/Users/hyper/projects/tensorfleet/kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli \
  api-server /Users/hyper/projects/tensorfleet/kicad/qa/data/pcbnew/api_kitchen_sink.kicad_pcb \
  --socket ws://127.0.0.1:5599/kicad

# 2. the app, dialling it directly (or open http://localhost:5173/?kicad-ws=ws://127.0.0.1:5599/kicad)
VITE_KICAD_WS=ws://127.0.0.1:5599/kicad bun run --filter @kicad-web/app dev
```

With no `--token`, the server mints one and the client picks it up from the first reply; pass
`--token <t>` to pin it. `--no-events` turns the events socket off, and the document service falls
back to polling `GetDocumentRevision`.

**What runs over which path.** Requests (`ApiRequest`/`ApiResponse`) go straight to KiCad over
`NngWsTransport`, and events over `NngWsSubscriber` on `GetServerInfo.events_socket_url`, which for
a `ws://` request socket is the same host and port with `/events` appended
(`ws://127.0.0.1:5599/kicad/events`) — one TCP port serves both. The bridge is then only needed for
the things that are not KiCad API calls at all:

| feature | needs the bridge | why |
|---|---|---|
| Ping, GetVersion, GetItems, commits, undo, DRC/ERC, jobs, canvas geometry | no | plain API requests on the direct socket |
| document events (`DocumentChanged`, `JobProgress`, …) | no | `ws://…/events`, subscribed by the page |
| project browser, `?project=` outside the server's own document, job output files | **yes** | `/files/*` — reading the filesystem is not part of the KiCad API |
| opening a *different* project, creating one | **yes** | `POST /sessions` spawns a `kicad-cli` for it; a running server is bound to what it has open |
| library browser and footprint editor | **yes** | they need a *second* `kicad-cli` process, which only the bridge can spawn |
| stopping the server when the tab closes | n/a | the server was not spawned by the tab, so it is left running |

So there are two useful shapes:

- **`?kicad-ws=…` on its own** (`bridgeless`): no bridge at all. The app connects on load and adopts
  whatever document the server already has open (`GetOpenDocuments`), so no project has to be named.
  The project browser, project creation and the library session report that they need a bridge.
  Right for pointing the UI at an api-server someone else is already running — a remote or
  containerised KiCad, a debugging session, a demo — and for measuring the API without a proxy in
  the way.
- **`?kicad-ws=…&bridge=…`**: requests still bypass the bridge, but `/files/*` and session spawning
  are available, so the project browser and the library editor keep working.

**When the bridge path is still the right default.** It spawns and supervises `kicad-cli` per
session, cleans up on `pagehide`, serves the workspace files the project browser needs, can host the
built app itself (`STATIC_DIR`), and needs only one open port. Direct mode requires someone to have
started an api-server with a `ws://` socket already, and gives the browser a socket to KiCad with no
policy in front of it — fine on a loopback address, something to think about anywhere else, since
KiCad's ws listener does no origin checking and its `--token` is the only access control.

Latency is not the reason to choose either one. Measured on this machine with
`bun tooling/bench/transport-latency.ts` (500 sequential Pings on the kitchen-sink board, after 50
warm-up requests), the three paths are within a tenth of a millisecond of each other:

| path | mean | median | p95 |
|---|---|---|---|
| ipc (unix socket, Bun) | 0.035 ms | 0.034 ms | 0.043 ms |
| bridge (ws → bridge → ipc) | 0.081 ms | 0.078 ms | 0.111 ms |
| direct ws (`NngWsTransport`) | 0.091 ms | 0.090 ms | 0.122 ms |

The bridge's extra ipc hop is cheaper than the difference between nng's WebSocket implementation and
Bun's, so on one machine the bridge is not the bottleneck; direct mode's win is architectural (no
second process to run and supervise), not a speed-up.

## How the real mode is wired

- **Session** (`KicadSessionService`): `POST /sessions {path}` → `WebSocketTransport` on
  `/ws?session=<id>` → `KiCad.connect`. Bridge `server-state` frames and transport closes
  become `SessionInfo.state`; a dropped socket is re-dialled (backoff) while the bridge still
  lists the session; `pagehide` deletes the session so closed tabs do not leak `kicad-cli`
  processes. `/files/*` backs the browser and job outputs. In direct mode (`directWsUrl`) there is
  no session to create: `NngWsTransport` dials KiCad's own `ws://` listener, the session id *is*
  that URL, reconnect redials it without asking the bridge whether it still exists, and neither
  `pagehide` nor `disconnect()` stops a server the tab never started.
- **Documents** (`KicadDocumentService`): the bridge preloads the file it was given
  (`kicad-cli api-server <path>`), so `GetOpenDocuments` is consulted first and `OpenDocument`
  only fills in the board / root schematic next to a `.kicad_pro`. Stores are the client's
  `DocumentSync` stores (board: every item type; schematic: one store per sheet from
  `GetSchematicHierarchy`, keyed `/<kiid>/<kiid>`, `'/'` = root). Layers from
  `GetBoardEnabledLayers` + `GetBoardLayerName`, nets from `GetNets` + `GetNetClassForNets`,
  board setup from stackup / design rules / custom rules, net classes, text variables and
  variants through the client. Dirty flags compare `GetDocumentRevision` with the revision at
  open/save. KiCad's events socket is relayed by the bridge (`KiCadEvents`): `DocumentChanged`
  re-syncs the stores, `DocumentSaved` clears the dirty flag, `JobProgress` wakes job waits; the
  2 s `GetDocumentRevision` poll only runs while the bridge reports its events subscription down.
- **Commits** (`KicadCommitBackend`): a `Transaction` becomes `BeginCommit` →
  `CreateItems` / `UpdateItems` / `DeleteItems` → `EndCommit(CMA_COMMIT)`; KiCad's canonical
  items replace the optimistic copies through the client's `DocumentSync`; a rejected item
  drops the commit (`CMA_DROP`) and `CommandService` rolls the store back. Transactions are
  serialised because KiCad allows one open commit per client. Undo/redo replays the recorded
  inverse/forward ops as new commits (no server-side undo).
- **Canvas** (`KicadCanvas.ts`): `BoardCanvasHost` / `SchematicCanvasHost` with adapter
  contexts fed from KiCad — `copperLayers` from the enabled layers, `padPolygons` from
  `GetPadShapeAsPolygon` (one request per copper layer, cached per pad/layer), `textShapes`
  from `GetTextAsShapes` (board texts + footprint fields, schematic texts + symbol fields,
  batched, cached by a hash of the text so edits re-tessellate only what changed), `decodeAny`
  through the proto registry. The first paint uses the renderer's fallbacks;
  `setAdapterContext` upgrades it when the server shapes arrive. Theme: the renderer's
  `kicad-default.json` (dark) and a light variant (`src/canvas/theme.ts`), or one of the
  renderer's built-in KiCad themes pinned from Settings.
- **Theme**: dark by default, light and "system" (follows `prefers-color-scheme`) from
  Settings… (Mod+,) → Appearance. Tokens live in `src/theme/tokens.css` (dark on `:root`,
  light under `[data-theme="light"]`); `src/theme/index.ts` resolves the persisted preference
  (`localStorage["kicad-web.ui"]`) and keeps `<html data-theme>` in sync, and an inline script
  in `index.html` applies it before the first paint so there is no flash.
- **Properties**: `fromDescriptor` / `schemaFor(..., desc)` read the protobuf-es descriptors
  (`kiapiRegistry`) so real items are editable — numeric enums show their value names, int64
  distances stay `bigint`, oneofs expose `case` / `value`; value-shape inference remains the
  fallback for the mock's plain objects.
- **Jobs** (`KicadJobsService`): `RunBoardJobExport{Svg,Gerbers,Drill,Position,Pdf,Dxf,3D (STEP
  and GLB),Ipc2581,ODB}` and `RunSchematicJobExport{Svg,Pdf,BOM,Netlist}` write into
  `<project dir>/kicad-web-out/<job>-<run>/` (created through `/files/mkdir`); outputs are listed
  through `/files/list` and downloadable through `/files/read`. Every job is started with
  `RunJobSettings.async`: the server answers `JS_RUNNING` + a job id and `Job.wait` polls
  `GetJobStatus` (woken by `JobProgress` events) into the run's progress bar and log; a server
  that runs jobs synchronously simply returns the finished result.
- **Editing tools** (`src/canvas/tools.ts`, `src/commands/editing.ts`, `src/lib/create.ts`):
  board route (click-click, `V` = via + layer switch), via, line / rect / circle / arc / polygon,
  text, zone (outline → net/layer prompt → `RefillZones`), footprint by LIB_ID; schematic wire /
  bus (90° bends), junction, no-connect, local / global / hierarchical labels, text, symbol by
  LIB_ID, hierarchical sheet. Items are built as protobuf-es messages and committed as one
  transaction (`BeginCommit` → `CreateItems` → `EndCommit`), so every tool run is one undo step.
  Rotate by angle, set layer / net, align / distribute, duplicate, copy / paste (in-app clipboard
  replayed through `CreateItems`) and `Edit → Paste KiCad clipboard text…` (`SaveItemsToString`
  on copy, `ParseAndCreateItemsFromString` on paste, recorded in the history so undo deletes the
  pasted items) live in the Edit menu and the canvas context menu.
- **Library access** (`KicadLibraryService`): footprint and symbol definitions come from
  `OpenDocument(DOCTYPE_FOOTPRINT / DOCTYPE_SYMBOL)` + `GetItems` in a second bridge session on
  the same project (so the project's `fp-lib-table` / `sym-lib-table` apply); the footprint
  editor edits and saves (`SaveDocument`) that library document. `FootprintInstance.definition`
  carries the library children translated to the placement position (KiCad's deserializer
  rebuilds pads from it in absolute coordinates), see `makeFootprintInstance`.
- **Board setup / page settings** (`KicadBoardSetup.ts`): the dialog writes only the pages that
  changed with `SetBoardDesignRules`, `UpdateBoardStackup`, `SetCustomDesignRules` (name /
  condition / comment / severity on the rules KiCad served) and `SetBoardOrigin`; `Tools → Page
  settings` reads / writes `GetPageSettings` / `GetTitleBlockInfo` and their setters for the board
  and the schematic.
- **3D** (`src/screens/ThreeDView.tsx`): `Window → Open 3D viewer` runs `RunBoardJobExport3D`
  (GLB) and shows it with three.js (`GLTFLoader` + `OrbitControls`); Refresh re-exports.
- **Cross-probe** (`src/services/crossProbe.ts`): selecting a footprint selects the symbol with
  the same reference (and vice versa); `Inspect → Cross-probe` jumps to the other editor.
  KiCad's `SyncSelection` / `FocusOnItem` are GUI-only, hence the client-side match.
- **Markers** (`KicadMarkerService`): `RunBoardJobDrc` / `GetDrcMarkers` /
  `SetDrcMarkerExcluded` and the ERC twins, offered only when `GetSupportedCommands` advertises
  them (the capability table is re-read after documents open, because handlers register per
  document type); otherwise the panel shows "not supported by this server". The panel also owns
  the canvas overlay: the visible markers go to `host.setMarkers`, a row click runs
  `host.focusMarker` and selects the offending items, and excluding one asks for KiCad's
  `exclusion_comment` first. `Get|SetDrcSeverities` (and the ERC twins) back the severities editor
  (Inspect → DRC severities…, or the "severities…" link in the panel).
- **Library browser** (`src/components/dialogs/LibraryBrowserDialog.tsx`, `KicadLibraryService`):
  `GetLibraryTables` → the fp-lib-table / sym-lib-table rows, `ListLibraryEntries` → one library's
  entries (fetched unfiltered once per library and filtered in memory, because KiCad loads the
  library on demand and the first listing of a big one is slow), and a preview of the selected
  entry rendered by the ordinary `BoardCanvasHost` / `SchematicCanvasHost` over a throwaway
  one-item store (`library.preview()`). It is what `Place footprint…` / `Place symbol…` /
  `Assign footprints` now open; the "Library id" field in its footer keeps typing a LIB_ID
  available as the fallback. `Tools → Browse libraries…` (Mod+Shift+A) opens it on its own.
- **Board tools** (`KicadBoardTools`): `GetRatsnest` / `GetUnroutedCount` (unrouted connections in
  the status bar, ratsnest toggle on the toolbar and Alt+R), `GetNetLengths` (the net inspector's
  sortable length table for the highlighted nets), and the bulk operations in the palette with
  small option dialogs — `SetTeardrops` / `RemoveTeardrops`, `AutoplaceFootprints`,
  `UpdateFootprintsFromLibrary`, `GlobalDeletion`.
- **Schematic workflow** (`KicadSchematicTools`): `Annotate` / `ClearAnnotation` (scope, sort
  order, numbering, start number, reset — with KiCad's report in the dialog),
  `SyncSchematicToBoard` ("Update PCB from schematic", previewed with a dry run before it is
  applied), `GetSymbolFieldsTable` / `SetSymbolFields` as an editable grid that commits every
  pending edit in one call, and `AssignFootprints` driven from the library browser.
- **Undo** (`KicadUndoService` over the client's `DocumentUndo`): KiCad's own stack (`Undo` /
  `Redo` / `GetUndoStack`) whenever `GetSupportedCommands` advertises it, which also reverts what
  never passed through a commit — zone fills, connectivity, `SetBoardOrigin`, the netlist updater;
  the app's `CommandService` history is the fallback otherwise. The History panel says which mode
  is live and lists the active stack. Server-side operations re-read the document through
  `KicadDocumentService.resyncDocument()`: the `DocumentChanged` relay skips them, because it sees
  our own client name and assumes the commit backend already applied the diff.
- **Server settings** (`KicadSettingsService`): `ListColorThemes` / `GetColorTheme` put KiCad's own
  colour themes in Settings → Appearance (they use the same flat theme keys the renderer does, so
  a server theme drops straight onto the canvas as `server:<name>`), and `GetAppSettings` shows the
  PCB editor's units / grid / theme defaults with a button that adopts them.

## Proof against real KiCad

`scripts/prove-kicad.mjs` drives the app in headless Chromium (Playwright from `e2e/`) against
a throwaway copy of the kitchen-sink project inside the bridge workspace root (project-local
library tables). Steps (`node apps/web/scripts/prove-kicad.mjs [step,...]`): `board` (open,
pick R1), `edit` (properties X, undo through `SaveDocumentToString`), `route` (track + via +
layer switch, undo / redo, via tool), `draw` (line / rect / circle / arc / polygon / text /
filled zone), `footprint` (place `Resistor_SMD:R_0603_1608Metric`, pads verified in the file),
`align` (align / distribute / rotate by 45° / set layer / set net), `clipboard` (duplicate,
copy / paste, `SaveItemsToString` → `ParseAndCreateItemsFromString` + undo), `markers` (DRC,
canvas overlay, focus + selection, exclusion comment, severities editor), `nets` (unrouted count,
ratsnest toggle, `GetNetLengths` with sortable columns), `serverundo` (place a via, undo it
through KiCad's stack), `settings` (KiCad's colour themes and `GetAppSettings` defaults),
`boardtools` (teardrops, update from library, autoplace, global deletion), `setup` (design
rules, stackup, custom rules, origin round trip), `page` (title block / page size), `3d` (GLB
export rendered in three.js), `jobs` (every export incl. async progress), `fpeditor` (edit a
pad in the footprint editor, `SaveDocument` writes the `.kicad_mod`), `schematic` (wire, bus,
junction, no-connect, three labels, text, `Device:R`, hierarchical sheet, save), `annotate`,
`fields`, `updatepcb`, `crossprobe`, `erc`. Commands that open a prompt are started without
awaiting them (`run()`), then the prompt is filled. Screenshots land in `docs/screenshots/`.

The DRC-driven steps deliberately run **before** `jobs`: measured on 10.99.0-3685,
`RunBoardJobDrc` stops answering once the async export jobs have run (the proof records that as a
GAP rather than hiding it).

`docs/screenshots/direct-ws.png` is the same app with no bridge running at all
(`VITE_KICAD_WS=ws://127.0.0.1:5599/kicad`, KiCad 10.99.0-3708-g163dec0e39): the board renders,
the status bar reports the session open, and every request in the page went straight to KiCad over
`NngWsTransport`.

## Tests

```sh
bun test            # unit tests, incl. test/kicad-services.test.ts (fake transport: session
                    # lifecycle, store population from canned GetItems, commit backend) and
                    # test/batch3-services.test.ts (library caching, board-tool enums, settings
                    # translation, fields-table batching, the server/client undo picker)
bunx tsc -b
bun run --filter @kicad-web/app build
cd e2e && bun run test          # mock smoke (E2E_PORT=5175 when a dev server holds 5173)
KICAD_CLI=... bun run test:real # e2e/real: real KiCad through the bridge (skipped without KICAD_CLI)
```
