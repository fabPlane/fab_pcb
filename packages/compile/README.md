# @fp-pcb/compile

Turns a **design source** into a **KiCad project**.

```
source --[Frontend]--> Netlist --> generated schematic --> ERC --> KiCad board --> parity
```

The split is the point. The left half changes with whatever authoring format you want. In the
bridge workflow, the right half creates and reloads the schematic, requires zero ERC errors, and
uses KiCad's `SyncSchematicToBoard` operation so that saved schematic is the board's electrical
source of truth. Footprint matching, field updates and net assignment remain KiCad's code. The
lower-level apply API retains file-based `ImportNetlist` for callers that do not own a schematic.

## What is here

| file                            | role                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/types.ts`                  | the contract: `Netlist` IR, `Frontend`, `LibrarySpec`, `Diagnostic`, `CompileResult`                                                                                     |
| `src/netlist.ts`                | `emitKicadNetlist` (IR → KiCad `.net`) and `validateNetlist`                                                                                                             |
| `src/apply.ts`                  | `applyNetlist`: write evidence netlist → dry-run board update → outline (+ a blank's vias and holes) → board update → autoplace unspecified additions → source placement |
| `src/rules.ts`                  | `applyBoardRules`: `BoardSpec.rules` → `SetBoardDesignRules` + the `Default` net class (`SetNetClasses`)                                                                 |
| `src/compile.ts`                | orchestration, with the stage and `beforeApply` hooks the job uses                                                                                                       |
| `src/frontends/netlist-json.ts` | the first frontend: `circuit.netlist.json` = `{ netlist, board?, libraries? }`, the IR as a file                                                                         |
| `src/libraries.ts`              | `LibrarySpec` → project `fp-lib-table` / `sym-lib-table` rows (`AddLibraryTableRow`)                                                                                     |
| `src/schematic.ts`              | symbol lookup and owned generated symbols, wires, and labels on the root sheet                                                                                           |
| `src/bridge-job.ts`             | the job the bridge mounts at `/sessions/:id/compile` (see `packages/bridge/README.md`)                                                                                   |

The emitter, validator, frontend, outline geometry and generated-schematic geometry are pure, so the package is
unit-tested without a KiCad server (`bun test`).

## The bridge compile order, and why

The bridge follows KiCad's schematic-first project lifecycle:

1. **Generate, save, and reopen the schematic.** Reopening validates the durable artifact rather
   than only the in-memory construction.
2. **Run ERC.** Any ERC error stops the job before the board update. ERC warnings remain visible
   for explicit review.
3. **Dry-run `SyncSchematicToBoard`.** This checks footprint resolution against the project
   library tables without changing the board.
4. **Reconcile the outline**, then run `SyncSchematicToBoard` for real. The generated `.net` file
   remains an evidence/debugging artifact; it is not the bridge's board authority.
5. **Place footprints** using source positions or the legacy autoplacer and its edge inset.
6. **Run board DRC with schematic comparison enabled.** Any parity conflict fails the compile and
   prevents the final save.
7. **Save the schematic and board** only after those gates pass.

Within the reusable board apply operation, the detailed order is:

1. **Board update with `dryRun`** — the only check that sees the server's `fp-lib-table`.
   This is `ImportNetlist` by default and the open schematic's `SyncSchematicToBoard` in the
   bridge. An error here stops the compile with the board untouched.
2. **Outline reconciliation.** `AutoplaceFootprints` answers
   `APR_NO_BOARD_OUTLINE` without one; the outline _is_ the placement box. A prefabricated
   blank's features go into the same commit: `BoardSpec.vias` as through vias on no net (free
   vias, which the router's `laser-prefab` preset routes through and claims) and `BoardSpec.holes`
   as circles on `Edge.Cuts` (a mounting hole is a cutout to DRC). Such an outline is the blank's
   and step 5 never moves it; `prefab_placement` warns that the autoplacer may have put parts on
   the vias. Compiler-created boundary segments are marked and replaced when source dimensions
   change while independent manual cutout contours are preserved. A matching user outline is
   accepted; a differing user-authored outer contour fails with `outline_conflict` instead of
   silently retaining stale geometry.
3. **Board update for real.** Headless KiCad spreads new footprints from the origin, inside the
   rectangle step 2 drew.
4. **`AutoplaceFootprints` on the footprints step 3 added**, with `includeOffboard` — an empty
   id list means "offboard only" to KiCad, which would skip everything the spread put inside.
5. **The edge-clearance inset for autoplaced additions.** The legacy autoplacer packs into the outline's top-left corner
   and ignores the copper-to-edge rule, so a fresh compile failed DRC every time. With
   `edgeMarginNm` (the job passes `edgeClearanceNm(board)`), the outline step 2 drew is moved so
   its corner sits that far outside the placed group — one `UpdateItems` commit on four segments.
   A user-drawn outline is left alone and `edge_clearance_unchecked` is emitted instead.
6. **Explicit source placement.** Each `board.placements` entry moves its named footprint with
   `Footprint.translate`, including the pads, fields, text, and graphics KiCad serializes at
   absolute board coordinates. Positions are in millimetres in the same fixed frame as the
   outline, prefab vias, and holes, so placing parts never moves or distorts a prefab blank.

The optional JSON shape is:

```json
{
  "board": {
    "widthMm": 30,
    "heightMm": 20,
    "placements": [
      { "ref": "R1", "position": { "x": 10, "y": 8 } },
      { "ref": "U1", "position": { "x": 20.5, "y": 12 } }
    ]
  }
}
```

Only references explicitly present in `placements` are moved on rebuild. Existing components
without an entry retain their manual KiCad placement; newly imported components without an entry
still use the legacy autoplacer when `autoplace` is enabled. With no `placements` property, build
behaviour is unchanged. Non-finite/missing coordinates, duplicate entries, and references absent
from `netlist.components` are validation errors before the board is touched.

`BoardSpec.rules` (mm) is applied by the job before the apply, through `applyBoardRules`: the
board's minimum constraints (`SetBoardDesignRules`, merged field by field) and the `Default` net
class (`SetNetClasses` in merge mode, keeping the fields the spec leaves out). The net class is
what `@fp-pcb/router` reads track width, clearance and via sizes from.

KiCad's import report has no severity per line (`WX_STRING_REPORTER` drops it), so results are
graded by the response's `errorCount` / `warningCount`; the text rides along as detail.

A compile creates separate undo entries for the operations it actually performs: outline,
KiCad's "Update Netlist", autoplace, edge inset, and explicit source placement. The library never
saves the document; the job saves both the board and schematic.

## Generated schematic

A component names its KiCad symbol independently of its footprint:

```json
{
  "ref": "R1",
  "value": "10k",
  "footprint": "Resistor_SMD:R_0402_1005Metric",
  "libSource": { "lib": "Device", "part": "R", "description": "optional override" }
}
```

Before updating the board, the bridge embeds each `lib:part` definition in a searchable schematic
symbol and draws a short wire plus a same-name global label at every connected pin. Equal labels
create real KiCad connectivity without routing long generated wires through other symbols, while
global labels preserve the exact board net name instead of adding a root-sheet `/` prefix.
Generated items carry `fp-pcb.generated=circuit.netlist.json`; rebuild replaces only those items,
preserving anything a person added or explicitly adopted in KiCad.

Placements stay on KiCad's default 50 mil electrical grid. Library pin geometry is converted from
symbol-local coordinates to the sheet-coordinate form required by KiCad's placed-symbol API, and
library pin ids are cleared so KiCad assigns independent instance ids. The bridge saves and
reopens the generated schematic, then runs ERC. The real-server test also checks that the resulting
board has zero schematic parity conflicts.

Missing `libSource`, an unavailable symbol, or a connected pin absent from its symbol produces a
`schematic` error. Once the schematic drives `SyncSchematicToBoard`, allowing one of those omissions
would silently remove electrical intent before ERC or parity could inspect it. ERC then decides
whether the represented design may proceed; schematic parity decides whether it may be saved.
Project and bundled symbol libraries are registered before lookup.

## The job

`createCompileJobs()` returns what the bridge mounts: `POST /sessions/:id/compile` takes a
`CompileSource` inline (no file staging), creates the project at `project.path` when the session
was started bare, registers source and bundled libraries in the project tables, runs `compile()`
with the stages above as job states, saves only after ERC and parity pass, and reports the board
`revision` as a compatibility fallback for older fork builds. Current fork builds also publish
`DocumentChanged` for the real board update. `done` carries `result` whether or not it is `ok`;
`error` is an infrastructure failure. `DELETE` cancels between stages.

## Tests

`bun test` runs the unit suites (no server). `test/apply.kicad.test.ts` and
`packages/bridge/test/compile.kicad.test.ts` run against a fork `kicad-cli api-server` and its
`qa/data/libraries` (`KICAD_CLI` / `KICAD_SRC`), skipping with a message when either is missing.
`bun run experiment` is the exploratory version with timings and verbatim reports; its findings
are in fabdesk's `docs/fab-pcb-migration.md` §6.1.

## Deliberate limitations

- **`libparts` is not emitted.** `BOARD_NETLIST_UPDATER` does not read it, so `ImportNetlist` is
  happy — but the output is not a drop-in for an eeschema netlist in tools that want library
  detail.
- The generated schematic uses a deterministic grid and labelled pin stubs, not a human-style
  functional block layout. Manual items survive rebuilds, but generated symbol positions do not.
- **Only the near edges are inset**, and only for autoplaced additions when this compile drew the
  outline. A board so full that the far edges bind needs explicit placement.

## Notes for callers

- `netlistPath` is where the caller writes; `serverNetlistPath` (default: the same) is what the
  server reads, absolute or project-relative. They differ only when the server is elsewhere.
- Defaults are compile defaults, not "update PCB from schematic" defaults: `updateFootprints` and
  `deleteExtraFootprints` are **on**, because the source is the truth. `matchMode` is `reference`
  — a compiled design has no schematic UUIDs.
- `NewProject` wants the `.kicad_pro` path (an extension-less path becomes a directory to
  create), and `currentBoard()` is empty afterwards — open the board explicitly.
- A frontend, validation, schematic-generation, or ERC failure does not update the board. A parity
  failure necessarily occurs after an in-memory board update, but the job does not save that board.
