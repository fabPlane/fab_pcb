# @fp-pcb/compile

Turns a **design source** into a **KiCad project**.

```
source --[Frontend]--> Netlist --[emit + apply]--> KiCad board + generated schematic
```

The split is the point. The left half changes with whatever authoring format you want; the right
half is stable, because it ends in `ImportNetlist` — the same path eeschema uses to push a
schematic to a board. Footprint matching, field updates and net assignment are KiCad's code.

## What is here

| file                            | role                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/types.ts`                  | the contract: `Netlist` IR, `Frontend`, `LibrarySpec`, `Diagnostic`, `CompileResult`             |
| `src/netlist.ts`                | `emitKicadNetlist` (IR → KiCad `.net`) and `validateNetlist`                                     |
| `src/apply.ts`                  | `applyNetlist`: write → dry-run `ImportNetlist` → outline (+ a blank's vias and holes) → `ImportNetlist` → autoplace unspecified additions → source placement |
| `src/rules.ts`                  | `applyBoardRules`: `BoardSpec.rules` → `SetBoardDesignRules` + the `Default` net class (`SetNetClasses`) |
| `src/compile.ts`                | orchestration, with the stage and `beforeApply` hooks the job uses                               |
| `src/frontends/netlist-json.ts` | the first frontend: `circuit.netlist.json` = `{ netlist, board?, libraries? }`, the IR as a file |
| `src/libraries.ts`              | `LibrarySpec` → project `fp-lib-table` / `sym-lib-table` rows (`AddLibraryTableRow`)             |
| `src/schematic.ts`              | symbol lookup and owned generated symbols, wires, and labels on the root sheet                  |
| `src/bridge-job.ts`             | the job the bridge mounts at `/sessions/:id/compile` (see `packages/bridge/README.md`)           |

The emitter, validator, frontend, outline geometry and generated-schematic geometry are pure, so the package is
unit-tested without a KiCad server (`bun test`).

## The apply order, and why

Each step was checked against the fork at `280274cc3d` and run live (`bench/experiment.ts`):

1. **`ImportNetlist` with `dryRun`** — the only check that sees the server's `fp-lib-table`.
   An error here stops the compile with the board untouched.
2. **Outline commit**, when the board has none. `AutoplaceFootprints` answers
   `APR_NO_BOARD_OUTLINE` without one; the outline _is_ the placement box. A prefabricated
   blank's features go into the same commit: `BoardSpec.vias` as through vias on no net (free
   vias, which the router's `laser-prefab` preset routes through and claims) and `BoardSpec.holes`
   as circles on `Edge.Cuts` (a mounting hole is a cutout to DRC). Such an outline is the blank's
   and step 5 never moves it; `prefab_placement` warns that the autoplacer may have put parts on
   the vias. A board that already has an outline keeps it, blank included (`blank_not_drawn` says
   so when the spec has vias but the board has none).
3. **`ImportNetlist` for real.** Headless KiCad spreads new footprints from the origin, inside
   the rectangle step 2 drew.
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

After a successful `ImportNetlist`, the bridge embeds each `lib:part` definition in a searchable
schematic symbol and draws a short wire plus a same-name local label at every connected pin. Equal
labels create real KiCad connectivity without routing long generated wires through other symbols.
Generated items carry `fp-pcb.generated=circuit.netlist.json`; rebuild replaces only those items,
preserving anything a person added or explicitly adopted in KiCad.

Missing `libSource`, an unavailable symbol, or a pin absent from its symbol produces a `schematic`
warning while leaving the successful board compile intact. This preserves old netlists, but ERC and
schematic rendering are complete only when every component supplies a valid symbol. Project and
bundled symbol libraries are registered before lookup.

## The job

`createCompileJobs()` returns what the bridge mounts: `POST /sessions/:id/compile` takes a
`CompileSource` inline (no file staging), creates the project at `project.path` when the session
was started bare, registers source and bundled libraries in the project tables, runs `compile()`
with the stages above as job states, saves, and reports the board `revision` as a compatibility
fallback for older fork builds. Current fork builds also publish `DocumentChanged` for the real
`ImportNetlist`. `done` carries `result` whether or not it is `ok`; `error` is an infrastructure
failure. `DELETE` cancels between stages.

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
- A compile that fails never touches the board.
