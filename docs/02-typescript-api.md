# 02 — The TypeScript API around the KiCad IPC layer

Goal: a typed client that covers 100% of what the server can do, works in the
browser and in Bun, and mirrors the ergonomics of the official Python client
(`kicad-python`, package `kipy`) so that examples and mental models transfer.

## Layer 0 — `@fp-pcb/proto` (generated)

- Generator: **protobuf-es** (`@bufbuild/protobuf` v2) via `buf generate`, pointed at
  `../kicad/api/proto`. Reasons: ES modules, tree-shakeable, first-class
  `google.protobuf.Any` with a type registry, works in browser + Bun, no `protoc`
  install for consumers.
- `buf.gen.yaml` options: `target=ts`, `import_extension=js`, `json_types=true`.
- int64: KiCad uses `int64 value_nm` everywhere. Keep protobuf-es's `bigint` on the
  wire types; the client layer converts to `number` (a board is < 2^53 nm wide) via
  `nm(x: bigint): number` / `toNm(x: number): bigint`. Never do arithmetic on bigints
  in UI code.
- Type registry: one `createRegistry(...allFiles)` exported as `kiapiRegistry`, used
  to pack/unpack `Any`. The type URL is `type.googleapis.com/kiapi.<pkg>.<Message>`.
- The package records `KICAD_COMMIT` (the fork commit the protos came from). CI
  regenerates and fails if `git diff` is non-empty, so schema drift is visible.

## Layer 1 — transport (`@fp-pcb/client/transport`)

```ts
interface Transport {
  send(request: Uint8Array, opts?: { timeoutMs?: number }): Promise<Uint8Array>;
  close(): Promise<void>;
  readonly state: "connecting" | "open" | "closed";
  onStateChange(cb: (s: State) => void): () => void;
}
```

Implementations:

| Transport                 | Runtime     | Notes                                                                                                                    |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NngIpcTransport(path)`   | Bun         | raw SP framing over `net.connect(path)`; REQ0 request id; strictly one request in flight, queued FIFO                    |
| `WebSocketTransport(url)` | browser/Bun | to the bridge; frames are the same bytes, bridge adds a 4-byte correlation id so several tabs can pipeline               |
| `NngWsTransport(url)`     | browser     | after patch G15: dial `ws://` with `Sec-WebSocket-Protocol: rep.sp.nanomsg.org`, prepend the 4-byte request id ourselves |

The transport only moves bytes. Everything protobuf lives above it.

## Layer 2 — `KiCadClient` (envelope + dispatch)

```ts
const kicad = await KiCadClient.connect(transport, { clientName: "fp-pcb/abc" });
const v = await kicad.call(GetVersionSchema, {}, GetVersionResponseSchema);
```

- `call(reqSchema, req, resSchema)` packs `ApiRequest{header, Any(req)}`, sends,
  unpacks `ApiResponse`, maps `ApiStatusCode` to a typed `KiCadApiError`
  (`code`, `message`, `command`). `AS_BUSY` and `AS_NOT_READY` are retried with
  backoff; `AS_TOKEN_MISMATCH` fires `onServerRestarted`.
- Every command gets a generated one-liner wrapper in `commands.ts` from a table
  produced by `tooling/coverage` (request → response pairs are exactly the
  `registerHandler<Req, Res>` pairs). This is what makes "100% coverage" a
  mechanical property rather than a hand-maintained list.
- `capabilities`: until gap G13 (`GetSupportedCommands`) lands, the client carries the
  coverage matrix as data and marks GUI-only commands so the UI can hide them when
  connected to a headless server.

## Layer 3 — object model (what app code actually uses)

Mirrors `kipy`: `KiCad` → `Project` → `Board` | `Schematic` | `FootprintDocument`.

```ts
const kicad = new KiCad(client);
const project = await kicad.openProject("/path/to/foo.kicad_pro"); // OpenDocument(DOCTYPE_PROJECT)
const board = await project.openBoard(); // OpenDocument(DOCTYPE_PCB)

const fps = await board.getFootprints(); // GetItems(types=[KOT_PCB_FOOTPRINT])
const tracks = await board.getItems([KiCadObjectType.KOT_PCB_TRACE, KOT_PCB_ARC, KOT_PCB_VIA]);

await board.commit("Move R1", async (tx) => {
  // BeginCommit … EndCommit
  const r1 = fps.find((f) => f.reference === "R1")!;
  r1.position = { x: nm(10e6), y: nm(20e6) };
  await tx.update([r1]); // UpdateItems, returns canonical
});
```

Modules (one file each, one owner each — see agents):

| Module               | Wraps                                                                                          | Highlights                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kicad.ts`           | base_commands, project_commands                                                                | version, paths, open/close/new project, text variables, netclasses, `kicad.libraries`, `kicad.settings`                                                                                                                                                                                                                                                                                                      |
| `libraries.ts`       | library_commands                                                                               | `tables(type)`, `entries(type, nickname, filter)`, `get`/`save`/`delete` of `LibFootprint` \| `LibSymbol`, `createLibrary`, `addTableRow`/`removeTableRow`, `wizards()`/`runWizard()`. `kicad.libraries.footprints` / `.symbols` / `.designBlocks` bind the type                                                                                                                                             |
| `settings.ts`        | settings_commands (KiCad >= 11.0)                                                              | `kicad.settings.colorThemes()`, `colorTheme(name)` -> `{ name, colors, overrideSchItemColors, layers }` keyed by KiCad's flat theme keys (`board.copper.f`), i.e. the renderer's `Theme`; `appSettings(app)` / `currentGrid(app)` for units, colour theme, grids, zoom factors and the editor's item defaults. No document needed                                                                            |
| `document.ts`        | editor_commands                                                                                | save / saveCopy / revert, page settings, title block, `saveToString`, `parseAndCreate`, `undo`/`redo`/`undoStack` (KiCad >= 11.0)                                                                                                                                                                                                                                                                            |
| `commit.ts`          | BeginCommit/EndCommit + Create/Update/Delete                                                   | `commit(msg, fn)` with automatic `CMA_DROP` on throw; batching of updates into one `UpdateItems`; `undo()` reverts a pushed commit through KiCad's own undo stack                                                                                                                                                                                                                                            |
| `board.ts`           | board_commands                                                                                 | stackup, enabled layers, design rules, custom rules (DRU text), origin, nets, connected items, refill zones, netlist import, plot settings, pad polygon, padstack presence, flip, `ratsnest`/`unroutedCount`/`netLengths`, `updateFootprintsFromLibrary`, `setTeardrops`/`removeTeardrops`, `autoplace`, `globalDeletion`, `graphicsDefaults`/`setGraphicsDefaults` (Board Setup > Text & Graphics Defaults) |
| `board-items.ts`     | board_types                                                                                    | thin classes over the protobuf messages: `Footprint`, `Pad`, `Track`, `Via`, `Zone`, `BoardText`, `Dimension`, `Group`… with getters in `number` nm, and `toProto()`                                                                                                                                                                                                                                         |
| `schematic.ts`       | schematic_commands                                                                             | hierarchy, netlist, items per sheet (`ItemHeader.document.sheet_path`), symbols, wires, labels, sheets, `annotate`/`clearAnnotation`, `syncToBoard` (Update PCB from Schematic), `settings`/`setSettings`, `fieldsTable`/`setFields`, `assignFootprints`, `newSheet`                                                                                                                                         |
| `schematic-items.ts` | schematic_types                                                                                | `SchematicSymbol` (with lib definition children), `SchematicLine`, labels, `SheetSymbol`, fields                                                                                                                                                                                                                                                                                                             |
| `footprint-doc.ts`   | footprint handler                                                                              | open by LIB_ID, edit, save                                                                                                                                                                                                                                                                                                                                                                                   |
| `variants.ts`        | variant_commands                                                                               | list/add/delete/rename/copy/set current                                                                                                                                                                                                                                                                                                                                                                      |
| `jobs.ts`            | board_jobs, schematic_jobs                                                                     | gerbers, drill, position, STEP/GLB, SVG/PDF/DXF, IPC-2581, ODB++, netlist, BOM. Each returns a `JobResult`; `{ async, returnInline }` gives a `Job` handle whose `wait()` polls `GetJobStatus` (and listens to `JobProgress` events) and returns the outputs inline                                                                                                                                          |
| `checks.ts`          | RunBoardJobDrc / GetDrcMarkers / SetDrcMarkerExcluded / Get\|SetDrcSeverities, ERC equivalents | `board.drc.run() / markers() / exclude() / severities()`, `schematic.erc.*`                                                                                                                                                                                                                                                                                                                                  |
| `text.ts`            | GetTextExtents, GetTextAsShapes                                                                | server-side font tessellation for the renderer                                                                                                                                                                                                                                                                                                                                                               |
| `units.ts`           | –                                                                                              | `nm`, `mm`, `mil`, `deg`, `Vector2` helpers, `Box2`                                                                                                                                                                                                                                                                                                                                                          |
| `errors.ts`          | envelope                                                                                       | `KiCadApiError`, status-code enum re-export                                                                                                                                                                                                                                                                                                                                                                  |
| `events.ts`          | common/events.proto                                                                            | `KiCadEvents.on(kind)` typed from the generated oneof, plus `onDocumentChanged` / `onDocumentSaved` / `onJobProgress` / `onProjectChanged(cb, kinds)` shorthands                                                                                                                                                                                                                                             |
| `store/undo.ts`      | Undo/Redo + client patches                                                                     | `DocumentUndo` prefers KiCad's undo stack when the server advertises `Undo`, and falls back to replaying `inversePatch` on the store when it does not                                                                                                                                                                                                                                                        |

Design rules for the object model:

- Wrappers are **plain data + methods**, no hidden network calls in getters.
- Every wrapper keeps the original protobuf message; unknown/new fields survive a
  round trip untouched (forward-compatible with KiCad schema growth).
- `ItemHeader` is filled in by the document handle; app code never builds it.
- Sheet paths for schematics are explicit: `schematic.sheet(path)` returns a handle
  whose `getItems()` sets `document.sheet_path`.

## Layer 4 — `@fp-pcb/client/store` (browser only)

A normalised item store (`Map<KIID, Item>` per document, indexes by type, layer, net)
with an optimistic-mutation commit pipeline and undo (see 01). The renderer
subscribes to store diffs, never to the network.

Undo has two mechanisms and `DocumentUndo` picks between them. When the server
advertises `Undo` (KiCad >= 11.0) it undoes on the KiCad side, which also reverts
what the store never mirrored — zone fills, connectivity, netlist changes, and edits
made outside a commit such as `SetBoardOrigin` — and the store re-syncs from the
document afterwards. Without the capability it replays the inverse patches that
`UndoStack` recorded, which only knows about items that passed through the store.

## Testing

- **Conformance suite** (`packages/client/test/conformance`): runs against a real `kicad-cli api-server` with
  `qa/data/pcbnew/api_kitchen_sink.kicad_pcb` and
  `qa/data/eeschema/api_kitchen_sink.kicad_sch`; one test per command in the
  coverage matrix. A command is "covered" only when its test passes. This is the
  same fixture the KiCad C++ tests use (`qa/tests/api/test_api_e2e.cpp`).
- Unit tests for framing (`NngIpcTransport`) use recorded byte captures.
- Codegen snapshot test guards against silent schema drift.
