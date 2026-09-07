# Board practice — five real boards through the web UI (M7, docs/06-routing.md)

The five KiCad demo boards under `e2e/fixtures/boards/` (`NOTICE` there for provenance and
licences), each with a generated "placed but unrouted" variant, driven through apps/web against a
headless `kicad-cli api-server` (KiCad 10.99.0-3708-g163dec0e39, later runs 3711-g8cc9377988, fork branch web-api) via the
bridge, in headless Chromium (Playwright, SwiftShader WebGL) at 1440×900, dev build (React
StrictMode on).

```sh
KICAD_CLI=<kicad>/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli \
WORKSPACE_ROOT=<repo>/e2e/fixtures/boards KICAD10_FOOTPRINT_DIR=/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints ... \
  bun run --filter @kicad-web/bridge start                              # 4020
VITE_BRIDGE_URL=http://127.0.0.1:4020 bun run --filter @kicad-web/app dev  # 5173
node apps/web/scripts/prove-kicad.mjs --board ecc83        # one of ecc83 sonde_xilinx interf_u pic_programmer stickhub
KICAD_CLI=... E2E_BASE_URL=http://localhost:5173 bun run --filter @kicad-web/e2e test:real -- boards.spec.ts
```

The driver is `apps/web/scripts/prove-board.mjs` (entered through `prove-kicad.mjs --board`); it
copies the board into `<workspace root>/.kicad-web-practice-<name>/`, so the fixtures are never
written, and leaves the JSON result in `e2e/output/board-practice/<name>.json`. Screenshots:
`docs/screenshots/boards/<name>-{board,layers,selected,sheet-N,edited,moving,moved,unrouted,route-preview,routed,zones,drc,jobs,reopened}.png`.

## Fixtures

| board | project | footprints | pads | tracks / arcs / vias | zones | sheets | unrouted variant removed |
|---|---|---:|---:|---:|---:|---:|---|
| `ecc83` | `ecc83-pp` (+ `ecc83-pp_v2`) | 15 | 33 | 59 / 0 / 0 | 1 | 1 | 59 segments, 1 zone fill |
| `sonde_xilinx` | `sonde xilinx` (space kept in the file names) | 25 | 108 | 208 / 0 / 3 | 1 | 1 | 208 segments, 3 vias, 7 fill polygons |
| `interf_u` | `interf_u` | 25 | 379 | 731 / 0 / 84 | 1 | 1 | 731 segments, 84 vias, 23 fill polygons |
| `pic_programmer` | `pic_programmer` | 63 | 247 | 370 / 0 / 6 | 1 | 2 | 370 segments, 6 vias, 3 fill polygons |
| `stickhub` | `StickHub` | 94 | 278 | 1113 / 180 / 87 | 5 | 1 | 1113 segments, 180 arcs, 87 vias, 11 fill polygons |

Counts are `GetItemCounts` on the original and on `<name>.unrouted.kicad_pcb` (both open through
`OpenDocument`; the variant keeps footprints, pads, zone outlines and settings, graphics and
texts). `strip-routes.ts` is byte-deterministic (`--check`), and `strip-routes.test.ts` pins the
checked-in variants to their boards. stickhub is 2-layer (docs/06-routing.md says 4; the table
there was approximate).

## Results

Every step below went through the real UI (canvas clicks, keyboard, panels, prompts), read back
through the app's debug hook (`__kicadWeb`) and, for save/export, on disk. `route` runs on the
unrouted variant: the first click on a pad picks up the net, `V` places a via and switches layer
(runs shorter than 4 mm are routed straight), `Enter` commits one transaction per net.

| board | step | result | notes |
|---|---|---|---|
| ecc83 | open | pass | 15 footprints / 33 pads / 59 tracks / 1 zone; canvas 2.1 s, session open 2.1 s, store items 1.6 s, first content draw 2.0 s |
| ecc83 | view | pass | zoom to fit; layers panel 20 rows (user layer names `top_cu` / `bottom_cu`), B.Cu hidden and shown; hover "Pad · GND · F.Cu"; C1 pad 2 picked → Pad properties |
| ecc83 | schematic | pass | 1 sheet, 26 symbols / 37 lines |
| ecc83 | edit | pass | C1.X 141.60 → 142.60 mm through the properties panel, revision 0 → 1; undo restored it (revision 2) |
| ecc83 | move | pass | M tool dragged C2 by (5, 3) mm, click committed (revision 2 → 3), undo restored it |
| ecc83 | route | pass | Net-(U1B-K), Net-(P4-P1), Net-(P3-P1), Net-(P1-PM), Net-(U1A-G): 2 segments + 1 via each (F.Cu → V → B.Cu into the through-hole pad); unrouted 20 → 15 |
| ecc83 | refill | pass | RefillZones 1.6 s, the B.Cu GND zone filled (1 polygon set) |
| ecc83 | drc | pass | 11 markers in 2.3 s: 9× unconnected_items, 2× silk_edge_clearance |
| ecc83 | undo | pass | three Ctrl+Z (KiCad's own undo stack) removed the last three routes one commit each: tracks 10 → 8 → 6 → 4, vias 5 → 4 → 3 → 2 |
| ecc83 | save | pass | SaveDocument: 4 segments, 2 vias, 1 filled polygon in `ecc83-pp.unrouted.kicad_pcb` |
| ecc83 | export | pass | gerbers 10 files (49 ms), drill 1 file (4 ms) |
| ecc83 | reopen | pass | fresh `kicad-cli` session: 4 tracks / 2 vias persisted; KiCad assigned the nets from connectivity on load |
| ecc83 | drc (original) | pass | `e2e/real/boards.spec.ts`: 2 markers in 1.5 s on the shipped board |
| sonde_xilinx | open | pass | 25 / 108 / 208 tracks / 3 vias; canvas 2.8 s, store items 1.6 s, first content draw 2.1 s (file names with a space work through `?project=`) |
| sonde_xilinx | view | pass | 20 layer rows; hover "Pad · unconnected-(U2B-O-Pad6) · F.Cu"; U2 pad 6 picked |
| sonde_xilinx | schematic | pass | 1 sheet, 48 symbols / 127 lines / 14 labels |
| sonde_xilinx | edit | pass | R14.X +1 mm, revision 0 → 1, undo restored |
| sonde_xilinx | move | pass | R9 by (5, 3) mm, undo restored |
| sonde_xilinx | route | pass | Net-(U2A-O), Net-(U1C-D), Net-(U1D-D) 2 seg / 1 via; /TDI-DIN-D0, /CTRL-D3 3 seg / 2 vias (F.Cu → B.Cu → F.Cu); unrouted 66 → 61 |
| sonde_xilinx | refill | pass | 1.7 s, 1 polygon set |
| sonde_xilinx | drc | pass | 90 markers in 2.6 s: 43 unconnected_items, 20 shorting_items, 4 clearance, 3 drilled_holes_too_close, 1 lib_footprint_mismatch, 19 soldermask_bridge (the shorts / clearances are the blind mid-run vias of the practice routes; the rest is the board as shipped) |
| sonde_xilinx | undo | pass | tracks 12 → 9 → 7 → 4, vias 7 → 5 → 4 → 2 |
| sonde_xilinx | save | pass | 4 segments, 2 vias, 5 fill polygons written |
| sonde_xilinx | export | pass | gerbers 10 files (38 ms), drill 1 (4 ms) |
| sonde_xilinx | reopen | pass | 4 tracks / 2 vias persisted |
| sonde_xilinx | drc (original) | pass | spec: 1 marker in 1.6 s |
| interf_u | open | pass | 25 / 379 / 731 tracks / 84 vias; canvas 2.5 s, store items 1.7 s, first content draw 2.2 s |
| interf_u | view | pass | hover "Pad · F.Cu" (no-net pad); U5 pad 1 picked |
| interf_u | schematic | pass | 1 sheet, 52 symbols / 368 lines / 204 labels |
| interf_u | edit | pass | R5.X +1 mm, revision 0 → 1, undo restored |
| interf_u | move | pass | C6 by (5, 3) mm, undo restored |
| interf_u | route | pass | /MA15, /OE-, /MA10, /MA0, /CS1-: 2 seg / 1 via each; unrouted 200 → 195 |
| interf_u | refill | pass | 1.8 s, 1 polygon set |
| interf_u | drc | pass | 203 markers in 2.3 s: 159 unconnected_items, 6 shorting_items, 5 clearance, 1 starved_thermal, 32 soldermask_bridge |
| interf_u | undo | pass | tracks 10 → 8 → 6 → 4, vias 5 → 4 → 3 → 2 |
| interf_u | save | pass | 4 segments, 2 vias, 26 fill polygons written |
| interf_u | export | pass | gerbers 10 files (96 ms), drill 1 (3 ms) |
| interf_u | reopen | pass | 4 tracks / 2 vias persisted |
| interf_u | drc (original) | pass | spec: 3 markers in 1.8 s |
| pic_programmer | open | pass | 63 / 247 / 370 tracks / 6 vias; canvas 3.1 s, store items 1.7 s, first content draw 2.3 s (the fp-lib-table needs `KICAD10_FOOTPRINT_DIR`) |
| pic_programmer | view | pass | hover "Pad · F.Cu"; P101 pad picked |
| pic_programmer | schematic | pass | 2 sheets: pic_programmer 105 symbols / 139 lines / 10 labels, pic_sockets 19 symbols / 66 lines / 25 labels; 5.5 s for both |
| pic_programmer | edit | pass | C1.X +1 mm; revision 0 → 1, undo restored — but `GetDocumentRevision` read 0, 1, 1, 1, 1 in the 600 ms after the commit had already been reported as 1 (see "For the fork") |
| pic_programmer | move | pass | C2 by (5, 3) mm, undo restored |
| pic_programmer | route | pass | /PC-DATA-IN, Net-(R8-Pad1), Net-(U4-FB+), Net-(Q1-B), Net-(R15-Pad1): 2 seg / 1 via each; unrouted 125 → 120 |
| pic_programmer | refill | pass | 1.7 s, 1 polygon set |
| pic_programmer | drc | pass | 105 markers in 2.4 s: 81 unconnected_items, 4 clearance, 6 shorting_items, 1 drilled_holes_too_close, 13 soldermask_bridge |
| pic_programmer | undo | pass | tracks 10 → 8 → 6 → 4, vias 5 → 4 → 3 → 2 |
| pic_programmer | save | pass | 4 segments, 2 vias, 1 fill polygon written |
| pic_programmer | export | pass | gerbers 10 files (69 ms), drill 1 (4 ms) |
| pic_programmer | reopen | pass | 4 tracks / 2 vias persisted |
| pic_programmer | drc (original) | pass | spec: 0 markers in 1.7 s — a clean board; the first version of the spec waited for marker rows and timed out on it |
| stickhub | open | pass | 94 / 278 / 1113 tracks / 180 arcs / 87 vias / 5 zones; see timings below |
| stickhub | view | pass | hover "Pad · F.Cu"; H1 (mounting hole) picked as a pad |
| stickhub | schematic | pass | 1 sheet, 140 symbols / 474 lines / 26 labels; 3.6 s |
| stickhub | edit | pass | D4.X +1 mm, revision 0 → 1, undo restored (first run read the revision as 0 right after the commit, same as pic_programmer) |
| stickhub | move | pass | J7 by (5, 3) mm, undo restored |
| stickhub | route | pass | routed from B.Cu (the hub is assembled on the back): /D+ and /D- 3 seg / 2 vias (B.Cu → V → F.Cu → V → B.Cu), /XO, /XI, Net-(U2-CAP) 2 segments straight (runs under 4 mm); unrouted 226 → 221 |
| stickhub | refill | pass | 1.7 s, 5 zones each 1 polygon set |
| stickhub | drc | pass | 196 markers in 3.0 s: 125 unconnected_items, 11 shorting_items, 5 clearance, 36 lib_footprint_mismatch, 19 soldermask_bridge |
| stickhub | undo | pass | tracks 12 → 10 → 8 → 6, vias 4 → 4 → 4 → 4 (the last three routes had no vias) |
| stickhub | save | pass | 6 segments, 4 vias, 6 fill polygons written to `StickHub.unrouted.kicad_pcb` |
| stickhub | export | pass | gerbers 10 files, drill 1 |
| stickhub | reopen | pass | 6 tracks / 4 vias persisted (/D+ 3, /D- 3) |
| stickhub | drc (original) | pass | spec: 36 markers (all lib_footprint_mismatch) in 1.9 s |

`e2e/real/boards.spec.ts` (Playwright, real server, skipped without `KICAD_CLI`) repeats the
open / counts / pad-pick / DRC / unrouted-variant part for all five boards in ~50 s: 5/5 pass.
The back-side texts render mirrored as KiCad does (sonde_xilinx "Copper layer" under
"Component Side", the mirrored "BAT46" values); the hand routes, ratsnest, dimensions and
DB25 connectors are in `sonde_xilinx-routed.png`.

## Timings (stickhub, the biggest board)

Milliseconds since `page.goto`, dev build with React StrictMode (every canvas mounts twice), the
first open of a project (`POST /sessions` spawns `kicad-cli api-server` and waits for it to load
the project), three runs:

| | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| board canvas in the DOM (= editor shell after the session opened) | 3508 | 2462 | 3485 |
| status bar "open · KiCad" | 3519 | 2471 | 3495 |
| board store holds items (GetItems done) | 2523 | 1670 | 1968 |
| first WebGL draw with content (fallback pad shapes, tracks) | 3387 | 2291 | 2595 |
| server shapes in (GetPadShapeAsPolygon 556 pads×layers + GetTextAsShapes 231 texts) | 3524 | 2473 | 3499 |
| `.unrouted` variant, canvas / store items / first draw | 2643 / 2125 / 2526 | 1766 / 1320 / 1578 | 1737 / 1266 / 1526 |
| RefillZones (5 zones) | 1768 | 1707 | 1737 |
| DRC (RunBoardJobDrc + GetDrcMarkers, 167–196 markers) | 3951 | 2441 | 3028 |

The store is populated before the status bar flips to "open" (items stream in while the layer /
net / setup requests finish), and the first content paint lands ~0.5–0.8 s later. Of the ~2.5 s
to a usable board, ~1.6 s is `kicad-cli` starting and loading the project — the same on the
14-footprint ecc83 (store items 1.6 s) as on stickhub (1.7–2.5 s). Pad polygon and text shape
requests now run once per store (below); before the fix they ran twice on every open (StrictMode)
and again on every return to the board tab.

## Bugs found and fixed

All in this repo, each with a unit test; nothing under the KiCad tree was touched.

1. **No pads, silk or courtyards were drawn on any real board** (renderer). The API serialises a
   footprint's `definition.items` as `google.protobuf.Any`; the board adapter could not read Any
   (`itemTypeOf` returned undefined), and `BoardCanvasHost.toRenderItems` skipped the store's own
   pad / footprint-text items whenever the definition was non-empty — so footprints rendered as a
   reference, an anchor and an invisible body (see the first `ecc83-failure.png`: the "pads" were
   zone cut-outs). Fix: `BoardAdapterContext.decodeAny` (wired to `unpackAny` in
   `apps/web/src/services/kicad/KicadCanvas.ts`) decodes definition children;
   `BoardAdapterContext.storeChild` and a parent index in `BoardCanvasHost` render a child the store
   holds from the store item (board net, absolute position, owned by the footprint for selection and
   picking, footprint body bbox still spans it) and skip the definition copy; children the store does
   not hold (silk, courtyard, library previews) come from the decoded definition. Selecting a
   footprint selects the pads the store draws for it; a footprint whose children join or leave the
   store is rebuilt. `Scene.removeOwner` only forgets ids an entry still owns (a child's id moves
   between the footprint entry and its own). Files: `packages/renderer/src/board/boardAdapter.ts`,
   `packages/renderer/src/board/BoardCanvasHost.ts`, `packages/renderer/src/core/scene.ts`,
   `apps/web/src/services/kicad/KicadCanvas.ts`. Tests: `packages/renderer/test/boardHost.test.ts`.
2. **A `*.Cu` through-hole pad emitted a render item for every inner layer KiCad knows** (In1..In30)
   on a 2-layer board — 30 dead polygons per pad (interf_u: 379 pads). `convertPad` now keeps only the
   board's copper layers (`packages/renderer/src/board/boardAdapter.ts`; test in `boardHost.test.ts`).
3. **Hover callbacks only fired when the hovered item changed** (`BaseCanvasHost.updateHover`), so the
   status-bar cursor froze while moving inside one item and the M (move) tool lagged one pointer
   event behind — the first ecc83 run placed C2 at (+3, +2) mm after the pointer had gone to (+5, +3).
   Callbacks now fire on every (rAF-coalesced) move; the overlay still updates only on a change.
   `packages/renderer/src/core/host.ts`; test `boardHost.test.ts` ("hover").
4. **Pick order ignored the active layer**: at a through-hole pad's centre a footprint fab-layer line
   (tiny bbox) or the B.Cu track ending in the pad won the nearest-then-smallest sort, so hovering /
   clicking a pad on sonde_xilinx and pic_programmer reported "Footprint" and the route tool's first
   click picked up no net (ecc83 Net-(U1B-K), first run). `BaseCanvasHost.pick` now applies KiCad's
   last `GuessSelectionCandidates` rule — among the exact hits, items on the active layer first — and
   the route/via tools take the first hit that carries a net (`apps/web/src/canvas/CanvasSlot.tsx`).
   `packages/renderer/src/core/host.ts`, `BoardCanvasHost.ts`; test `boardHost.test.ts` ("pick").
5. **Every canvas mount re-fetched all pad polygons and text shapes** — twice per open under
   StrictMode, and again on every switch back to the board tab (4 `GetPadShapeAsPolygon` rounds
   logged on ecc83 after one visit to the schematic). The caches now belong to the store
   (`boardCachesFor`, a `WeakMap<ItemStore, …>`), mark keys as in flight so a concurrent mount asks
   for nothing, forget failed keys, and deliver results to whichever host shows the store now
   (`onReady` re-targeted per host). Rounds are down to 2 (one per open; the second is the
   `DocumentChanged` resync after opening — see below). `apps/web/src/services/kicad/KicadCanvas.ts`;
   test `apps/web/test/kicad-canvas.test.ts`.

6. **Custom-shape pads took their whole footprint out of the scene.** A `PSS_CUSTOM` pad stack
   (pic_programmer's `SolderJumper-2 … TrianglePad`, stickhub's `JP-2_1.5x1.5`) carries its custom
   polygons with bigint coordinates; `padPrims` built its geometry cache key with `JSON.stringify`,
   which throws on bigint, and `safeConvert` dropped the item — for a definition child that is the
   entire footprint (no silk, no pads), for the store pad the pad. Found by `e2e/real/boards.spec.ts`
   ("every pad is drawn": 245/247 on pic_programmer, 276/278 on stickhub). Cache keys now use a
   bigint-safe stringify. `packages/renderer/src/board/boardAdapter.ts`; test in
   `packages/renderer/test/adapter.test.ts` ("custom-shape pad").

Not bugs, recorded: `?project=` with a space in the file name (`sonde xilinx.kicad_pro`) works
end to end; the layers panel shows KiCad's user layer names (`top_cu`); the `fp-lib-table` entries
pointing at `${KICAD10_FOOTPRINT_DIR}` (pic_programmer) need that variable on the bridge;
DRC's `lib_footprint_mismatch` (stickhub ×36, sonde ×1) and `soldermask_bridge` are the boards as
shipped; the browser logs a `404` for `GET /files/stat?path=<name>.unrouted.kicad_sch` when the
app probes for a schematic next to the `.unrouted.kicad_pro` — harmless (the project has none),
but noisy in the console.

## Still open (app side)

- A store resync after the first open (`DocumentChanged` from KiCad right after the project loads)
  marks every item updated, which invalidates and re-fetches every pad polygon once more (the
  second of the two rounds above). The cache could compare pad geometry hashes before refetching.
- Clicking a pad where a track ends selects the track (smaller coverage area), which matches
  KiCad's own heuristic short of its disambiguation menu; there is no menu yet.

## For the fork (KiCad side)

- **`GetDocumentRevision` read backwards right after a commit.** pic_programmer, session on
  `pic_programmer.kicad_pro`: `BeginCommit` → `UpdateItems` (one `FootprintInstance`, position X
  +1 mm) → `EndCommit(CMA_COMMIT)`; the client polled `GetDocumentRevision { document: <the
  board> }` and got `revision: 1`, then the next five reads within 600 ms answered `0, 1, 1, 1, 1`.
  Same on stickhub (D4) in one of three runs. No error text — the values are simply not monotonic
  for a moment after `EndCommit`. The app's dirty flag and the tests tolerate it (they wait for
  `> previous`), but anything diffing on the revision would resync twice.
- `FootprintInstance.definition.items` come as `Any` (fine — now decoded client-side) but a
  `*.Cu` pad's `PadStack.layers` lists all 30 inner copper layers regardless of the board's stackup;
  clients must intersect with `GetBoardEnabledLayers`.
- Not hit this time (unchanged from the kitchen-sink proof): `RunBoardJobDrc` stopping after the
  async export jobs, schematic `SaveDocument` not creating files for new sheets.
