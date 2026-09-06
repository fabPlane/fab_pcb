# 05 — Agent plan

Nine agents plus a coordinator. Each agent owns one package or one concern, has a
written contract with its neighbours, and is judged by an objective exit test. Agents
run in three waves so nobody waits on an unfinished interface: wave 1 produces the
contracts (generated types, transport, a running server); waves 2 and 3 build on
them in parallel.

## Coordinator (human + one lead session)

- Owns this `docs/` folder, the package boundaries, and the `KICAD_COMMIT` pin.
- Merges; runs the coverage script after every KiCad-fork change and republishes
  `api-coverage.md`.
- Resolves interface disputes by editing the contract doc, never by side channel.

## Wave 1 — foundations (parallel, ~1 week)

### A1 · KiCad build & server agent
- Build `kicad-cli` from the 10.99 checkout on macOS (and a Linux Docker image for
  CI); script it in `packages/kicad-patches/build.sh`.
- Prove `kicad-cli api-server qa/data/pcbnew/api_kitchen_sink.kicad_pro` starts,
  and document socket path, startup time, memory. (Done 2026-09-06: see docs/m0-runbook.md.)
- Exit: `Ping` and `GetVersion` answered from a 40-line Bun script speaking raw
  nng framing (this script becomes A3's first test).

### A2 · Proto & codegen agent
- `packages/proto`: buf config, protobuf-es generation from `../kicad/api/proto`,
  `Any` registry, int64 policy, `KICAD_COMMIT` pin, drift check in CI.
- `tooling/coverage`: the script that diffs `.proto` request messages against
  `registerHandler<>` pairs and emits `api-coverage.md` plus `commands.json`
  (request → response → handler → headless flag) consumed by A4's generator.
- Exit: `bun run gen` is reproducible; `commands.json` lists 111 commands.

### A3 · Transport & bridge agent
- `NngIpcTransport` (Bun, `Bun.connect` unix socket) with the SP handshake, length framing, REQ0 ids,
  FIFO queue, timeouts, reconnect.
- `packages/bridge`: Bun WebSocket server (`Bun.serve`), session = one `kicad-cli api-server`
  process, correlation ids, process supervision, file API (list/read/write inside
  a workspace root), static hosting of `apps/web`.
- Exit: browser tab → bridge → KiCad `GetVersion` round trip; 1000 sequential
  `Ping`s < 2 s; server crash is detected and reported to the tab.

## Wave 2 — client, renderers, first patches (parallel, ~3 weeks)

### A4 · Client SDK agent
- `packages/client`: `KiCadClient`, generated `commands.ts` from `commands.json`,
  object model (`KiCad`, `Project`, `Board`, `Schematic`, `FootprintDocument`,
  item wrappers, `commit()`), units, errors, capability flags.
- Conformance suite in `e2e/api`: one passing test per headless command against
  the kitchen-sink fixtures.
- Exit: 92/92 headless commands green; wrappers round-trip every item type in
  both kitchen-sink files without data loss (`SaveDocumentToString` diff).

### A5 · Board renderer agent
- `packages/renderer/board`: Pixi scene, layer containers, item views for every
  board type, pad/text shape cache, zone fill triangulation, theme, picker, camera.
- Exit: kitchen-sink board visually matches `RunBoardJobExportSvg` output in a
  pixel-diff harness (tolerance documented); 60 fps pan/zoom on a 100k-item board.

### A6 · Schematic renderer agent
- `packages/renderer/schematic`: symbol rendering through transforms and units,
  wires/buses/junctions/labels/sheets/fields, hierarchy navigation.
- Exit: kitchen-sink schematic matches `RunSchematicJobExportSvg`; every label and
  pin is pickable.

### A7 · KiCad API-gap agent (C++)
- Works in the KiCad fork, branch `web-api`, in the order given in
  [04-ipc-gaps.md](04-ipc-gaps.md): G13, G6, G1, G5, G4, G3, then G16, G17.
- Every patch: proto + handler + `qa/tests/api` test + note in `api-coverage.md`
  via A2's script + a conformance test handed to A4.
- Exit for wave 2: G13, G6, G1, G5, G4 merged; events reach a browser tab.

### A8 · App shell agent
- `apps/web`: layout, project screen, panels, command palette, properties editor
  (schema-driven from protobuf descriptors so new fields appear automatically),
  keyboard map, light/dark themes, item store + optimistic commits + client undo.
- Depends on A4 (client) and consumes A5/A6 through a small `CanvasHost` contract
  (`mount(el, store, theme)`, `onPick`, `setCamera`).
- Exit: open project, view board and schematic, select, move, edit properties,
  save; reopen in desktop KiCad 10.99 and see the change.

## Wave 3 — parity (parallel, ~4 weeks)

### A7 (continued) · G7 libraries, G8 schematic ops, G9 board ops, G10 undo, G11 settings, G15 transport, G3 for schematic.
### A8 (continued) · library browser, place-symbol/footprint flows, annotate, sync to board, DRC/ERC panels, exports/jobs UI, 3D view (three.js + GLB).
### A5/A6 (continued) · ratsnest overlay, DRC marker glyphs, routing preview, snapping.

### A9 · QA & CI agent
- GitHub Actions: build fork in Docker, cache it, run conformance + Playwright UI
  tests on every PR; publish `api-coverage.md` as a status badge.
- Owns fixtures beyond kitchen-sink (a real multi-sheet project, a large board).
- Exit: red/green on every PR in < 15 min; coverage number in the README.

## Contracts between agents (the only things that are allowed to block)

| Producer → Consumer | Artifact | Ready by |
|---|---|---|
| A2 → A4 | `packages/proto` build, `commands.json` | end of wave 1 |
| A3 → A4, A8 | `Transport` interface + `WebSocketTransport` | end of wave 1 |
| A4 → A5, A6, A8 | item wrappers + `ItemStore` diff events | wave 2, week 1 |
| A5/A6 → A8 | `CanvasHost` contract | wave 2, week 1 |
| A7 → A2 → A4 | proto changes regenerate; conformance test per gap | per patch |
| A9 ← all | test hooks: every package exposes `bun test` | continuous |

## Agent count and shape

- 9 agents + coordinator. Fewer than that and A7 (the C++ work) and A8 (the UI)
  become bottlenecks; more and the contracts churn.
- A7 is the only agent that needs C++/wxWidgets/KiCad-internals skill and a full
  KiCad build; give it the most compute and the longest-lived session.
- A5 and A6 share a base (`packages/renderer/core`); A5 builds it, A6 starts one
  week later on top of it.
- Every agent's first task is to write its own `README.md` with the contract it
  implements, and its last task each wave is to update this file's exit status.
