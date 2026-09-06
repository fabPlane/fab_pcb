# 04 — What the IPC layer cannot do yet, and how we fix it

"100% control" means: everything a user can do in desktop KiCad for a real design
flow (project → schematic → board → outputs) can be done from a headless server. The
exact per-command state of today's API is in [api-coverage.md](api-coverage.md).
Below is everything that is missing, grouped, with the concrete fix in KiCad.

All fixes go into our KiCad fork on branch `web-api` as a patch series (one commit
per gap, each with a proto change, a handler, a QA test in `qa/tests/api`, and a
client conformance test). Every patch is written to be upstreamable; KiCad marks new
API fields with `// Since 11.0` comments, we follow that.

## Priority 0 — blocks the web UI

### G1 · Events / notifications
**Today:** REQ/REP only; the UI cannot learn that a document changed (another
client, a job finishing, a save).
**Fix:** add a PUB0 socket next to the REP socket (`api-events.sock`).
`KINNG_PUBLISHER` in `libs/kinng`; `KICAD_API_SERVER::Publish(kiapi.common.Event)`.
Emit from `API_HANDLER_EDITOR::pushCurrentCommit` (`DocumentChanged{doc, commit
id, created/updated/deleted KIIDs}`), from save/revert/open/close, and from job
progress. New proto `common/events.proto`. Bridge fans the PUB stream out over the
same WebSocket. Cheap interim: `GetDocumentRevision` (monotonic counter bumped in
`pushCurrentCommit`) so the UI can poll one small message.

### G3 · `RunAction` headless
**Today:** gated by `checkForHeadless`; the headless `TOOL_MANAGER` in
`HEADLESS_PCB_CONTEXT` has no tools registered.
**Fix:** register the non-interactive tools on demand (the `ZONE_FILLER_TOOL`
pattern already in `handleRefillZones`): board cleanup, global edit, teardrops,
autoplace, footprint update, netlist, DRC. Add `GetActions → {name, label,
description, headless_capable}` so the UI can build a palette. Actions that need a
view (zoom, interactive move) stay excluded. Same for schematic with
`SCH_CONTEXT`.

### G4 · DRC / ERC
**Today:** `DrcMarker`/`ErcMarker`/severity/exclusion messages exist in
`board_rules.proto` and `schematic_rules.proto`; `InjectDrcError` exists; nothing
runs a check or returns markers.
**Fix:** `RunBoardJobDrc{options} → {markers[], report path}` using `DRC_ENGINE`
the way `jobs/job_pcb_drc` does; `RunSchematicJobErc` likewise via `ERC_TESTER`.
`GetMarkers(document)`, `SetMarkerExcluded(ids, excluded)`, `GetDrcSeverities /
SetDrcSeverities`, `GetErcSeverities / SetErcSeverities`. Add `unconnected` and
`footprint mismatch` categories as first-class fields.

### G5 · Project and document lifecycle
**Today:** `OpenDocument` only opens existing files; no way to create a project,
board, or schematic; `DOCTYPE_SYMBOL` and `DOCTYPE_DRAWING_SHEET` are rejected.
**Fix:** `NewProject{path, template?}`, `NewDocument{project, type}`,
`GetProjectInfo`, `ListProjectFiles`. Headless symbol-editor context
(`HEADLESS_SYMBOL_CONTEXT` + `API_HANDLER_SYMBOL`) mirroring the footprint one, so
`OpenDocument(DOCTYPE_SYMBOL, lib_id)` works. Drawing sheet is lower priority.

### G6 · Register what already exists
`UpdateBoardStackup` (proto exists, no handler; wire to `BOARD_STACKUP` +
`BOARD_DESIGN_SETTINGS`), `FocusOnItem` and `RefreshEditor` (no-op success headless
so clients need no branching).

### G13 · Capability discovery
**Fix:** `GetSupportedCommands → [{type_url, headless}]` enumerated from the
registered handler tables in `KICAD_API_SERVER`. Trivial and makes every client
future-proof.

### G16 · Large documents
**Today:** `GetItems` returns everything in one nng message; no paging, no
"changed since". Large boards may exceed message limits and stall the UI.
**Fix:** `GetItems.page{offset, limit}` + `GetItems.since_revision` (pairs with G1),
and `GetItemCounts`.

## Priority 1 — full editing parity

### G7 · Library access
**Today:** only `OpenDocument(DOCTYPE_FOOTPRINT, lib_id)` and the GUI-only
`OpenLibraryItem`. No listing, no symbol lookup, no writing.
**Fix:** `GetLibraryTables{type}`, `ListLibraryEntries{type, nickname}` (with
keywords/description for search), `GetLibraryItem{lib_id} → Footprint |
SchematicSymbol`, `SaveLibraryItem`, `CreateLibrary`, `AddLibraryTableRow`. Backed
by `FOOTPRINT_LIBRARY_ADAPTER` / `SYMBOL_LIBRARY_ADAPTER` (the headless footprint
open already uses the former). Footprint wizards: `wizards.proto` types exist;
add `ListWizards` / `RunWizard` (Python-free wizards only).

### G8 · Schematic operations
`Annotate{scope, options}`, `ClearAnnotation`, `SyncSchematicToBoard{options}`
(server-side: schematic netlist → `BOARD_NETLIST_UPDATER`; today the client must
`GetSchematicNetlist`, write a file, `ImportNetlist`), `BackAnnotate`,
`GetSchematicSettings / Set`, `GetSymbolFields` bulk (a fields-table view), sheet
file management (`CreateItems` accepts `SCH_SHEET_T` but new sheet files are not
created on disk — verify and fix), `AssignFootprints` (cvpcb equivalent).

### G9 · Board operations that live in tools today
`GetRatsnest / GetUnroutedConnections` (from `CONNECTIVITY_DATA`; the UI needs this
to draw the ratsnest), `GetNetLengths` (net inspector), `CleanupTracks`,
`GlobalDeletion`, `UpdateFootprintsFromLibrary`, `SetTeardrops`, `AutoplaceFootprints`.
Push-and-shove routing headless (`PNS::ROUTER` without a view) is the hardest item;
plan it as its own spike after everything else, with `RouteTrack{start, end, net,
layer, width}` as the API.

### G10 · Undo / redo
Undo stacks live on frames. Add an `UNDO_REDO_CONTAINER` to the headless contexts
and `Undo`, `Redo`, `GetUndoStack`. Until then the client keeps history (see 01).

### G11 · Settings the UI needs to render like KiCad
`ListColorThemes`, `GetColorTheme{name}`, `GetAppSettings{app}` (grid, units,
defaults), `SetGraphicsDefaults`. Read-only first.

### G12 · 3D and raytrace render headless
`RunBoardJobExportRender` needs a GL context and will fail on a server. Decision: do
3D in the browser (three.js) from `RunBoardJobExport3D` GLB output; leave the
raytrace job for machines with a GPU. No KiCad change.

### G14 · Multi-document / multi-project
Not needed while the bridge runs one server per project. Revisit if the process
model becomes a problem.

### G15 · Transport
Let `--socket` accept a full nng URL (`ws://`, `tcp://`, `ipc://`) in
`KICAD_API_SERVER::Start` and `command_api_server.cpp`. Enables browser-direct
WebSocket with nng's built-in `ws` transport. Also add a `--token` option so the
`kicad_token` is known before connecting.

### G17 · Job ergonomics
Jobs block the socket until finished and return only a status. Add
`RunJob*.async=true → job id`, `GetJobStatus`, progress via G1, and let outputs be
returned inline (`bytes`) for small files (SVG, netlist, BOM) so the bridge does not
need filesystem access to the server's output directory.

### G18 · Request latency in `kicad-cli api-server`
**Today:** the server loop is `while(!exit){ ProcessPendingEvents(); wxMilliSleep(10); }`,
so every request waits up to 10 ms before dispatch (measured ~11 ms for `Ping`).
**Fix:** wake the loop from `KICAD_API_SERVER::onApiRequest` with a condition variable
(or a wx event loop with `wxEventLoop::Run` plus `WakeUp`) and only sleep when idle.

## Things that are GUI-only today and that we deliberately do NOT fix

Selection (`Get/Add/Remove/ClearSelection`, `SaveSelectionToString`,
`SyncSelection`, `HighlightNets`), `Get/SetActiveLayer`, `Get/SetVisibleLayers`,
`Get/SetBoardEditorAppearanceSettings`, `InteractiveMoveItems`, `RevertDocument` in
headless. In a web UI this state belongs to the page. We only add
`SaveItemsToString{ids}` (selection-independent clipboard export) as part of G6.

## Order of work

| Order | Gap | Why first |
|---|---|---|
| 1 | G13, G6 | trivial, unblocks client feature flags |
| 2 | G1 | every panel depends on change notification |
| 3 | G5 | you cannot demo without "New project" |
| 4 | G4 | DRC/ERC panel is the first thing a user checks |
| 5 | G3 | unlocks dozens of existing tool actions at once |
| 6 | G16, G17, G18 | needed before real-size boards, long exports, and chatty UIs |
| 7 | G7, G8 | schematic capture becomes possible end-to-end |
| 8 | G9, G10, G11 | board editing parity |
| 9 | G15 | drop the bridge from the hot path |
| 10 | PNS routing spike | research item |
