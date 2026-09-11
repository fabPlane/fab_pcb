# 06 — Upstreaming the KiCad API patch series

Branch `web-api` in our fork, 32 commits on top of upstream `cbd303d16b` (KiCad 10.99,
the development branch that becomes v11). Totals across the range:

| Area                    |     Added |               Removed |
| ----------------------- | --------: | --------------------: |
| `api/proto/**`          |      1922 | 6 (all comment lines) |
| C++ sources and headers |     13533 |                  1933 |
| `qa/**`                 |     15279 |                     0 |
| **Total**               | **30734** |              **1939** |

Of the 15279 QA lines, **10067 are a stray fixture directory** and **7110 are a stray
generated SVG added and later deleted** — see [What must be fixed before
submission](#5-checklist-before-submission). Real QA content is ~5200 lines across
11 test files.

This document is the submission plan: what the series is, what every commit does,
how to cut it into merge requests KiCad reviewers will accept, what they will
push back on, and the exact commands to produce the branches.

---

## 1. Series overview

### Proposed MR description (for the umbrella / first MR)

> KiCad 10.99 gained `kicad-cli api-server`, a headless host for the protobuf-over-nng
> IPC API. In practice a headless client still cannot drive a design end to end: the
> server has no way to advertise what it serves, no way to tell a client that a document
> changed, no way to create a project or a document, no rule checkers, no library access,
> no undo, and a long export blocks the socket for its whole duration. Several commands
> defined in the protos have no handler at all, and a handler that throws leaves the
> REQ/REP socket unable to receive the next request.
>
> This series closes those gaps. It adds capability discovery (`GetSupportedCommands`),
> a pub/sub events socket beside the request socket (`DocumentChanged` / `Opened` /
> `Closed` / `Saved`, `ProjectChanged`, `JobProgress`, `ServerShutdown`) with a cheap
> `GetDocumentRevision` fallback, project and document creation, a headless symbol
> document to match the existing headless footprint one, DRC and ERC, headless
> `RunAction` with `GetActions`, `GetItems` paging and `since_revision`, asynchronous
> jobs with inline outputs, library table and library item access, the schematic and
> board operations that until now lived only in editor dialogs, undo/redo on the
> headless contexts, read-only settings and colour themes, and nng URL support on
> `--socket` so a browser can reach the server over the WebSocket transport without a
> bridge. It also fixes a set of pre-existing bugs the work uncovered: handler dispatch
> picking the wrong handler for commands two editors serve, an unanswered request
> wedging the socket, an `OpenLibraryItem` crash headless, `UpdateItems` not
> round-tripping several board and schematic item types, `GetTextAsShapes` laying text
> box glyphs out at the origin, and `RunSchematicJobExportBOM` writing an empty file.
>
> Every proto change is additive: new files, new messages, new fields, new enum values
> and comments. No field is removed, renumbered or retyped, so existing clients keep
> working on the wire. New fields carry `// Since 11.0`, following the convention
> already in the protos.

### Motivation

The driver is headless API clients generally, and specifically a browser-based KiCad UI
([01-architecture.md](01-architecture.md)) used as the proving ground: a React/WebGL2
front end talking to `kicad-cli api-server` through a thin Bun bridge (and, after the
transport patch, directly over `ws://`). A web UI is a demanding client because it needs
everything the desktop needs — change notification, incremental reads of a large board,
libraries, DRC results, undo — and it has none of the desktop's escape hatches: it cannot
touch the filesystem the server writes to, cannot poke at a frame, and cannot afford an
11 ms round trip per call. Each gap in this series was found by trying to build a real
panel and failing, and is recorded with its symptom in [04-ipc-gaps.md](04-ipc-gaps.md).

### Conformance evidence

Every command is exercised by a client conformance suite run against a live
`kicad-cli api-server` — one test per command in the generated command table, on a
unique socket with the kitchen-sink board and schematic copied into a temp project. The
current run:

```
=== IPC conformance (KiCad 477c6922bb) ===
165 commands: 150 pass, 15 skip (gui-only), 0 fail; headless 150/150 green;
6 extra checks: 6 pass, 0 skip, 0 fail; 2 with KICAD-BUG notes
```

The 15 skips are the GUI-only commands (selection, visible layers, appearance,
`RevertDocument`, interactive tools); the suite asserts they answer `AS_UNIMPLEMENTED`
or `AS_UNHANDLED` cleanly rather than crashing or hanging. The suite fails the run if
any command in the table has no test, catches server crashes, restarts the server and
reports the incident instead of taking down the rest of the run. It lives in
`packages/client/test/conformance/` in the FabPlane PCB repo and is not part of what we
propose to upstream — the C++ QA tests in `qa/tests/api/` are.

---

## 2. Every commit

Ordered as they sit on the branch (oldest first). "Proto" says whether
`api/proto/**` changes and whether the change is purely additive.

|   # | Hash         | Subject                                                                                           | Gap closed                                    | Files touched (areas)                                                                                                                                                                                                                                                                               | Proto                                                                           | QA test                                                                                                            |
| --: | ------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
|   1 | `ef0ed71606` | API: Add GetSupportedCommands for capability discovery                                            | G13                                           | `api/proto/common/commands/base_commands.proto`, `common/api/api_handler.cpp`, `common/api/api_server.cpp`, `include/api/api_handler.h`, `include/api/api_server.h`, board/fp/pcb/sch handlers (11 files)                                                                                           | additive (new messages + `HANDLER_MODE` metadata)                               | yes — `qa/tests/api/test_api_server.cpp` (new, +195)                                                               |
|   2 | `8b63c6b83e` | API: Register UpdateBoardStackup, SaveItemsToString, and headless no-ops                          | G6                                            | `editor_commands.proto`, `cross_probe_commands.proto`, `common/api/api_handler_editor.cpp`, `pcbnew/api/*`, `pcbnew/board_stackup_manager/board_stackup.cpp` (10 files)                                                                                                                             | additive (`SaveItemsToString`)                                                  | yes — `test_api_handler_pcb.cpp` (+337)                                                                            |
|   3 | `72b2d2afe3` | kicad-cli: Wake the api-server loop on request instead of polling                                 | G18                                           | `common/api/api_server.cpp`, `include/api/api_server.h`, `kicad/cli/command_api_server.cpp`                                                                                                                                                                                                         | none                                                                            | yes — `test_api_e2e.cpp`, `test_api_server.cpp`                                                                    |
|   4 | `3c7ce604bf` | API: Add GetDocumentRevision for cheap change polling                                             | G1 (interim)                                  | `editor_commands.proto`, `common/api/api_handler_editor.cpp`, sch/fp/pcb handlers                                                                                                                                                                                                                   | additive                                                                        | yes — `test_api_handler_pcb.cpp` (+73)                                                                             |
|   5 | `e8cd61a2f2` | API: Publish document events on a pub/sub socket                                                  | G1                                            | new `api/proto/common/events.proto`, `libs/kinng` (`KINNG_PUBLISHER`), `api_server.*`, `api_handler_editor.*`, `common/commit.cpp`, `include/commit.h`, `eeschema/files-io.cpp`, `pcbnew/files.cpp`, `command_api_server.cpp` (26 files)                                                            | additive (new file + `GetServerInfo` fields)                                    | yes — `test_api_events.cpp` (new, +337), `qa/tests/libs/kinng/test_kinng.cpp` (new, +111)                          |
|   6 | `e118ed3f81` | API: Add NewProject, NewDocument, GetProjectInfo and headless symbol documents                    | G5                                            | `project_commands.proto`, `common/api/api_handler_common.cpp`, new `eeschema/api/api_handler_symbol.*`, new `eeschema/api/headless_symbol_context.*`, `eeschema/eeschema.cpp`, `kicad/cli/command_api_server.cpp` (+396) (16 files)                                                                 | additive                                                                        | yes — `qa/tests/eeschema/test_sch_api_symbol_handler.cpp` (new, +334)                                              |
|   7 | `1ca7f148a5` | API: Add DRC and ERC commands                                                                     | G4                                            | `board_commands.proto`, `board_rules.proto`, `schematic_commands.proto`, `schematic_rules.proto`, `api_handler_pcb.cpp` (+403), `api_handler_sch.cpp` (+293)                                                                                                                                        | additive                                                                        | yes — `test_api_handler_pcb.cpp`, `test_sch_api_handler.cpp`                                                       |
|   8 | `9761ac77a8` | API: Dispatch requests to handlers in registration order                                          | pre-existing bug                              | `common/api/api_server.cpp`, `api_handler_editor.*`, `api_handler_sch.*`, `api_handler_pcb.*`, `include/api/api_server.h`                                                                                                                                                                           | none                                                                            | yes — `test_api_server.cpp`, `test_sch_api_handler.cpp`                                                            |
|   9 | `d5ffe03e2a` | API: Answer GetOpenDocuments with an empty list when no editor is open                            | pre-existing wart                             | `common/api/api_server.cpp`, `include/api/api_server.h`                                                                                                                                                                                                                                             | none                                                                            | yes — `test_api_server.cpp` (+38)                                                                                  |
|  10 | `5d02b01fd3` | API: Fix OpenLibraryItem crash and board closure in headless footprint documents                  | pre-existing crash                            | `include/kiway.h`, `common/kiway.cpp`, `eeschema/eeschema.cpp`, `pcbnew/pcbnew.cpp`, `pcbnew/api/footprint_context.*`, `headless_footprint_context.*`, `command_api_server.cpp`                                                                                                                     | none (C++ enum gains `PROJECT_KIND`)                                            | yes — `test_api_e2e.cpp` (+83)                                                                                     |
|  11 | `a00cce1ac3` | API: Report handler exceptions instead of wedging the request socket                              | pre-existing wedge                            | `common/api/api_server.cpp`, `eeschema/netlist_exporters/netlist_exporter_base.cpp`                                                                                                                                                                                                                 | none                                                                            | yes — `test_api_server.cpp` (+43)                                                                                  |
|  12 | `3571e8b6c8` | API: Make unchanged UpdateItems round-trip board and schematic files exactly                      | G19-adjacent; pre-existing serialization bugs | `board_types.proto`, `pcbnew/footprint.cpp`, `pcb_text.cpp`, `pcb_textbox.cpp`, `pcb_shape.cpp`, `pcb_dimension.cpp`, `zone.cpp`, `eeschema/sch_symbol.cpp`, `api_sch_utils.*`                                                                                                                      | additive (`BoardTextBox.border_stroke`, `NetTieDefinition.group`)               | yes — `test_api_proto.cpp` (+112), `test_sch_api_handler.cpp` (+68). **Also adds a stray 7110-line generated SVG** |
|  13 | `bec9e423c2` | API: Implement ParseAndCreateItemsFromString and schematic clipboard-format commands              | G6 / clipboard                                | `pcbnew/api/api_handler_board.cpp`, `eeschema/api/api_handler_sch.cpp` (+276)                                                                                                                                                                                                                       | none                                                                            | yes. **Deletes the stray SVG from #12**                                                                            |
|  14 | `cb3f20808c` | API: Add GetActions and run headless-capable actions without an editor window                     | G3                                            | `editor_commands.proto`, `common/api/api_handler_editor.cpp`, `pcbnew/tools/global_edit_tool.cpp`, `pcbnew/tools/zone_filler_tool.cpp`, board/sch handlers                                                                                                                                          | additive                                                                        | yes — `test_api_handler_pcb.cpp`, `test_sch_api_handler.cpp`                                                       |
|  15 | `c6bd1db405` | API: Add GetItems paging, since_revision, and GetItemCounts                                       | G16                                           | `editor_commands.proto`, `api_handler_editor.*`, sch/symbol/fp/pcb handlers                                                                                                                                                                                                                         | additive                                                                        | yes — `test_api_handler_pcb.cpp` (+108)                                                                            |
|  16 | `5c34c5b2ac` | API: Add asynchronous jobs, GetJobStatus, JobProgress events and inline outputs                   | G17                                           | `base_commands.proto`, `types/jobs.proto`, new `common/api/api_job_registry.cpp` (+334), new `common/api/api_jobs.cpp`, `api_handler_sch.cpp`, `api_handler_pcb.cpp`, `eeschema.cpp`, `pcbnew.cpp`                                                                                                  | additive                                                                        | yes — `test_api_jobs.cpp` (new, +87), `test_api_server.cpp` (+69)                                                  |
|  17 | `022e45f6d2` | API: Accept container text without a header in ParseAndCreateItemsFromString                      | follow-up to #13                              | `eeschema/api/api_handler_sch.cpp`, `pcbnew/api/api_handler_board.cpp`                                                                                                                                                                                                                              | none                                                                            | **no**                                                                                                             |
|  18 | `b4e01726d7` | API: Add library commands and footprint wizards                                                   | G7                                            | new `library_commands.proto` (+310), `events.proto`, new `common/api/api_handler_library.cpp` (+428), new `pcbnew/api/api_handler_footprint_library.*` (+516), new `eeschema/api/api_handler_symbol_library.*` (+314), `symbol_library_adapter.cpp`, `sch_symbol.cpp`, `include/kiway.h` (22 files) | additive (new file + `ProjectChanged` kind)                                     | yes — `test_api_libraries.cpp` (new, +452)                                                                         |
|  19 | `c590f977e0` | API: Add schematic operation commands and sheet file creation                                     | G8                                            | `schematic_commands.proto` (+328), `board_commands.proto`, `api_handler_sch.cpp` (+1231)                                                                                                                                                                                                            | additive                                                                        | yes — `test_api_schematic_ops.cpp` (new, +542)                                                                     |
|  20 | `1882aefba6` | API: Add ratsnest, net length, footprint update, teardrop, autoplace and global deletion commands | G9                                            | `board_commands.proto` (+293), `api_handler_pcb.cpp` (+756), `headless_pcb_context.cpp`, `pcbnew/autorouter/ar_autoplacer.cpp`                                                                                                                                                                      | additive                                                                        | yes — `test_api_board_ops.cpp` (new, +398)                                                                         |
|  21 | `27aa7e67fa` | API: Add Undo, Redo and GetUndoStack                                                              | G10                                           | `editor_commands.proto`, new `common/api/api_undo_stack.cpp`, new `pcbnew/api/api_undo_pcb.*`, new `eeschema/api/api_undo_sch.*`, `board_commit.cpp`, `sch_commit.cpp`, `include/tool/tool_manager.h`, `include/eda_base_frame.h`, `include/undo_redo_container.h` (33 files)                       | additive                                                                        | yes — `test_api_undo.cpp` (new, +400)                                                                              |
|  22 | `b743d2b6bd` | API: Add ListColorThemes, GetColorTheme, GetAppSettings and graphics defaults                     | G11                                           | new `settings_commands.proto` (+163), `board_commands.proto`, `api_handler_common.cpp` (+196), `common/settings/color_settings.cpp`, `settings_manager.cpp`, `api_handler_pcb.cpp`, `command_api_server.cpp`                                                                                        | additive                                                                        | yes — `test_api_settings.cpp` (new, +275)                                                                          |
|  23 | `8eafd9cf01` | API: Accept nng URLs for the server socket, add --token and --no-events                           | G15                                           | `common/api/api_server.cpp`, `include/api/api_server.h`, `kicad/cli/command_api_server.cpp`                                                                                                                                                                                                         | none                                                                            | yes — `test_api_transport.cpp` (new, +51)                                                                          |
|  24 | `1c372484ca` | API: Report replaced items as updated and publish ProjectChanged                                  | G1a                                           | `api_handler_common.cpp`, `api_handler_editor.cpp`, `api_handler_sch.cpp`, `api_handler_pcb.cpp`                                                                                                                                                                                                    | none                                                                            | yes — `test_api_events.cpp` (+71)                                                                                  |
|  25 | `269ceca153` | API: Give RunSchematicJobExportBOM the CLI's default columns                                      | pre-existing bug                              | `schematic_jobs.proto`, `eeschema/api/api_handler_sch.cpp`                                                                                                                                                                                                                                          | additive; **semantic change to existing fields** (unset now means CLI defaults) | yes — `test_api_jobs.cpp` (+64)                                                                                    |
|  26 | `6033d9ef42` | API: Say why a drawing sheet cannot be opened as a document                                       | G5 (scope note)                               | `base_types.proto` (comment), `kicad/cli/command_api_server.cpp`                                                                                                                                                                                                                                    | comment only                                                                    | **no**                                                                                                             |
|  27 | `bc8e733a20` | API: Name the client in ProjectChanged for library table edits                                    | follow-up to #18                              | `common/api/api_handler_library.cpp`, `include/api/api_handler_library.h`                                                                                                                                                                                                                           | none                                                                            | **no**                                                                                                             |
|  28 | `ab6ac72d41` | API: Refuse Undo while any commit is open, as documented                                          | follow-up to #21                              | `editor_commands.proto` (comment), `common/api/api_handler_editor.cpp`                                                                                                                                                                                                                              | comment only; **behaviour change** (refusal widened)                            | yes — `test_api_undo.cpp` (+5)                                                                                     |
|  29 | `19435eef53` | API: Fill in the net code of a ratsnest edge                                                      | follow-up to #20 (G20)                        | `board_commands.proto` (comment), `pcbnew/api/api_handler_pcb.cpp` (1 line)                                                                                                                                                                                                                         | comment only                                                                    | yes — 1 assert. **Also adds 10067 lines of stray fixture data under `qa/data/.fp-pcb-probe/`**                     |
|  30 | `477c6922bb` | API: Count only changed items in SetTeardropsResponse                                             | follow-up to #20 (G20)                        | `board_commands.proto`, `pcbnew/api/api_handler_pcb.cpp`                                                                                                                                                                                                                                            | additive comment; **semantic change to `item_count`**                           | yes — `test_api_board_ops.cpp` (+4)                                                                                |
|  31 | `85d0dfa405` | API: Place GetTextAsShapes glyphs of a text box in the document                                   | G19, pre-existing bug                         | `common/api/api_handler_common.cpp`                                                                                                                                                                                                                                                                 | none                                                                            | yes — `test_api_handler_pcb.cpp` (+159)                                                                            |
|  32 | `cb80f7e100` | API: Give Barcode the encoded symbol geometry                                                     | G19                                           | `board_types.proto`, `pcbnew/pcb_barcode.cpp`                                                                                                                                                                                                                                                       | additive (`Barcode.shapes`, read-only)                                          | yes — `test_api_handler_pcb.cpp` (+40)                                                                             |

### Proto compatibility, verified

`git diff cbd303d16b..web-api -- 'api/proto/*' | grep '^-'` produces **six lines, all
comments**. Nothing is removed, renumbered or retyped anywhere in the series, so every
change is wire-backward-compatible: three new `.proto` files, new messages, new fields
with new numbers, new enum values, and comment edits. 147 `Since 11.0` annotations are
present across `api/proto`.

The compatibility risk is not the wire format, it is **semantics on existing fields**:

- `SetTeardropsResponse.item_count` (#30) now counts changes, not items walked.
- `RunSchematicJobExportBOM` (#25) now substitutes the CLI's defaults where the request
  leaves fields unset, instead of exporting an empty file.
- `Undo` (#28) is refused in more cases than before.
- `GetTextAsShapes` (#31) returns different coordinates for text boxes and table cells —
  no proto change at all, so a client cannot detect the change by capability.

---

## 3. Grouping into merge requests

Ten MRs. The first two are **pure bug fixes to existing behaviour** and depend on
nothing in the rest of the series; they can be opened immediately and land in any
order. Everything after that builds on MR3.

```
MR1  serialization round-trip fixes ──┐
MR2  fixes to existing commands ──────┤  (independent, land first)
MR3  server plumbing + discovery ─────┴──> MR4 ──> MR5 ──┬──> MR6  DRC/ERC
                                                          ├──> MR7  actions + jobs
                                                          ├──> MR8  libraries + sch ops
                                                          ├──> MR9  board ops + undo
                                                          └──> MR10 settings + transport
```

### MR1 — Fix board and schematic item round-tripping through UpdateItems

**Commits:** `3571e8b6c8` (with the stray SVG stripped). **Depends on:** nothing.
**Pure bug fix.**

Sending an item back through `UpdateItems` unchanged altered the saved file: `PCB_TEXT`
and `PCB_FIELD` lost their rotation, `PCB_SHAPE` arcs were written with zero geometry,
`PCB_TEXTBOX` border stroke was not in the message at all, `ZONE` lock state was
serialized in neither direction, net tie pad groups were rejoined with a fixed
separator, and every `SCH_SYMBOL` update appended a `<name>_1` entry to the sheet's
`lib_symbols` cache and re-sorted the pins. The `has_lib_id()` test in
`SCH_SYMBOL::Deserialize` was also inverted, which dropped schematic-local library
names. Two new fields (`BoardTextBox.border_stroke`, `NetTieDefinition.group`) carry
what the message could not express. With this the kitchen-sink board and schematic save
byte-identically after every item type is updated unchanged.

_Reviewers: this touches `pcbnew/footprint.cpp`, `pcb_text.cpp`, `pcb_textbox.cpp`,
`pcb_shape.cpp`, `pcb_dimension.cpp`, `zone.cpp` and `eeschema/sch_symbol.cpp` — core
item serialization, not API plumbing. Consider splitting into a pcbnew half and an
eeschema half so the right maintainers review each._

### MR2 — Fix GetTextAsShapes, BOM export defaults, and add barcode geometry

**Commits:** `85d0dfa405`, `269ceca153`, `cb80f7e100`, plus the
`netlist_exporter_base.cpp` hunk split out of `a00cce1ac3`. **Depends on:** nothing.
**Mostly pure bug fixes.**

Three independent defects in commands that already exist, plus one small additive
field. `GetTextAsShapes` given a `TextOrTextBox` carrying a text box discarded the box's
position and laid the glyphs out around the origin; it now rotates the box corners,
picks the anchor the justification names, applies the margins and breaks to the column
width the way `PCB_TEXTBOX` and `PCB_TABLECELL` do when they draw, and fills in the
effective pen width. `RunSchematicJobExportBOM` with neither a preset nor any field left
`BOM_PRESET::fieldsOrdered` empty and wrote a file with no columns and no rows; it now
falls back to what `kicad-cli sch export bom` defaults to. The netlist exporter no longer
throws when the cvpcb kiface is missing, falling back to the symbol pin numbers.
`kiapi.board.types.Barcode` gains a read-only `PolySet` filled from
`PCB_BARCODE::TransformShapeToPolySet` so a client need not bring its own QR encoder.

_If reviewers want these strictly separate, MR2 splits cleanly into four one-commit MRs._

### MR3 — Server plumbing, dispatch and capability discovery

**Commits:** `ef0ed71606`, `9761ac77a8`, `d5ffe03e2a`, the server half of `a00cce1ac3`,
`72b2d2afe3`, `8b63c6b83e`. **Depends on:** nothing. **Two-thirds bug fix.**

The foundation everything else stands on. `GetSupportedCommands` enumerates the
registered handler tables so a client can learn what a running instance serves and which
commands need an editor window (`HANDLER_MODE`, metadata only). The handler set becomes
a registration-ordered vector so a command two editors serve reaches the right one, with
`API_HANDLER_EDITOR::validateDocument` answering `AS_UNHANDLED` for another editor's
document type; the dispatch loop is factored into `KICAD_API_SERVER::Dispatch` so it can
be unit tested, and it now catches `IO_ERROR` and `std::exception` and answers
`AS_BAD_REQUEST` instead of leaving the REQ/REP socket unable to receive the next
request. A server-owned fallback handler answers `GetOpenDocuments` with an empty list
rather than `AS_UNHANDLED`. The CLI's event loop is woken by a condition variable
instead of a 10 ms poll (`Ping` 12.0 ms → 0.05 ms average, p99 0.15 ms over 300 pings).
Finally, three commands that existed in the protos but were never registered are wired
up: `UpdateBoardStackup` (with a new `BOARD_STACKUP::Deserialize`), `SaveItemsToString`,
and `RefreshEditor` / `FocusOnItem` as headless no-ops.

### MR4 — Headless document lifecycle

**Commits:** `e118ed3f81`, `5d02b01fd3`, `6033d9ef42`, `bec9e423c2` + `022e45f6d2`
(squashed). **Depends on:** MR3.

`NewProject`, `NewDocument` and `GetProjectInfo` on `API_HANDLER_COMMON`, implemented by
`kicad-cli api-server` (the GUI answers `AS_UNIMPLEMENTED`, as it does for
`OpenDocument`). `OpenDocument` accepts `DOCTYPE_SYMBOL` with a `Lib:Name` path and the
eeschema kiface loads it into a new `HEADLESS_SYMBOL_CONTEXT` with an
`API_HANDLER_SYMBOL`, mirroring the headless footprint document. `OpenLibraryItem` no
longer dereferences a null footprint-editor frame (it crashed the server headless), and
opening a footprint headless no longer tears down the open board:
`KIFACE::HandleApiCloseDocument` takes a `DOCUMENT_SPEC` so library items are addressed
by `LIB_ID` and files by name. `ParseAndCreateItemsFromString` is implemented for the
board (it was an `AS_OK` stub that created nothing) and added for the schematic together
with `SaveDocumentToString` and `SaveItemsToString`. `DOCTYPE_DRAWING_SHEET` now answers
with the reason it is out of scope instead of a generic message.

### MR5 — Change notification: revisions, events, incremental reads

**Commits:** `3c7ce604bf`, `e8cd61a2f2`, `1c372484ca`, `c6bd1db405`.
**Depends on:** MR3, MR4.

A pub0 socket beside the request socket (`api.sock` → `api-events.sock`, per-scheme for
non-ipc URLs), wrapped by a new `KINNG_PUBLISHER` in `libs/kinng`. `KICAD_API_SERVER`
owns it, exposes a thread-safe `Publish()` and attaches itself to every handler.
Handler registration publishes `DocumentOpened` / `DocumentClosed`, `Stop()` publishes
`ServerShutdown`, `pushCurrentCommit` publishes `DocumentChanged` with the commit id,
client name and the created/updated/deleted ids (via a new `COMMIT::ForEachEntry`), and
project-level commands publish `ProjectChanged`. `GetServerInfo` reports both socket URLs
and the token so a client can find the events socket. `GetDocumentRevision` remains as a
one-message poll for clients that do not subscribe. On top of the revision counter,
`GetItems` gains `page{offset, limit}` with `total`, and `since_revision` backed by a
bounded 256-step change log that degrades to "return everything" when a change cannot be
attributed — always correct, never wrong; `GetItemCounts` counts without serializing.

### MR6 — DRC and ERC

**Commits:** `1ca7f148a5`. **Depends on:** MR5.

`RunBoardJobDrc` and `RunSchematicJobErc` run the checkers the way the `kicad-cli`
jobs do, synchronously and without a frame, plus `GetDrcMarkers` / `GetErcMarkers`,
`SetDrcMarkerExcluded` / `SetErcMarkerExcluded` (recorded in the design settings so they
persist across runs) and `Get`/`SetDrcSeverities` / `Get`/`SetErcSeverities`. Results
carry every marker with id, effective severity, exclusion state, comment and
description, plus counts by severity and, for boards, unconnected and parity counts.
Marker counts match `kicad-cli pcb drc` and `sch erc` exactly. `InjectDrcError` now
pushes through `pushCurrentCommit`, so it publishes a proper event and no longer leaves
an empty commit behind.

### MR7 — Headless actions and asynchronous jobs

**Commits:** `cb3f20808c`, `5c34c5b2ac`. **Depends on:** MR5.

`GetActions{document}` lists the editor's actions from its `ACTION_MANAGER` with a
`headless_capable` flag; `RunAction` and `GetActions` move to `API_HANDLER_EDITOR` and
each editor handler owns the actions with its prefixes, so `RunAction` is registered for
the schematic editor for the first time. Headless, the board handler registers
`ZONE_FILLER_TOOL` and `GLOBAL_EDIT_TOOL` on demand (`ResetTools`, not `InitTools`, which
would build context menus on a frame) and runs zone fill/unfill and track/graphics
cleanup; everything else answers `AS_UNIMPLEMENTED` with a message. Separately,
`RunJobSettings.async` queues a job and returns a `job_id` immediately, `GetJobStatus`
serves the outcome, `JobProgress` events are published as it runs, and
`RunJobSettings.return_inline` returns output bytes (up to 16 MiB) so a client needs no
shared filesystem. A new `API_JOB_REGISTRY` in kicommon owns the job table and one
worker thread; jobs run strictly one at a time.

### MR8 — Libraries and schematic operations

**Commits:** `b4e01726d7` + `bc8e733a20` (squashed), `c590f977e0`.
**Depends on:** MR4, MR5.

`library_commands.proto` and its handlers: `GetLibraryTables`, `ListLibraryEntries`,
`GetLibraryItem`, `SaveLibraryItem`, `DeleteLibraryItem`, `CreateLibrary`,
`AddLibraryTableRow`, `RemoveLibraryTableRow`, `ListWizards`, `RunWizard`. A shared
`API_HANDLER_LIBRARY` in kicommon implements the table commands on `LIBRARY_MANAGER`;
the pcbnew and eeschema kifaces register footprint and symbol library handlers on a new
`DOCUMENT_SPEC::PROJECT_KIND` open request. `SYMBOL_LIBRARY_ADAPTER::DeleteSymbol`, a
stub, is implemented. Then the schematic operations that only dialogs offered:
`Annotate` / `ClearAnnotation` with the dialog's scope and options,
`SyncSchematicToBoard` (netlist exported in process and applied to the open board),
`Get`/`SetSchematicSettings`, `GetSymbolFieldsTable` / `SetSymbolFields`, and
`AssignFootprints`. `CreateItems(SCH_SHEET_T)` now attaches a screen the way the sheet
dialog does, creating the file on disk when it is missing.

_This is the largest MR (~5000 lines). Split into "libraries" and "schematic
operations" if reviewers prefer; they are independent apart from `UnpackLibSymbol`,
which the library commit factors out of `SCH_SYMBOL::Deserialize`._

### MR9 — Board operations and undo/redo

**Commits:** `1882aefba6` + `19435eef53` + `477c6922bb` (squashed), `27aa7e67fa` +
`ab6ac72d41` (squashed). **Depends on:** MR5, MR7.

`GetRatsnest` / `GetUnroutedCount` from `CONNECTIVITY_DATA`, `GetNetLengths` from
`LENGTH_DELAY_CALCULATION`, `UpdateFootprintsFromLibrary` through
`BOARD::ExchangeFootprint`, `SetTeardrops` / `RemoveTeardrops`, `AutoplaceFootprints`
via `AR_AUTOPLACER` (which now tolerates having no view overlay), and `GlobalDeletion`.
Headless netlist import adds new footprints to connectivity after spreading them, which
the editor's placement drag used to do. Then undo: `UNDO_REDO_SINK` is an interface a
`TOOL_MANAGER` can carry, `BOARD_COMMIT` and `SCH_COMMIT` hand their undo lists to it
when there is no frame, and `API_UNDO_STACK` keeps the containers, attributes each
command to the client and commit that made it, and applies it back through
frame-less ports of `PutDataInPreviousState`. `Undo` / `Redo` / `GetUndoStack` publish a
`DocumentChanged` per step and are refused while any client has an open commit.

### MR10 — Settings, colour themes and transport

**Commits:** `b743d2b6bd`, `8eafd9cf01`. **Depends on:** MR3, MR5.

Read-only settings a client needs to render like KiCad: `ListColorThemes` /
`GetColorTheme` (every theme the settings manager knows, all colours keyed the way the
theme file is, with the KiCad layer id each one colours) and `GetAppSettings{app}`
(units, theme, grids, zoom factors, undo depth, drawing defaults), plus the
already-declared-but-unserved `GetGraphicsDefaults` and a new `SetGraphicsDefaults`.
And transport: `KICAD_API_SERVER::SetSocketPath` accepts a full nng URL (`ipc://`,
`tcp://`, `ws://`, `wss://`, `inproc://`) with the events socket derived per scheme, so
a browser can dial the server over nng's WebSocket transport with no bridge in the
request path; `--token` and `--no-events` are added to `kicad-cli api-server`.

---

## 4. Risk and review notes

### MR1 — serialization

- Touches core item serialization outside `api/`. A regression here corrupts files for
  _every_ API client, not just ours. The QA evidence is a byte-identical save of the
  kitchen sink after every item type is updated unchanged; that argument needs to be in
  the MR description, not only in the commit message.
- `NetTieDefinition.group` carries the raw text and is used verbatim "when it still names
  the same pads". A reviewer will ask what happens when it does not — the answer is that
  the handler falls back to rejoining, but the proto comment should say so.
- The commit currently also adds `qa/data/pcbnew/fp-pcb-out/board-svg-run-1/api_kitchen_sink.svg`
  (7110 lines of generated output), deleted again two commits later. **Must be stripped.**

### MR2 — behaviour changes to existing commands

- **`GetTextAsShapes` is a behaviour change with no capability flag.** A client that
  worked around the origin-relative output by adding the item position itself will now
  double-count. There is no proto field to gate on and no version to test other than the
  KiCad version string. Expect the maintainer to ask for either a note in the release
  notes or an explicit opt-in field; our position is that the old output was simply wrong
  (glyphs for a cell at 25, 24.5 mm came back at 0.3, 0.6 mm) and no correct client can
  depend on it.
- **The BOM defaults change** makes a request that names no fields behave like the CLI
  rather than producing an empty file. Defensible, but it is a policy decision about
  whether the API should inherit CLI defaults at all; a maintainer may prefer
  `AS_BAD_REQUEST` for a request with no columns. Have both answers ready.
- The barcode `PolySet` is derived, read-only data in a message that is otherwise
  round-trippable; `Deserialize` ignores it. Reviewers dislike write-ignored fields.
  Expect a request to move it to a separate `GetBarcodeShapes` command instead.
  The proto comment must be unambiguous that the field is output-only.

### MR3 — plumbing

- **`std::set<API_HANDLER*>` → `std::vector<API_HANDLER*>`.** This is the change most
  likely to draw a question. Registration order becoming semantically significant is a
  real API contract change for anyone who registers handlers: a handler that serves a
  command for more than one editor must now answer `AS_UNHANDLED` for documents it does
  not own, or it will swallow the request. The header comment says so; it should also be
  called out in the MR description, because plugins or future kifaces that register
  handlers are affected. Lookup is linear, but the list is a handful of entries.
- `include/api/api_server.h` now includes `api/api_handler.h`, widening a widely-included
  header's dependency graph. Consider a forward declaration plus an out-of-line
  definition if compile times matter to the reviewer.
- `std::ranges::find` is used; the tree is C++20 (`CMAKE_CXX_STANDARD 20`), so this is
  fine, but KiCad code around it is mostly pre-ranges.
- The condition-variable wake-up adds `std::condition_variable` + `std::mutex` to
  `KICAD_API_SERVER` and a `WaitForRequest()` the CLI blocks on with a 100 ms bound so
  signals are still noticed. A reviewer will want to see that `Stop()` and shutdown
  cannot deadlock against a waiter.
- The exception catch is broad (`IO_ERROR` then `std::exception`). Some maintainers
  prefer letting real bugs crash. The counter-argument is concrete: a throwing handler
  makes the REQ/REP socket unable to receive _any_ further request, so one bug takes the
  whole session down.
- `BOARD_STACKUP::Deserialize` deletes content on layers dropped from the stackup, as the
  message documentation warns. That is destructive behaviour reachable from a single API
  call with no undo entry — expect scrutiny, and note that after MR9 it does get an undo
  entry.

### MR4 — lifecycle

- **`KIFACE::HandleApiCloseDocument` changes signature** (`const wxString&` →
  `const DOCUMENT_SPEC&`) and `DOCUMENT_SPEC::KIND` gains `PROJECT_KIND`. `KIFACE_VERSION`
  is still `1`; any out-of-tree kiface overriding that virtual breaks silently at
  compile time (loudly) or via a vtable mismatch (quietly). Ask whether `KIFACE_VERSION`
  should be bumped.
- `NewProject` writes files (a `.kicad_pro` plus stub schematic and board) from an API
  call. Path validation and the template lookup are the security-relevant surface;
  a reviewer will look at what happens with a relative or traversing path.
- `kicad/cli/command_api_server.cpp` grows by ~400 lines in this commit alone and is
  touched by seven commits in the series. It is becoming the second implementation of
  the project manager. Expect a request to factor the project/document creation out of
  the CLI command and into `common/`.

### MR5 — events

- A second nng socket per server changes the process's file/port footprint. For `ipc://`
  it is a sibling file; for `tcp://` it is **the next port number**, which is an
  assumption a reviewer may reject (port collisions). Consider making the events URL
  explicitly configurable.
- Events are fire-and-forget pub0 with a sequence number; a slow subscriber silently
  misses messages and detects the gap. That is the right design for pub0 but must be
  stated in the proto so clients do not treat the stream as reliable.
- `COMMIT::ForEachEntry` is new public API on `COMMIT`, used only by the API layer.
- The `since_revision` change log is bounded at 256 steps and degrades to a full answer.
  The degradation is correct but a client cannot tell it happened; consider a response
  flag.
- Publishing happens from handler code that runs on the wx main thread, but `Publish()`
  is documented thread-safe because the job worker calls it too. The locking needs to be
  obvious in review.

### MR6 — DRC/ERC

- **Known open defect, disclose it:** after the async export jobs have run in a session, a
  subsequent `RunBoardJobDrc` never answers at all (gap G22 in
  [04-ipc-gaps.md](04-ipc-gaps.md)) — most likely the job worker thread and the
  synchronous DRC path contending for the board. This must be fixed or the interaction
  documented before MR6 and MR7 are both in flight; it is exactly the kind of thing a
  reviewer will find by running the two together.
- ERC needs connectivity recalculated first because `ERC_TESTER::RunTests` only does that
  when it has a frame, and `RunERC` leaves state behind that changes a second run's
  result. That is a workaround for an eeschema wart; a maintainer may want the wart fixed
  instead.
- Exclusions are written into the design settings, i.e. the project file, from a read-ish
  command. Worth flagging explicitly.

### MR7 — actions and jobs

- **The async job worker is the single biggest threading risk in the series.** One
  `API_JOB_REGISTRY` per binary (host and each kiface), one worker thread, jobs
  serialized so they never overlap on the jobs handler's cached document, and the kifaces
  wait for the worker before releasing that document. Async is honoured headless only; an
  editor window runs the job synchronously. Every one of those constraints is load-bearing
  and a reviewer will want them written down in the header, not inferred from the code.
  The `RunBoardJobDrc` hang above is the evidence that the boundary is not yet airtight.
- `API_JOB_REGISTRY::Instance()` is a singleton, one per module. KiCad has singletons but
  a per-module one that is _also_ a thread owner deserves an explicit lifetime note
  (who joins the thread at shutdown, in what order relative to kiface unload).
- 16 MiB inline outputs travel through an nng message. Check that against nng's message
  size limits and the server's own limits; a reviewer will.
- `RunAction` headless registers tools on demand with `ResetTools` rather than
  `InitTools`. This is the existing `handleRefillZones` pattern, but it is now applied to
  `GLOBAL_EDIT_TOOL`, and the two cleanup tools get a new frame-less path that runs with
  the dialog's default options — i.e. the API silently picks options a user would have
  chosen in a dialog. Expect a request to expose them.
- `pcbnew/tools/global_edit_tool.cpp` and `zone_filler_tool.cpp` change outside `api/`.

### MR8 — libraries and schematic operations

- Writing to library tables and to library files from an API call is the most
  security- and data-loss-sensitive surface in the series. `DeleteLibraryItem` and
  `RemoveLibraryTableRow` have no undo.
- `RunWizard` runs footprint wizards. Ours is Python-free by construction; make sure the
  MR says so explicitly, because "run a wizard over IPC" reads like arbitrary code
  execution.
- `SyncSchematicToBoard` **dispatches an `ImportNetlist` request back through the
  server** from inside a handler. Re-entrant dispatch is clever and will be questioned;
  be ready to call the updater directly instead.
- `CreateItems(SCH_SHEET_T)` creates a file on disk as a side effect of an item creation
  command. Surprising, but it matches what the sheet dialog does.
- `BackAnnotate` is deliberately absent (`BACK_ANNOTATE` is bound to `SCH_EDIT_FRAME`);
  say so in the MR so it is not read as an oversight.

### MR9 — board operations and undo

- `pcbnew/autorouter/ar_autoplacer.cpp` is changed to tolerate a missing view overlay.
  Small, but it is autorouter code touched for an API reason.
- Undo reaches deep: `include/tool/tool_manager.h`, `include/eda_base_frame.h`,
  `include/undo_redo_container.h`, `board_commit.cpp`, `sch_commit.cpp`.
  `RestoreBoardUndoList` and `RestoreSchematicUndoList` are **frame-less ports of
  `PutDataInPreviousState`** — that is duplicated logic that will drift from the frame
  versions. A reviewer may well ask that the frame code be refactored to use the new
  functions instead, which is a much larger change. Have a position on this before
  opening the MR.
- `SetTeardropsResponse.item_count` changes meaning (see §2).

### MR10 — settings and transport

- `tcp://`, `ws://` and `wss://` listeners mean the API server can be reachable off the
  machine. Today's `ipc://` default is protected by filesystem permissions; a TCP
  listener is protected only by the `kicad_token`, which `--token` now lets the operator
  fix to a known value. Expect a hard question about defaults, binding to localhost, and
  whether `wss://` has any TLS configuration at all. Be ready to propose that non-ipc
  schemes require an explicit opt-in flag.
- **Known open defect:** `GetColorTheme("KiCad Classic")` returns zero colours because
  `COLOR_SETTINGS::CreateBuiltinColorSettings()` clears that theme's `m_params`, so
  `GetColorKeys()` is empty (gap G21). Only "KiCad Default" answers usefully. Either fix
  it in this MR or disclose it.
- `COLOR_SETTINGS::GetColorKeys` and `SETTINGS_MANAGER::GetSettingsByFilename` are new
  public API on settings classes, added for the API layer's benefit.

### Deviations from KiCad conventions, series-wide

- **Commit trailers.** Every commit carries a `Co-Authored-By: Claude …` trailer. KiCad
  has a [policy on tool-generated contributions](https://dev-docs.kicad.org/en/rules-guidelines/tool-generated-content/index.html)
  linked from `CONTRIBUTING.md`; read it and comply before pushing anything. Do not
  quietly strip the trailers — the policy, not convenience, decides what the trailer
  should say.
- **`Since 11.0` in commit messages** is inconsistent: some commits write "Since 11.0.",
  some "Since 11.0", and commits 1–7 have none. The convention is a proto _comment_, not
  a commit-message line; the line should probably be dropped everywhere and only the
  proto comments kept.
- **Line width.** The series wraps at ~100 columns; `_clang-format` sets
  `ColumnLimit: 120`. Running `clang-format-diff` over the series' added lines produces
  suggestions in 55 files (~5150 diff lines), and the large majority are "join these two
  lines, they fit in 120". Per `CONTRIBUTING.md` rule 7 and its clang-format caveats,
  matching the surrounding file is correct and these should not be applied wholesale —
  but the CI format check will flag them, so decide the position before the pipeline
  does.
- Real formatting nits do exist in the same output (a stray blank line before a closing
  brace in `API_HANDLER_COMMON::registerHandlers`, for one). Fix those.

---

## 5. Checklist before submission

### Must fix — the series is not submittable as it stands

1. **Strip the stray generated SVG.** `3571e8b6c8` adds
   `qa/data/pcbnew/fp-pcb-out/board-svg-run-1/api_kitchen_sink.svg` (7110 lines) and
   `bec9e423c2` deletes it. Both commits must be rewritten so the file never appears.
2. **Strip the stray fixture directory.** `19435eef53` — a three-line bug fix — adds 14
   files and 10067 lines under `qa/data/.fp-pcb-probe/` (a hidden scratch project:
   `api_kitchen_sink.kicad_pcb/pro/sch/dru`, `fp-lib-table`, `sym-lib-table` and a
   six-footprint `Resistor_SMD.pretty`). Nothing in `qa/tests/` references that path; the
   tests use `KI_TEST::GetPcbnewTestDataDir()` and the fixtures already in
   `qa/data/pcbnew/`, `qa/data/eeschema/` and `qa/data/libraries/`. Delete the directory
   from history entirely.
3. **The QA tests are now compiled and run** (see the QA status section at the end: 154
   `qa_api` cases and 1232 `qa_eeschema` cases pass in a `-DKICAD_BUILD_QA_TESTS=ON` build).
   This item was originally "never compiled"; keep the build-dir caveat in mind when cutting
   branches: run `qa_api` on each MR branch, not only on the tip. At least one defect is already
   visible by inspection: `test_api_board_ops.cpp:72`, `test_api_settings.cpp:106` and
   `test_api_undo.cpp:71` copy `api_kitchen_sink.kicad_prl` into the temp project and
   `return false` if the copy fails — **that file does not exist** in `qa/data/pcbnew/`,
   so those three fixtures fail to set up. Configure a build with
   `-DKICAD_BUILD_QA_TESTS=ON`, build `qa_api`, `qa_eeschema` and `qa_kinng`, and fix
   what falls out before submitting anything.
4. **Squash the follow-up fixes into the commits they fix.** Upstream has never seen
   these commands, so a fix-on-top reads as churn:
   - `022e45f6d2` → into `bec9e423c2` (both are `ParseAndCreateItemsFromString`).
   - `bc8e733a20` → into `b4e01726d7` (`client_name` was simply missing).
   - `ab6ac72d41` → into `27aa7e67fa` (`Undo` never matched its own documentation).
   - `19435eef53` and `477c6922bb` → into `1882aefba6` (net code, teardrop count).
   - The "replaced items reported as updated" half of `1c372484ca` → into `e8cd61a2f2`;
     keep the `ProjectChanged` half as its own commit.
5. **Split the commits that mix concerns.**
   - `ef0ed71606` — `GetSupportedCommands` plus an unrelated null-frame guard on the
     footprint editor's `RevertDocument`. Split the guard out; it is a one-line bug fix
     that can go in MR2.
   - `a00cce1ac3` — server exception handling plus a cvpcb-independence fix in
     `eeschema/netlist_exporters/netlist_exporter_base.cpp`. Different maintainers.
     Split (MR3 and MR2 respectively).
   - `8b63c6b83e` — `UpdateBoardStackup` (+`BOARD_STACKUP::Deserialize`),
     `SaveItemsToString`, and the `RefreshEditor`/`FocusOnItem` no-ops are three
     unrelated features in one commit. Split into three.
   - `5d02b01fd3` — the `OpenLibraryItem` crash fix, the independent-close fix, and the
     `KIFACE` signature change are separable; at minimum the signature change should be
     its own commit so the ABI question is reviewable on its own.
   - `3571e8b6c8` — consider a pcbnew commit and an eeschema commit (MR1 note).
   - `1882aefba6` (7 features, 1487 lines) and `c590f977e0` (6 features, 2156 lines) are
     each defensible as one coherent "add the operations that only dialogs offered"
     commit, but if a reviewer objects, split per operation; the handlers are independent.
6. **Decide the tool-generated-content position** and comply with
   `https://dev-docs.kicad.org/en/rules-guidelines/tool-generated-content/index.html`
   before pushing. This is a hard gate: `CONTRIBUTING.md` links it specifically.
7. **Announce on the devlist first.** `CONTRIBUTING.md` rule 4: a change this size must be
   discussed on `devlist@kicad.org` before the MRs are opened. Send the series overview
   from §1, the MR breakdown from §3, and the open defects (G21, G22).

### Should fix

8. **`Since 11.0` annotations.** 147 are present in `api/proto`. Audit that _every_ new
   field, message and enum value has one, including the new files
   (`events.proto`, `library_commands.proto`, `settings_commands.proto`) whose members
   are new by definition but whose individual fields are what clients feature-detect.
   Drop the "Since 11.0" lines from the commit messages.
9. **clang-format.** Run `clang-format-diff` over each MR's diff, apply the genuine nits
   (stray blank lines, misaligned continuations), and leave the 100-vs-120 column
   rewrapping alone per `CONTRIBUTING.md`. Be ready to explain the CI failures.
10. **The version-string quirk.** `GetVersion` on this fork answers
    `KiCad 10.99.0 "10.99.0-3658-gcbd303d16b"` — the full version string carries the
    build's git describe, so a client cannot use it to feature-detect the series (and it
    will read differently on every rebase). This is why capability detection has to go
    through `GetSupportedCommands` and the `Since 11.0` proto comments, and the MR
    descriptions should say so rather than implying a version check works.
11. **Add QA tests for the three commits that have none** (`022e45f6d2`, `6033d9ef42`,
    `bc8e733a20`) — or fold them into commits that do, per item 4.
12. **Fix or disclose G21 and G22** (`GetColorTheme("KiCad Classic")` empty; `RunBoardJobDrc`
    hangs after async export jobs). G22 in particular is a hang, and a hang in a
    submitted MR is a rejection.
13. **Rebase onto current upstream master.** The series is based on `cbd303d16b`
    (2026-09-06). Rebase, re-run the conformance suite, and re-check the diffstats before
    opening anything.

---

## 6. `git format-patch`-ready recipe

Assumes `upstream` points at `https://gitlab.com/kicad/code/kicad.git` and that steps 1–5
of the checklist have been done on a _cleanup branch_ (`web-api-clean`) produced with an
interactive rebase — do not cherry-pick from `web-api` itself while the stray files and
mixed commits are still in it.

### 0. Prepare the cleaned source branch

```bash
cd /Users/hyper/projects/tensorfleet/kicad
git fetch upstream
git checkout -b web-api-clean web-api

# remove the two stray blobs from every commit that carries them
git filter-repo --force --invert-paths \
    --path qa/data/.fp-pcb-probe \
    --path qa/data/pcbnew/fp-pcb-out \
    --refs cbd303d16b..web-api-clean
# (or: git rebase -i cbd303d16b, editing 3571e8b6c8, bec9e423c2 and 19435eef53)

git rebase -i upstream/master        # squashes and splits from checklist items 4 and 5
```

### 1. Cut one branch per MR

Each branch starts from upstream master (MR1–MR3) or from the branch it depends on.
`-x` records the source commit so the provenance stays visible while the series is in
review; drop it before the final push if you prefer clean messages.

```bash
B=$(git rev-parse upstream/master)

# --- independent, land first -------------------------------------------------
git checkout -b api-mr1-serialization        $B
git cherry-pick -x 3571e8b6c8                       # (post-cleanup hash)

git checkout -b api-mr2-command-fixes        $B
git cherry-pick -x 85d0dfa405 269ceca153 cb80f7e100 <netlist-exporter-split> <revert-guard-split>

git checkout -b api-mr3-server-plumbing      $B
git cherry-pick -x ef0ed71606 9761ac77a8 d5ffe03e2a <dispatch-exceptions-split> 72b2d2afe3 \
                   <stackup-split> <saveitems-split> <noops-split>

# --- the stack ---------------------------------------------------------------
git checkout -b api-mr4-lifecycle            api-mr3-server-plumbing
git cherry-pick -x e118ed3f81 5d02b01fd3 6033d9ef42 bec9e423c2   # 022e45f6d2 squashed in

git checkout -b api-mr5-events               api-mr4-lifecycle
git cherry-pick -x 3c7ce604bf e8cd61a2f2 <projectchanged-half> c6bd1db405

git checkout -b api-mr6-drc-erc              api-mr5-events
git cherry-pick -x 1ca7f148a5

git checkout -b api-mr7-actions-jobs         api-mr5-events
git cherry-pick -x cb3f20808c 5c34c5b2ac

git checkout -b api-mr8-libraries-sch-ops    api-mr5-events
git cherry-pick -x b4e01726d7 c590f977e0     # bc8e733a20 squashed in

git checkout -b api-mr9-board-ops-undo       api-mr7-actions-jobs
git cherry-pick -x 1882aefba6 27aa7e67fa     # 19435eef53, 477c6922bb, ab6ac72d41 squashed in

git checkout -b api-mr10-settings-transport  api-mr5-events
git cherry-pick -x b743d2b6bd 8eafd9cf01
```

**Expect conflicts, and do not fight them with `git apply`.** Measured against the
`cbd303d16b` base: every one of the 32 patches fails a plain `git apply --check` and
succeeds under three-way (`git apply --check -3`), because the later commits touch lines
their predecessors added — chiefly `common/api/api_server.cpp`,
`common/api/api_handler_editor.cpp`, `pcbnew/api/api_handler_pcb.cpp`,
`eeschema/api/api_handler_sch.cpp`, `kicad/cli/command_api_server.cpp` and the shared QA
files `qa/tests/api/test_api_server.cpp` and `test_api_handler_pcb.cpp`. `cherry-pick`
does the three-way merge for you; the QA files are where the manual work is, since one
test file accumulates cases from several MRs and each branch must carry only its own.

### 2. Produce the patches for review or for the list

```bash
for mr in api-mr1-serialization api-mr2-command-fixes api-mr3-server-plumbing \
          api-mr4-lifecycle api-mr5-events api-mr6-drc-erc api-mr7-actions-jobs \
          api-mr8-libraries-sch-ops api-mr9-board-ops-undo api-mr10-settings-transport; do
    base=$(git merge-base upstream/master "$mr")
    git format-patch --cover-letter -o "/tmp/patches/$mr" "$base..$mr"
done
```

Fill in each cover letter from the corresponding §3 description and §4 risk notes.
On GitLab, push each branch to your fork and open the MR against `master` with the
CI/CD settings `CONTRIBUTING.md` requires (pipelines visible to everyone, 3 h timeout,
"allow commits from members who can merge" checked).

### 3. Build and run the conformance suite against one branch

```bash
# build the branch under test, WITH QA this time
cd /Users/hyper/projects/tensorfleet/kicad
git checkout api-mr5-events
cmake -S . -B build/mr5 -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DKICAD_BUILD_QA_TESTS=ON \
      -DwxWidgets_CONFIG_EXECUTABLE=$(brew --prefix)/bin/wx-config-3.2 \
      -DNGSPICE_LIB_NAME=libngspice.0.dylib \
      -DNGSPICE_ROOT_DIR=$(brew --prefix)/opt/libngspice \
      -DOCC_INCLUDE_DIR=$(brew --prefix)/opt/opencascade/include/opencascade \
      -DOCC_LIBRARY_DIR=$(brew --prefix)/opt/opencascade/lib
cmake --build build/mr5 --target kicad-cli pcbnew_kiface eeschema_kiface qa_api qa_eeschema

# C++ QA
ctest --test-dir build/mr5 -R "api|kinng" --output-on-failure

# client conformance against a live server built from this branch
cd /Users/hyper/projects/tensorfleet/fab_pcb
KICAD_CLI=/Users/hyper/projects/tensorfleet/kicad/build/mr5/kicad/KiCad.app/Contents/MacOS/kicad-cli \
  bun run --filter @fp-pcb/client test:conformance
```

The suite spawns its own `kicad-cli api-server` on a unique socket with the kitchen-sink
project copied to a temp directory, one test per command, and writes
`packages/client/dist/conformance-summary.txt`. On a partial branch, commands introduced
by _later_ MRs will be missing from `GetSupportedCommands`; run with the branch's own
command table, or read the "command in the table has no test" failures as expected and
compare the per-MR summary against the full-series baseline
(`165 commands: 150 pass, 15 skip (gui-only), 0 fail`) rather than requiring it.

## QA status (updated 2026-09-07)

The series' QA tests are now compiled and run, not just syntax-checked. A build with
`-DKICAD_BUILD_QA_TESTS=ON` runs **148 `qa_api` cases and 1232 `qa_eeschema` cases green**, plus
`qa_kinng` and the pcbnew suites. Getting there took 13 commits (`3bc9b20e69..ab43ac2538`) that fixed
three compile errors (including a product header that was never self-contained), five wrong test
expectations, and **six product bugs** the tests caught:

- footprint text angle was serialized unnormalized, so round-tripped footprints came back 360 degrees
  off. This was a regression introduced by this series' own round-trip commit, caught only here.
- setup-panel headings leaked into the DRC and ERC severity lists as unknown rule types.
- `GetItemCounts` never counted vias or arcs.
- twenty handlers swallowed validation errors as a bare `AS_UNHANDLED` with no message.
- `SCH_PIN::swapData` was never implemented, so updating a pin silently did nothing (and undo of a
  pin edit in the symbol editor was broken too).
- an empty commit advanced the document revision and published a change event naming no items.

Fixture hygiene is also fixed: the accidentally committed `qa/data/.fp-pcb-probe/` tree is
untracked and ignored, and the tests no longer depend on a `.kicad_prl` that is gitignored repo-wide.
The pre-existing failures in `qa_common`, `qa_pcbnew_other`, `qa_spice` and `qa_cli` are upstream or
environmental and untouched by this series.
