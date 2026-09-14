# 01 — Architecture: a headless KiCad web UI over the IPC API

## What we are building on

KiCad 10.99 (the development branch that becomes v11; this plan was written against
commit `cbd303d16b`) ships a protobuf-over-nng IPC API and, new in 10.99, a headless
server mode:

```
kicad-cli api-server [PROJECT_OR_FILE] [--socket SOCKET_PATH]
```

Facts that shape every decision below (all verified in the KiCad sources):

| Fact                                                                                                                                                                              | Where                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Transport is nng **REQ/REP v0** over a **unix-domain socket**, URL `ipc://<path>`. No TCP, no WebSocket today.                                                                    | `libs/kinng/src/kinng.cpp`, `common/api/api_server.cpp` |
| Default socket: `/tmp/kicad/api.sock` on macOS, `$TMPDIR/kicad/api.sock` elsewhere. `--socket` overrides the _path_ only; the scheme is hard-coded to `ipc://`.                   | `api_server.cpp:77-96`                                  |
| Wire payload is `kiapi.common.ApiRequest { header{kicad_token, client_name}, google.protobuf.Any message }` → `ApiResponse { header, status{code, error_message}, Any message }`. | `api/proto/common/envelope.proto`                       |
| Every command is a protobuf message; the server dispatches on the `Any` type URL. 111 request messages are defined; 92 work headless, 15 are GUI-only, 3 are never registered.    | [api-coverage.md](api-coverage.md)                      |
| Headless server holds **one project** at a time, with up to one schematic, one board, and any number of footprint documents.                                                      | `kicad/cli/command_api_server.cpp`                      |
| Requests are executed on the wx main thread, serially. Long jobs (gerbers, STEP) block the socket until done.                                                                     | `KICAD_API_SERVER::onApiRequest` → wx event             |
| There is **no server→client push**. REQ/REP only.                                                                                                                                 | no `nng_pub0` anywhere in the tree                      |
| Commits (BeginCommit/Create/Update/Delete/EndCommit) work headless: `BOARD_COMMIT(toolManager, true, false)` is used when no frame exists.                                        | `pcbnew/api/api_handler_board.cpp:134`                  |
| Zone filling works headless (registers `ZONE_FILLER_TOOL` on the bare headless `TOOL_MANAGER` on first use). This is the pattern to copy for other tools.                         | `api_handler_pcb.cpp:1690`                              |
| The installed `/Applications/KiCad` is 10.0.4 and has **no** `api-server` command. We must build 10.99 from this checkout.                                                        | `kicad-cli --help`                                      |
| All geometry is int64 nanometres (`Distance.value_nm`), angles in degrees (`Angle.value_degrees`).                                                                                | `base_types.proto`                                      |

## System shape

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (apps/web)                                                 │
│  React shell ─ panels ─ command palette ─ properties ─ DRC/ERC     │
│  @fp-pcb/renderer (WebGL2: board + schematic scene graphs)      │
│  @fp-pcb/client  (typed KiCad API, document model, commits)     │
│  @fp-pcb/proto   (protobuf-es codegen of api/proto)             │
└───────────────▲────────────────────────────────────────────────────┘
                │ WebSocket, binary frames = ApiRequest / ApiResponse bytes
┌───────────────┴────────────────────────────────────────────────────┐
│ Bridge (packages/bridge, Bun)                                 │
│  • speaks nng SP framing on the unix socket (no native deps)       │
│  • spawns/supervises `kicad-cli api-server`, one per session       │
│  • serialises requests (REQ/REP is strictly one in flight)         │
│  • file browser, project open/new, static hosting of the SPA       │
│  • later: PUB event fan-out once KiCad gains an event socket       │
└───────────────▲────────────────────────────────────────────────────┘
                │ ipc:///tmp/kicad/api-<session>.sock
┌───────────────┴────────────────────────────────────────────────────┐
│ kicad-cli api-server  (our fork of KiCad 10.99 + patch series)     │
│  API_HANDLER_COMMON + API_HANDLER_PCB(headless) + API_HANDLER_SCH  │
└────────────────────────────────────────────────────────────────────┘
```

Why a bridge instead of the browser talking to KiCad directly: browsers cannot open
unix sockets. Two ways out, and we do both in order:

1. **Bridge first (no KiCad patch needed).** nng's IPC framing is simple enough to
   implement in ~150 lines of TypeScript on Bun (`Bun.connect` on the unix socket):
   - on connect, each side sends an 8-byte header `00 'S' 'P' 00 <proto BE16> 00 00`
     (REQ0 = `0x30`, REP0 = `0x31`);
   - each message is a 9-byte header (type byte `0x01` + 8-byte big-endian length) followed by the body;
   - REQ0 bodies start with a 4-byte request id with the top bit set, and the reply
     echoes that id before the `ApiResponse` bytes.
     Reference: `include/api/api_client.h` / `common/api/api_client.cpp` is the C++
     client we mirror; `qa/tests/api/api_e2e_utils.h` shows the full round trip.
2. **Direct WebSocket later (patch G15).** nng has a `ws://` transport compiled in
   (`/opt/homebrew/opt/nng/include/nng/transport/ws`). A one-line change letting
   `--socket` accept a full URL lets the browser dial `ws://127.0.0.1:PORT` with
   subprotocol `rep.sp.nanomsg.org` and drop the bridge for the request path. The
   bridge stays for process supervision and file access.

## Session model

- One bridge process serves many browser tabs; each **session** owns one
  `kicad-cli api-server` process (one project). Multi-project = multi-process.
  This sidesteps KiCad's one-project-per-server limit without touching KiCad.
- The bridge tags every request with `client_name = "fp-pcb/<session>/<tab>"`.
  KiCad keys in-flight commits by `client_name`, so one commit per tab is possible.
- `kicad_token` from the first `GetVersion`/`Ping` is pinned; a mismatch means the
  server restarted and the UI reloads the document.
- A session's KiCad does not have to be a process. `SESSION_BACKEND=wasm` gives it
  one `kicad_api.wasm` instance in a worker thread instead, and `?wasm=1` puts the
  same module in the browser tab with no bridge at all. Both keep the shape above —
  one session, one project, one token — and trade the OS process boundary for a
  sandbox with no sockets, no host disk and no `exec`. See `docs/08-wasm.md`.

## Document model in the browser

The UI does not re-fetch the whole board on every change. It keeps a local
**item store** keyed by KIID, populated by `GetItems` per `KiCadObjectType`, and
mutates it optimistically inside a commit:

```
BeginCommit → (CreateItems | UpdateItems | DeleteItems)* → EndCommit(CMA_COMMIT | CMA_DROP)
```

`UpdateItemsResponse` returns the server's canonical item; the store replaces the
optimistic copy with it. Until KiCad has an event socket (gap G1) the store's
authority is "last response wins" plus a cheap revision poll: `GetOpenDocuments` +
`GetBoundingBox`/item-count fingerprint every few seconds when idle.

Undo/redo has no API. v1 keeps history client-side: every committed change records
the inverse `UpdateItems`/`DeleteItems`/`CreateItems` set, replayed as a new commit.
Snapshot fallback for big edits: `SaveDocumentToString` before, re-parse via
`ParseAndCreateItemsFromString` after. Server-side undo is gap G10.

## Repo layout (Bun workspaces, dedicated repo)

```
fp-pcb/
  apps/web/                 Vite + React SPA
  packages/proto/           buf.gen.yaml → generated protobuf-es TS from ../kicad/api/proto
  packages/client/          transport-agnostic KiCad client + document model
  packages/bridge/          Bun: nng-ipc ↔ WebSocket, process supervisor, file API
  packages/renderer/        WebGL2 scene, layer stack, colour themes, hit testing
  packages/kicad-patches/   patch series against the KiCad fork + build scripts
  tooling/coverage/         script that diffs .proto requests vs registerHandler (source of api-coverage.md)
  e2e/                      Playwright + api-server conformance suite (uses qa/data/*/api_kitchen_sink.*)
  docs/                     this plan
```

The KiCad fork lives in its own repo/branch (`kicad`, branch `main`); `fp-pcb`
pins the fork commit it was generated against in `packages/proto/KICAD_COMMIT`.

### Alignment tags (rule)

Every major change set on the fork gets an annotated tag `fp-pcb/<yyyy-mm-dd>-<name>`, and the
same tag goes on this repo at the commit whose bindings were regenerated from it. `bun run gen`
records the tag in `packages/proto/KICAD_TAG` (or `untagged`), so the alignment point is visible
from either side without cross-referencing hashes. Procedure after landing a batch on the fork:

```bash
git -C ../kicad tag -a fp-pcb/2026-09-07-name <commit> -m "what the batch adds"
cd packages/proto && bun run gen && cd ../.. && bun run coverage && (cd packages/client && bun run gen)
git commit -am "Regenerate bindings at fp-pcb/2026-09-07-name" && git tag -a fp-pcb/2026-09-07-name -m "aligned with the fork tag"
```

| Fork tag                    | Fork commit | What it marks                                                           |
| --------------------------- | ----------- | ----------------------------------------------------------------------- |
| `fp-pcb/2026-09-06-p0`      | 1ca7f148a5  | P0 gaps: discovery, wake-up loop, events, lifecycle, DRC/ERC            |
| `fp-pcb/2026-09-06-p1`      | 022e45f6d2  | conformance fixes, headless actions, paging, async jobs, clipboard      |
| `fp-pcb/2026-09-07-parity`  | 163dec0e39  | libraries, schematic/board ops, undo, settings, transports, render data |
| `fp-pcb/2026-09-07-qa`      | ab43ac2538  | QA suite compiled and run; six product bugs                             |
| `fp-pcb/2026-09-07-drc`     | a99a1a803e  | DRC provider fix, async DRC, theme keys                                 |
| `fp-pcb/2026-09-07-routing` | 8cc9377988  | Specctra export/import for autorouters                                  |

## Milestones

| #                | Milestone                                                                                                                                                     | Exit criterion                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 ✅ 2026-09-06 | Build `kicad-cli` from this 10.99 checkout on macOS; `Ping` from a Bun script over the raw socket.                                                            | done: see [m0-runbook.md](m0-runbook.md); `Ping`, `GetVersion`, `OpenDocument`, `GetOpenDocuments` all `AS_OK`                                                                                 |
| M1 ✅            | Codegen + bridge + client: open the kitchen-sink project from the browser, `GetVersion`, `GetOpenDocuments`, `GetItems(FOOTPRINT)`.                           | done 2026-09-06                                                                                                                                                                                |
| M2 ✅            | Read-only board viewer and schematic viewer (WebGL), layer panel, pan/zoom, hover/hit-test, net highlight (client-side).                                      | done 2026-09-06: see docs/screenshots/board.png, schematic.png                                                                                                                                 |
| M3 ✅            | Editing: selection, move/rotate/flip, properties panel, create/delete, commits, client-side undo.                                                             | done 2026-09-06: property edit committed, verified via SaveDocumentToString, undone (board-edited.png)                                                                                         |
| M4 ✅            | Patch series P0 landed in the fork: events, headless RunAction, DRC/ERC, new project/document, capability discovery. DRC/ERC panels live.                     | done 2026-09-06: all P0 gaps closed; markers drawn on the canvas (board-drc-markers.png)                                                                                                       |
| M5 ✅            | Libraries, annotate, schematic→board sync, exports/jobs UI, 3D via GLB export + three.js.                                                                     | done 2026-09-07: library browser on the real fp-lib-table, annotate, update-PCB, 13 export jobs, three.js 3D (library-browser.png, board-3d.png)                                               |
| M6 ◐             | P1 parity, `ws://` direct transport, upstream MRs for every patch.                                                                                            | parity and direct ws:// done 2026-09-07 (165 commands, 150 headless, 0 the UI needs); the ten merge requests are described in [upstream.md](upstream.md) but not yet submitted                 |
| M7 ✅            | Real-board practice and routing: five demo boards built, routed and exported through the web UI; Freerouting and a JavaScript router integrated and compared. | done 2026-09-07: 12/12 steps on all five boards, six renderer/app bugs fixed ([board-practice.md](board-practice.md)); both routers benchmarked ([router-comparison.md](router-comparison.md)) |
