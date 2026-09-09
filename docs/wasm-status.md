# KiCad as WebAssembly — status, 2026-09-09

KiCad's headless API core is compiled to WebAssembly and answers the same protobuf envelope the
`kicad-cli api-server` does. Under `KICAD_TRANSPORT=wasm` the conformance suite scores **150 of 153
headless commands — identical to the native build** — and the three failures are the same three the
native host has. The bridge runs a session as a module in a Worker; `apps/web` runs KiCad in the tab
and renders the kitchen-sink board with no server anywhere.

Everything is on the branch `wasm` in both repos. Nothing is pushed and nothing is tagged — see
[Housekeeping](#housekeeping-for-you-to-decide).

## What exists

**Fork (`tensorfleet/kicad`, branch `wasm`, 31 commits on top of `web-api`)**

- `KICAD_HEADLESS_API` (CMake option, default OFF): splits the GUI out of `kicommon`/`common`/`gal`,
  links the pcbnew and eeschema kifaces statically into one image, runs the thread pool and the job
  registry inline, and drops nng, libgit2, Cairo, Fontconfig, OpenCascade, curl, ngspice and the
  renderers. With the option OFF the object set is byte-identical to today's build.
- `host/` — `KICAD_API_HOST` (the seven lifecycle hooks lifted out of `command_api_server.cpp`), the
  `kiapi_*` C ABI (`kicad_api_c.cpp`), the native stdio binary (`main_native.cpp`), the Emscripten
  entry point (`host/wasm/main_wasm.cpp`), and `host/wx_headless/` — real `wxColour` / `wxImage` /
  `wxPGChoices` for a wxBase-only link, plus the `wxUSE_GUI` header shim.
- `tools/wasm/` — `build-deps.sh` (wxWidgets 3.2.11 base-only, protobuf 36.1 + abseil, zstd, and an
  81-check smoke test), `configure.sh`, `gen_wasm_link_stubs.py` (the 71 data stubs wasm-ld cannot
  synthesise), `check_wx_abi.sh`.

**fab_pcb (branch `wasm`, 19 commits on top of `main`)**

- `@fp-pcb/client`: `StdioTransport`/`StdioSubscriber` and `WasmTransport`/`WasmSubscriber`. The
  `Transport` interface did not change.
- `@fp-pcb/kicad-wasm`: the loader over the `kiapi_*` ABI, MEMFS helpers (`mountProject`,
  `exportDir`, `DirMirror`), `bun run fetch` to copy a build into `dist/`.
- The conformance harness picks a backend with `KICAD_TRANSPORT`; the suites only see `RunningKiCad`.
- `@fp-pcb/bridge`: `SESSION_BACKEND=wasm` runs each session as a module in its own Bun `Worker`.
- `apps/web`: `?wasm=1` runs KiCad in the tab, with a file picker that imports a project into MEMFS.

## Building it

```sh
# --- the native gate (an hour the first time, minutes after) -----------------
cmake -S . -B build/headless -G Ninja -DCMAKE_BUILD_TYPE=Release -DKICAD_HEADLESS_API=ON ...
ninja -C build/headless -j10 kicad-api-host-native      # -> build/native-host/kicad-api-host-native
./build/native-host/kicad-api-host-native --selftest qa/data/pcbnew/api_kitchen_sink.kicad_pcb

# --- the wasm module ---------------------------------------------------------
tools/wasm/build-deps.sh          # wx + protobuf + abseil + zstd for wasm32, ~30 min, idempotent
tools/wasm/configure.sh           # emcmake; needs build/headless for lemon and brew protoc 36.1
ninja -C build/wasm -j10 kicad_api   # -> build/wasm/host/kicad_api.{js,wasm}, ~50 min from clean
```

Two traps that cost hours and are worth re-reading before touching the build: never run two `ninja`
processes in one build dir (it corrupts `.ninja_deps` and every later load rebuilds all 1100 TUs),
and `tools/wasm/regen_wasm_link_stubs.sh` must be re-run after any change that adds a definition —
a stale data stub silently shadows the real symbol. Details in `kicad/host/STATUS-wasm-build.md`.

## Running it

```sh
# conformance, one line per backend
KICAD_CLI=../kicad/build/dev/kicad/KiCad.app/Contents/MacOS/kicad-cli bun run --cwd packages/client test:conformance
KICAD_TRANSPORT=stdio bun run --cwd packages/client test:conformance
KICAD_TRANSPORT=wasm KICAD_WASM_DIR=../kicad/build/wasm/host bun run --cwd packages/client test:conformance

# the module on its own (Ping/GetVersion through kiapi_dispatch) and two instances at once
KICAD_WASM_DIR=../kicad/build/wasm/host bun test --cwd packages/kicad-wasm

# the bridge, every session a module in a worker
SESSION_BACKEND=wasm KICAD_WASM_DIR=../kicad/build/wasm/host bun run --filter @fp-pcb/bridge start
KICAD_WASM_DIR=../kicad/build/wasm/host bun test --cwd packages/bridge test/session-wasm.kicad.test.ts

# KiCad in the tab
bun run --filter @fp-pcb/kicad-wasm fetch      # copies the build into packages/kicad-wasm/dist
bun run --filter @fp-pcb/app dev               # then open http://localhost:5173/?wasm=1

# the three backends side by side, by hand
bun packages/client/test/bench-drc.ts
```

`KICAD_CLI` matters: without it the suites silently use the stale `build/release` binary and the
integration tests fail for reasons that have nothing to do with this work.

## The numbers

Conformance is 168 commands (153 headless + 15 gui-only, which every headless backend skips) plus
6 extra checks. Measured on this machine, idle.

|                                | `ipc` (kicad-cli)              | `stdio` (native host)           | `wasm`                                                                      |
| ------------------------------ | ------------------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Conformance                    | **177/177** (153/153 headless) | **150/153** headless, 6/6 extra | **150/153** headless, 6/6 extra                                             |
| Conformance wall time          | ~5 min                         | ~2 min                          | **63 s** (both files)                                                       |
| Open project + board           | 392 ms                         | 65 ms                           | **115 ms**                                                                  |
| DRC, kitchen sink (11 markers) | 69 ms                          | 65 ms                           | **77 ms** (first run 108 ms)                                                |
| Ping, mean of 200              | 0.052 ms                       | 0.031 ms                        | **0.006 ms** raw dispatch (0.19 ms through the test harness's MEMFS mirror) |

Module and lifecycle:

|                                                 |                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `kicad_api.wasm` / `kicad_api.js`               | **37.4 MB** / 224 KB, no `.data` bundle                                         |
| `createKiCadWasm()`                             | **104 ms** under Bun; 143 ms in a warm browser tab                              |
| First browser load                              | 37 MB fetched and instantiated in **564 ms** over localhost                     |
| Mounting KiCad's share tree (185 files, 5.6 MB) | 16 ms                                                                           |
| Bridge `POST /sessions` → running and pinged    | **255 ms**                                                                      |
| RSS per instance                                | +346 MB for the first, +209 MB for the second; 744 MB with a board open in each |

Isolation (`packages/kicad-wasm/test/isolation.kicad.test.ts`): two instances in one Bun process,
each with a different board at a different absolute path, answer `GetOpenDocuments` independently,
neither can `stat` the other's tree, and shutting one down leaves the other answering while the dead
one throws rather than touching a freed heap.

Browser (verified by hand against the real 37 MB module, not the mock): `?wasm=1` loads the module,
the file picker imports `api_kitchen_sink.kicad_pro` + `.kicad_pcb` into MEMFS, KiCad opens both,
and the board renders — 6 footprints, 71 pads, the DRC panel live.

## Known failures, with root causes

Three, all in the module, all also failing on the native host — so none of them is an Emscripten or
MEMFS problem:

1. **`RunSchematicJobExportBOM`** — `FIELDS_TABLE_DATA_MODEL_BASE` derives from `wxGridTableBase`,
   which a wxBase-only link does not have. In wasm it surfaces as the Emscripten stub trapping with
   the constructor's own mangled name (`_ZN28FIELDS_TABLE_DATA_MODEL_BASEC2Ev`) — exactly the
   diagnostic the design wanted from `-sERROR_ON_UNDEFINED_SYMBOLS=0`. An `abort()` kills the
   instance, so the harness restarts the module and carries on.
2. **`RunBoardJobExport3D`** — "3D model export is not available in this build"; OpenCascade is not
   in the headless link.
3. **`RunBoardJobExportRender`** — "3D rendering is not available in this build"; the 3D viewer is
   not built.

Fixed tonight, for the record: the 25-command gap between wasm (125/153) and stdio (150/153) was
**not** the module. Every failing command wrote a file, the file landed in the module's MEMFS, and
the test stat'ed the host path. `DirMirror` + `MirroringWasmTransport` now mirror the suite's
directories in both directions around every request, and the gap is gone.

Non-blocking noise: opening a project logs two wx asserts per instance
(`wxString::Last(): index out of bounds`, `wxArrayString::Remove: bad index`). They are harmless
today, but they are the loudest unexplained thing in the log.

## Commits

`kicad`, `git log --oneline web-api..wasm` (31, newest first):

```
<this report>  docs: host/STATUS.md, the consolidated wasm status
8b8a65ebbc wasm: host/STATUS-wasm-build.md
d4719b5450 wasm: link the module -- the freetype port has setjmp variants and find_package picks the wrong one
8376472d4d wasm: real values for the five plain-data globals the link is missing
2e4163b854 wasm: generate the DATA half of the headless GUI stubs for wasm-ld
c23b19cbd3 wasm: three transitive-include fixes the GUI-enabled wx header chain used to hide
ea9a9423b5 wasm: compile KiCad against the full wx header set with a wxUSE_GUI shim
af1d93ff48 Host: qa_api is 162/162 on the wasm-prep branch, option-OFF tree rebuilt clean
4bd3e4387d Host: note where the qa_api rebuild stood at hand-off
b63dda574a Host: record the wasm-prep gate and what the Emscripten build still faces
19be4b8755 Headless: no wxSafeYield on the board plot path
efde1d3571 Headless: link against wxBase only, with real wxColour and wxImage
dccb95c31b Headless: an in-tree wxPGChoices for the wxBase-only build
3b439cc27c Headless: drop nng, libgit2, Cairo and Fontconfig from the headless link
656ad327a7 Host: qa_api is green against the job registry change (162 cases)
8c7ff0dd01 Host: record that qa_api still needs a run against the job registry change
2e9ffe9aec Host: note the option-OFF regression check in the gate status
9882935ed7 Headless: drop the DRC rule editor, and size the wx shim
84f8c8c4b6 Headless: deferred inline jobs, whole-archive linking, and two exporters lifted out of their dialogs
add9377a89 Headless: put the non-GUI half of the API path back in the build
f659f439e1 Host: an in-process API host, a C ABI, and the native stdio binary
12efcc0288 Headless: record the build status
f0e84ad8c0 Headless: let KIWAY find a KIFACE that is linked into the image
8b0e34f1e8 Headless: inline job execution, pgm_base guards, and cross-kiface ODR fixes
0a642082c6 Headless: run thread pool tasks inline
f9794962e0 Headless: keep the option-OFF build byte-identical
77fb4216dd API: Extract API_SERVER_HOST from the kicad-cli api-server command
3e875a479b API: Add an in-process dispatch seam to KICAD_API_SERVER
b83e3960f9 Headless: link the pcbnew and eeschema kifaces statically into one image
98ace7e983 wasm: dependency build script
20475e3aa2 Headless: add KICAD_HEADLESS_API and split the GUI out of the core libraries
```

`fab_pcb`, `git log --oneline main..wasm` (19, newest first):

```
<this report>  docs: one consolidated wasm status, with the numbers
de0c08c client: a hand-run benchmark for the three backends
2869437 web: replay imported files into every wasm instance, and stub node's rm
886ef24 bridge: an integration test for the wasm backend against the real module
6f177e8 kicad-wasm: two instances in one process, each with its own MEMFS
2ac6158 client: mirror the wasm backend's MEMFS around every conformance request
dea137f kicad-wasm: DirMirror, a two-way MEMFS/host mirror for one directory
d5d0837 client: close the wasm transport when the module aborts
b9702f0 bridge: record the kicad-wasm workspace deps in the lockfile
b62b92b docs: the bridge's wasm backend and the in-browser mode
bf9fb1b web: run KiCad in the tab as WebAssembly
abaabcb bridge: run a session's KiCad as wasm in a Worker
a6c0acd docs: conformance is 177/177 on an idle machine
7b1efbc ci: check the backend's own variable in integration mode
015e375 docs: wasm status after WT1-WT3
2515807 client: report the stdio events channel synchronously
326f307 conformance: pick the KiCad backend with KICAD_TRANSPORT (WT3)
d2355f6 kicad-wasm: new @fp-pcb/kicad-wasm loader package (WT2)
e175cd7 client: add StdioTransport and WasmTransport (WT1)
```

One commit is mislabelled, and it is recorded in `kicad/host/STATUS-seams.md`: the move of
`PROJECT_TEMPLATE` to `include/project_template.h` + `common/project_template.cpp` and the
`COMMON_SRCS` additions belong to the seams work (`77fb4216dd`), but a `git add -A` swept them into
`20475e3aa2` "Headless: add KICAD_HEADLESS_API…". The content is correct, only the attribution is
wrong. Worth a line in the MR description if any of this is ever proposed upstream.

## Follow-ups, in priority order

1. **Split `FIELDS_TABLE_DATA_MODEL_BASE`** so the BOM export has a data model that does not derive
   from `wxGridTableBase`. It is the only one of the three failures fixable in KiCad's own source,
   it fixes the native host too, and it removes the one command that kills an instance.
2. **A Worker for the browser mode.** `apps/web` runs `kiapi_dispatch` on the main thread, so a slow
   command freezes paint. The seam exists (`WasmModeOptions.createInstance`) and the bridge's
   `wasm-worker.ts` is the model to copy.
3. **Fontconfig manifest for outline fonts.** KiCad's fontconfig wrapper is stubbed, so only stroke
   fonts resolve. A JSON manifest of font files mounted into MEMFS, read by a replacement for the
   stub, would make outline text plot correctly.
4. **A real PNG decoder for reference images.** `host/wx_headless/wx_image.cpp` reads geometry out
   of the container header (PNG `IHDR`, JPEG `SOFn`, BMP, GIF) and leaves the raster blank. Boards
   round-trip byte for byte because `BITMAP_BASE` keeps the undecoded bytes, but nothing can render
   or plot the image. Emscripten's libpng port is the cheap route.
5. **Shrink the 37 MB module.** Nothing has been tried yet: no `-Os` on the cold half, no
   `--gc-sections` audit, no split between the board and schematic kifaces, no Brotli at the CDN
   (which alone should get the wire size well under 10 MB).
6. **Flip `-sERROR_ON_UNDEFINED_SYMBOLS=0` off** (`KICAD_WASM_ALLOW_UNDEFINED=OFF`). 792 functions
   are still imported as throwing stubs; each one is a command that will abort an instance if it is
   ever reached. Sorting them by "reachable from a headless API handler" is the useful first pass.
7. **pthreads.** Single-threaded was the right call for the first build, but DRC and zone fill are
   the two things a user waits on and both are parallel natively. `-pthread` needs COOP/COEP headers
   on the app and a real thread pool instead of the inline façade.
8. **The pre-existing `format:check` failures** — 159 files, none of them touched by this work.
   Either run `bun run format` once across the repo or narrow the prettier glob; today the check is
   useless because it is always red.
9. **The two wx asserts** logged on every project open (see above), and the `ToProtoEnum<FILL_T>`
   assertion the browser log fills with. These are not wasm regressions: the Homebrew wxWidgets is
   built with `-DwxDEBUG_LEVEL=0`, so the native build compiles the same checks out and never
   reports them. `tools/wasm/env.sh` now passes `-DwxDEBUG_LEVEL=0` for KiCad's own TUs (takes
   effect at the next module build); the `FILL_T` value that is out of range on the ecc83 board is
   still worth finding with a native `wxDEBUG_LEVEL=1` build.
10. **The module is loaded twice per project open in the browser.** `importProjectFiles()` writes
    into the instance loaded at startup (for `GetVersion`), and `connect()` then creates a fresh
    module and replays the imports. Reusing the first instance would halve the 37 MB fetch.

## Housekeeping (for you to decide)

- Nothing is pushed. Both `wasm` branches are local: `kicad` is 31 commits ahead of `web-api`,
  `fab_pcb` is 19 ahead of `main`.
- Nothing is tagged. The `fp-pcb/<date>-<name>` scheme wants a tag on both repos at a change set
  this size — `fp-pcb/2026-09-09-wasm` is the obvious name, but that is your call, not mine.
- `packages/kicad-wasm/dist/` now holds a 37 MB `kicad_api.wasm` (from `bun run fetch`). It is
  ignored by git; decide whether a build artefact that large should ever be committed, or whether
  the app should fetch it from a CDN.

---

# Log

The notes below are what each agent wrote as it finished; they are kept for the detail the summary
above drops.

## ts-side

TypeScript side (branch `wasm`, agent `ts-side`), 2026-09-09.

- **WT1 done** — `StdioTransport`/`StdioSubscriber` (spawn the native host, `uint32be` frames on
  stdin/stdout, events on fd 3, replies matched by order) and `WasmTransport`/`WasmSubscriber`
  (in-process, microtask-queued dispatch, events raised during a dispatch flushed after that reply).
  21 unit tests against a fake stdio host and a fake instance.
- **WT2 done** — `@fp-pcb/kicad-wasm`: `createKiCadWasm()` (the `kiapi_*` ABI, `__kiapiEvent` wired
  before init, heap copies, `kiapi_last_error` surfaced), MEMFS helpers (`mountProject`/`mountPath`/
  `exportDir`), `bun run fetch` into `dist/`. 11 unit tests against a JS mock of the ABI;
  `test/wasm.kicad.test.ts` runs Ping/GetVersion and skips until a build exists.
- **WT3 done** — `KICAD_TRANSPORT=ipc|stdio|wasm` selects the backend inside `startKiCad()`; the
  suites use `RunningKiCad` only (`subscribe()`, `secondTransport()`, `server.eventsUrl`). A missing
  backend binary skips with the variable to set. Contract for the C++ side: `docs/08-wasm.md`.
- **Verified** — `bun run test:unit` 10/10 packages green; `KICAD_TRANSPORT=ipc` conformance with the
  dev `kicad-cli`: **177/177**, 153/153 headless commands, 15 gui-only skips, 6/6 extra checks (a
  first run scored 176/177 with 3 event-sequence gaps while another agent was building KiCad at load
  100+ — nng pub/sub drops frames behind a stalled subscriber; it is green on an idle machine). The
  `stdio` and `wasm` paths of the harness were smoke-tested against fake hosts answering a canned
  `AS_OK`: both load, mount, connect and run until the fixtures' real content is needed.
- **Blocked on the C++ side** — nothing exists yet at `kicad/build/native-host/kicad-api-host-native`
  or `kicad/build/wasm/host/kicad_api.js`, so neither backend has run against real KiCad. Change
  `docs/08-wasm.md` if the build lands with different names, paths, or an `--events-fd` fallback.
- **Known wasm divergence** — files KiCad writes land in MEMFS, so conformance checks that
  `existsSync()` a job output on the host will fail until the suite exports those directories.
  _(Fixed by `finish`: `DirMirror` + `MirroringWasmTransport`.)_

## bridge-app

Bridge and app sides (branch `wasm`, agent `bridge-app`), 2026-09-09.

- **WT4a done** — `SESSION_BACKEND=wasm` (and `POST /sessions {backend}`) runs a session's KiCad as
  `kicad_api.wasm` in one Bun `Worker`: `packages/bridge/src/session-wasm.ts` (the `SessionLike`
  surface, a `Transport` over the worker port), `wasm-worker.ts` (the module, MEMFS, the flush
  policy) and `wasm-protocol.ts` (`{id,req}`/`{id,res}`/`{event}`/`{state}`, buffers transferred).
  `SessionLike` is extracted so `server.ts`, SSE and the route/compile jobs never see the backend.
- **Isolation and teardown** — the worker exists because `kiapi_dispatch` is synchronous: on the
  main thread one wedged command would freeze every session. `KICAD_REQUEST_TIMEOUT_MS` terminates
  the worker, fails everything in flight and marks the session `failed`.
- **MEMFS policy** (documented in `docs/08-wasm.md`): the project dir is mounted at the same
  absolute path from inside the module factory, i.e. before `kiapi_init` sees `preload`; it is
  exported back after `Save*` / `CloseDocument`, after a `DocumentSaved` event, on `{flush}` and on
  stop. `EndCommit` is not a trigger — a commit does not touch the file.
- **WT4b done** — `?wasm=1` / `VITE_KICAD_WASM` runs KiCad in the tab: `WasmTransport` +
  `WasmSubscriber` passed to the document service as the explicit `events` option (the
  `instanceof WebSocketTransport` checks were not widened), `bridgeless`, a file picker that writes
  the project into MEMFS under `/project`, and `stat`/`listFiles` answered from MEMFS. **Main
  thread for now** — a Worker is the follow-up, behind `WasmModeOptions.createInstance`.
- **Vite** — the build is served at `/kicad-wasm/` (dev middleware, copied into `dist/` on build);
  `node:path` and `node:fs/promises` are aliased to browser stubs because the loader's entry point
  re-exports host-disk helpers; `worker.format: "es"`, no COOP/COEP (single-threaded).
- **Verified** — `bun run typecheck`, `bun run test:unit` 10/10 (8 new bridge tests through the real
  HTTP + WebSocket path, 4 new app tests), and `vite build` green, all against the JS mock of the
  `kiapi_*` ABI. Nothing here has met a real `kicad_api.js` yet: when one lands,
  `SESSION_BACKEND=wasm KICAD_WASM_DIR=… bun run --filter @fp-pcb/bridge start` and `?wasm=1` are
  the two things to try. _(Both tried by `finish`; the app needed one fix, below.)_

## finish

Overnight wrap-up (branch `wasm`, agent `finish`), 2026-09-09.

- **Conformance 125 → 150/153.** `DirMirror` (`packages/kicad-wasm/src/fs.ts`) mirrors one directory
  between the host and MEMFS with a size+mtime signature per entry, directories included, deletions
  included. `MirroringWasmTransport` in `packages/client/test/kicad-server.ts` brackets every
  request with it — host wins going in, MEMFS wins coming out — for the directories the suite owns
  (only under the OS temp dir, so KiCad's QA data stays read-only). `CreateLibrary` was the one case
  that needed directory mirroring: it creates an empty `conf_fp.pretty/`.
- **Isolation test** — `packages/kicad-wasm/test/isolation.kicad.test.ts`, numbers above.
- **Bridge against the real module** — `packages/bridge/test/session-wasm.kicad.test.ts`: session
  ready in 255 ms, 6 footprints over the WebSocket through the ordinary client model, `SaveDocument`
  flushed back to the workspace (400 780 → 401 542 bytes), `DELETE` stops the worker. The existing
  `session-wasm.test.ts` keeps running against the JS mock; its assertions are mock-specific, so it
  is not worth re-pointing at a real build.
- **App** — two fixes were needed before `?wasm=1` could open anything (`2869437`): the browser stub
  for `node:fs/promises` had no `rm`, so `vite build` failed; and the file picker wrote the project
  into the _current_ module's MEMFS, which `connect()` then replaced with a fresh module — imports
  are now replayed into each new instance. After that, the real 37 MB module renders the kitchen
  sink in the tab. No Playwright harness exists, so this was driven by hand in a browser.
- **`bun test --cwd packages/bridge`** shows 15 failures without `KICAD_CLI` pointing at
  `build/dev`; with it, `bridge.kicad.test.ts` is 16/16. That is the stale `build/release` binary,
  not this work.
