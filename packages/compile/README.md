# @fp-pcb/compile

Turns a **design source** into a **KiCad project**.

```
source --[Frontend]--> Netlist --[emit + apply]--> KiCad board
```

The split is the point. The left half changes with whatever authoring format you want; the right
half is stable, because it ends in `ImportNetlist` — the same path eeschema uses to push a
schematic to a board. Footprint matching, field updates and net assignment are KiCad's code.

## What is here

| file                            | role                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/types.ts`                  | the contract: `Netlist` IR, `Frontend`, `LibrarySpec`, `Diagnostic`, `CompileResult`        |
| `src/netlist.ts`                | `emitKicadNetlist` (IR → KiCad `.net`) and `validateNetlist`                                |
| `src/apply.ts`                  | `applyNetlist`: write → `ImportNetlist` (dry run) → outline → `ImportNetlist` → `Autoplace` |
| `src/compile.ts`                | orchestration                                                                               |
| `src/frontends/netlist-json.ts` | the first frontend: `circuit.netlist.json` = `{ netlist, board? }`, the IR as a file        |

The emitter, the validator, the frontend and the outline geometry are pure, so the package is
unit-tested without a KiCad server (`bun test`).

## The apply order, and why

Each step was checked against the fork at `280274cc3d`:

1. **`ImportNetlist` with `dryRun`** — the only check that sees the server's `fp-lib-table`.
   An error here stops the compile with the board untouched.
2. **Outline commit**, when the board has none. `AutoplaceFootprints` answers
   `APR_NO_BOARD_OUTLINE` without one; the outline _is_ the placement box.
3. **`ImportNetlist` for real.** Headless KiCad spreads new footprints from the origin, inside
   the rectangle step 2 drew.
4. **`AutoplaceFootprints` on the footprints step 3 added**, with `includeOffboard` — an empty
   id list means "offboard only" to KiCad, which would skip everything the spread put inside.

KiCad's import report has no severity per line (`WX_STRING_REPORTER` drops it), so results are
graded by the response's `errorCount` / `warningCount`; the text rides along as detail.

A compile is **three undo entries** (outline, KiCad's "Update Netlist", autoplace). The library
never saves the document; that is a job's decision.

## What is not here yet

- **No bridge job.** `POST /sessions/:id/compile` follows the router's `bridge-job.ts` pattern
  and lands with the integration test, not before.
- **`LibrarySpec` is declared, not consumed.** Headless servers ship no footprint libraries;
  registering a frontend's project-local `.pretty` in the project `fp-lib-table` before the dry
  run is the next `apply.ts` step.
- **`libparts` is not emitted.** `BOARD_NETLIST_UPDATER` does not read it, so `ImportNetlist` is
  happy — but the output is not a drop-in for an eeschema netlist in tools that want library
  detail.
- **Board-only.** Nothing creates a schematic. A netlist carries no geometry, so a design compiled
  this way has no drawn schematic, hence no ERC and no BOM-from-schematic.
- **`bench/experiment.ts` is the seed of the integration test.** `bun run experiment` drives every
  step against a fork `kicad-cli api-server` with timings, the library-provisioning matrix, the
  package path, and a stock-`kicad-cli` compatibility check. Results: fabdesk `docs/fab-pcb-migration.md` §6.1.
- **No integration test.** The format expectations are pinned literally but have not been
  round-tripped through a live `kicad-cli api-server`. That is `apply.kicad.test.ts`, gated on
  the fork build (`KICAD_CLI`), and it must land before anything depends on this.
- **`ImportNetlist` does not publish `DocumentChanged`** on the fork today (it only bumps the
  revision), so a browser tab on the same session will not see imported footprints until the
  job reports its revision or the fork is patched.

## Notes for callers

- `netlistPath` is where the caller writes; `serverNetlistPath` (default: the same) is what the
  server reads, absolute or project-relative. They differ only when the server is elsewhere.
- Defaults are compile defaults, not "update PCB from schematic" defaults: `updateFootprints` and
  `deleteExtraFootprints` are **on**, because the source is the truth. `matchMode` is `reference`
  — a compiled design has no schematic UUIDs.
- A compile that fails never touches the board.
