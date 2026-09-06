# @kicad-web/app

Browser UI for kicad-web: docked editor shell (React + Zustand), the PixiJS board and
schematic canvases from `@kicad-web/renderer`, a schema-driven properties panel, client-side
undo, jobs, DRC/ERC. It talks to KiCad through `@kicad-web/client` over the bridge.

## Running

Two service graphs implement the same `Services` interface (`src/services/types.ts`):

| mode | when | what |
|---|---|---|
| **mock** (default) | `bun run dev` with nothing set, or `?mock=1`, or `VITE_SERVICES=mock` | in-memory kitchen-sink board/schematic, Canvas2D mock host; what the e2e smoke tests run against |
| **kicad** | `VITE_BRIDGE_URL=<bridge origin>` or `?bridge=<origin>` (`proxy` / `1` = same origin), or `VITE_SERVICES=kicad` | real KiCad through the bridge: `KicadSessionService`, `KicadDocumentService`, `KicadCommitBackend`, `KicadJobsService`, `KicadMarkerService` (`src/services/kicad/`) and the real `BoardCanvasHost` / `SchematicCanvasHost` |

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

## How the real mode is wired

- **Session** (`KicadSessionService`): `POST /sessions {path}` → `WebSocketTransport` on
  `/ws?session=<id>` → `KiCad.connect`. Bridge `server-state` frames and transport closes
  become `SessionInfo.state`; a dropped socket is re-dialled (backoff) while the bridge still
  lists the session; `pagehide` deletes the session so closed tabs do not leak `kicad-cli`
  processes. `/files/*` backs the browser and job outputs.
- **Documents** (`KicadDocumentService`): the bridge preloads the file it was given
  (`kicad-cli api-server <path>`), so `GetOpenDocuments` is consulted first and `OpenDocument`
  only fills in the board / root schematic next to a `.kicad_pro`. Stores are the client's
  `DocumentSync` stores (board: every item type; schematic: one store per sheet from
  `GetSchematicHierarchy`, keyed `/<kiid>/<kiid>`, `'/'` = root). Layers from
  `GetBoardEnabledLayers` + `GetBoardLayerName`, nets from `GetNets` + `GetNetClassForNets`,
  board setup from stackup / design rules / custom rules, net classes, text variables and
  variants through the client. Dirty flags compare `GetDocumentRevision` with the revision at
  open/save; the revision is polled every 2 s while idle and a foreign change re-reads the
  stores. (KiCad publishes an events socket, `GetServerInfo.events_socket_url`, but the bridge
  does not relay it yet, hence the poll.)
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
  `kicad-default.json` (dark) and a light variant (`src/canvas/theme.ts`).
- **Properties**: `fromDescriptor` / `schemaFor(..., desc)` read the protobuf-es descriptors
  (`kiapiRegistry`) so real items are editable — numeric enums show their value names, int64
  distances stay `bigint`, oneofs expose `case` / `value`; value-shape inference remains the
  fallback for the mock's plain objects.
- **Jobs** (`KicadJobsService`): `RunBoardJobExport{Svg,Gerbers,Drill,Position,Pdf,3D}` and
  `RunSchematicJobExport{Svg,Pdf,BOM}` write into `<project dir>/kicad-web-out/<job>-<run>/`
  (created through `/files/mkdir`), outputs are listed through `/files/list` and downloadable
  through `/files/read`. `RunSchematicJobExportNetlist` is left out on purpose (wedges the
  headless server).
- **Markers** (`KicadMarkerService`): `RunBoardJobDrc` / `GetDrcMarkers` /
  `SetDrcMarkerExcluded` and the ERC twins, offered only when `GetSupportedCommands` advertises
  them (the capability table is re-read after documents open, because handlers register per
  document type); otherwise the panel shows "not supported by this server".

## Proof against real KiCad

`scripts/prove-kicad.mjs` drives the app in headless Chromium (Playwright from `e2e/`):
opens the kitchen-sink project, hovers/selects R1, edits its X in the properties panel,
verifies `GetDocumentRevision` incremented and `SaveDocumentToString` carries the new
position, undoes (revision increments again, position restored), runs DRC, runs the SVG
export and lists its output, opens `eeschema/api_kitchen_sink.kicad_sch` in its own session
(KiCad holds one project per server), walks to the subsheet and tries ERC. Screenshots land in
`docs/screenshots/`.

## Tests

```sh
bun test            # unit tests, incl. test/kicad-services.test.ts (fake transport: session
                    # lifecycle, store population from canned GetItems, commit backend)
bunx tsc -b
bun run build
```
