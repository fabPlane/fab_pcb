# 08 — KiCad in WebAssembly (and the native stdio host)

Goal: run KiCad's headless API core **in the same process as the TypeScript stack** — in Bun today,
in a browser tab tomorrow — instead of talking to a `kicad-cli api-server` over a socket. Everything
above Layer 1 stays exactly as it is: the same `ApiRequest`/`ApiResponse` envelope, the same
`KiCadClient`, the same model and store. Only the transport changes.

Three backends now exist side by side, and the conformance suite runs against any of them:

| Backend | What runs KiCad                     | Transport         | Selected with                   |
| ------- | ----------------------------------- | ----------------- | ------------------------------- |
| `ipc`   | `kicad-cli api-server` (a process)  | `NngIpcTransport` | `KICAD_TRANSPORT=ipc` (default) |
| `stdio` | `kicad-api-host-native` (a process) | `StdioTransport`  | `KICAD_TRANSPORT=stdio`         |
| `wasm`  | `kicad_api.wasm` (this process)     | `WasmTransport`   | `KICAD_TRANSPORT=wasm`          |

`stdio` is the gate: the same API core, the same envelope, the same "one request in flight"
semantics as the wasm module, but built natively — so a failure there is a KiCad problem and a
failure only in `wasm` is an Emscripten/MEMFS problem.

## Architecture

```
@fp-pcb/client  KiCadClient / model / store          unchanged
                    |
       Layer 1  Transport.send(bytes) -> bytes
       +--------+--------------+------------------+
       |        |              |                  |
  NngIpc     NngWs        Stdio                Wasm
  (socket)  (socket)   (pipes, fd 3)   (in-process, @fp-pcb/kicad-wasm)
                             |                    |
                   kicad-api-host-native      kicad_api.js + .wasm
                             \                  /
                              KiCad API core (the same C++)
```

`@fp-pcb/kicad-wasm` owns the module: it loads `kicad_api.js`, installs the event callback, calls
`kiapi_init`, and exposes `dispatch` / `onEvent` / `shutdown` plus MEMFS helpers. `@fp-pcb/client`
never imports it — `WasmTransport` takes a `KiCadWasmInstance` interface.

## The C ABI (wasm)

```c
int         kiapi_init(const char* configJson);                          // 0 = ok
uint8_t*    kiapi_dispatch(const uint8_t* req, size_t len, size_t* outLen);
void        kiapi_free(void* p);
void        kiapi_shutdown(void);
const char* kiapi_last_error(void);
```

- `kiapi_dispatch` takes serialized `kiapi.common.ApiRequest` bytes and returns malloc'd serialized
  `ApiResponse` bytes; the caller writes the length through `outLen` and releases the buffer with
  `kiapi_free`. Returning `NULL` means "see `kiapi_last_error()`"; a KiCad-level failure should
  still be a well-formed `ApiResponse` with a non-`AS_OK` status, exactly as on the socket.
- `configJson`:
  ```json
  {
    "home": "/home/kicad",
    "share": "/kicad/share",
    "env": { "KICAD10_FOOTPRINT_DIR": "/kicad/share/footprints" },
    "preload": "",
    "token": "",
    "publishEvents": true
  }
  ```
  `home` is a writable MEMFS directory for KiCad's settings, `share` the (read-only) share tree,
  `env` extra environment variables to set before KiCad initialises, `preload` a MEMFS path to open
  at startup (or `""`), `token` a fixed API token (or `""` to generate one).
- **Events**: the module calls `Module.__kiapiEvent(bytes)` with one serialized
  `kiapi.common.events.Event` — the same frames the pub socket carries. The loader installs the
  callback _before_ `kiapi_init`. The bytes may be a view into the heap; the loader copies them.
- `GetServerInfo` reports `socket_url = "inproc://kicad"` and
  `events_socket_url = "inproc://kicad-events"`.

Emscripten flags the loader assumes: `MODULARIZE`, `EXPORT_ES6`, `EXPORT_NAME=createKicadApi`,
`EXPORTED_RUNTIME_METHODS=HEAPU8,FS,UTF8ToString,stringToNewUTF8`, and
`EXPORTED_FUNCTIONS=_malloc,_free,_kiapi_init,_kiapi_dispatch,_kiapi_free,_kiapi_shutdown,_kiapi_last_error`.
Exports without the leading underscore are accepted too. Build output is expected in
`kicad/build/wasm/host/` as `kicad_api.js` + `kicad_api.wasm` (+ an optional `kicad_api.data`
`--preload-file` bundle for the share tree).

Re-entrancy: the module is single-threaded and `kiapi_dispatch` is synchronous, so `WasmTransport`
queues requests and dispatches one at a time from a microtask, and buffers events raised _during_ a
dispatch until after that request's reply has resolved.

## The stdio framing (native host)

`kicad-api-host-native` is the same API core behind three pipes:

- **stdin** — request frames, **stdout** — reply frames, **fd 3** — event frames.
- Every frame is `uint32 big-endian length` followed by that many bytes. No other header, no
  request id.
- Payloads: `ApiRequest` on stdin, `ApiResponse` on stdout, `kiapi.common.events.Event` on fd 3.
- **Strictly one request in flight**, answered in order (REP0 semantics). `StdioTransport` matches
  replies positionally, so the host must never reorder or skip a reply; a request it cannot handle
  still gets an `ApiResponse` with a non-`AS_OK` status.
- fd 3 is opened by the parent: `Bun.spawn` takes `stdio: ["pipe","pipe","pipe","pipe"]` and exposes
  the parent-side descriptor as `proc.stdio[3]`. If the host cannot inherit fd 3 it must accept
  `--events-fd <n>`; a host with no events at all is started by the transport with `events: false`.
- Exit is the shutdown signal: closing stdin ends the process; the transport SIGTERMs, then SIGKILLs
  after 3 s.
- `GetServerInfo` reports the same `inproc://kicad` / `inproc://kicad-events` URLs as the wasm build.
- Arguments: an optional document path to preload (`kicad-api-host-native /path/board.kicad_pcb`),
  matching `kicad-cli api-server <file>`.

## The file system (wasm only)

The wasm build has no host disk. `@fp-pcb/kicad-wasm/fs` copies what KiCad must see into MEMFS:

```ts
await mountProject(wasm, "/tmp/proj"); // same absolute path inside MEMFS
await mountPath(wasm, "/…/Device.kicad_sym"); // a single file
await exportDir(wasm, "/tmp/proj/out", hostOutDir); // job outputs back to the host
```

Mounting at the _same absolute path_ is deliberate: paths inside `.kicad_pro`, `fp-lib-table` and
`sym-lib-table` stay valid, so fixtures and projects need no rewriting.

Known divergence: files KiCad writes (saves, job outputs, `.kicad_prl`, lock files) live in MEMFS
and are invisible to `existsSync` on the host, so conformance checks that assert on host files will
fail under `wasm` until they export the directory first.

## The bridge's wasm backend

`SESSION_BACKEND=wasm` makes the bridge answer a session with `kicad_api.wasm` instead of a
`kicad-cli api-server` process. `POST /sessions {"path": "...", "backend": "wasm"}` overrides it for
one session, so both backends can run side by side in the same bridge.

```
browser  --ws /ws?session=id-->  bridge main thread  --{id, req}-->  Worker
                                                     <--{id, res}--   createKiCadWasm()
                                                     <--{event}---     MEMFS
```

Everything above the session is unchanged: `Session` and `WasmSession` both satisfy `SessionLike`,
so the WebSocket frame pass-through, the SSE stream at `/sessions/:id/events`, the route and compile
jobs and the idle reaper never learn which one answered. `GET /sessions/:id` reports `backend`, a
`pid` of `null` and `socketPath: "inproc://kicad-<id>"`.

**One Worker per session, always.** `kiapi_dispatch` is a synchronous call into a single-threaded
module: on the bridge's own thread, one KiCad operation that never returns would freeze every other
session with it. In a Worker it freezes one thread, and `worker.terminate()` ends that thread whether
or not the module cooperates — the wasm answer to `SIGKILL`, and the only reason a wedged session can
be reaped at all. What it does _not_ buy is a real process boundary: the module shares the bridge's
address space and a hard Emscripten `abort()` still takes the process down.

**The message protocol** (`src/wasm-protocol.ts`), structured clone with the byte buffers
transferred:

| main → worker                                         | worker → main                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `{start}` once, then `{id, req}`, `{flush}`, `{stop}` | `{state}`, `{id, res}`, `{id, error}`, `{event}`, `{log}`, `{error}` |

**MEMFS.** The worker copies the session's project directory (the parent of `path`, resolved inside
`WORKSPACE_ROOT`) into MEMFS _at the same absolute path_, from inside the module factory — i.e. after
the Emscripten module exists but before the loader calls `kiapi_init`, so the document named in
`preload` is there when KiCad opens it.

It copies the tree back out again after:

- a request whose message name starts with `Save` (`SaveDocument`, `SaveCopyOfDocument`, …) or is
  `CloseDocument` — the envelope's `type_url` is sniffed, nothing is decoded;
- a `DocumentSaved` event, which covers saves KiCad starts by itself (a job, an action);
- an explicit `{flush}` message;
- `{stop}`, before `kiapi_shutdown`.

`EndCommit` is deliberately **not** a trigger: a commit changes the in-memory document and leaves the
file alone, so flushing there would rewrite every file in the project on every edit. A caller that
needs the workspace up to date without a save asks for a flush.

**Timeouts.** `KICAD_REQUEST_TIMEOUT_MS` is a real deadline here, not just a rejection: when it
passes, the bridge terminates the worker, fails everything in flight and marks the session `failed`
with a `server-state` broadcast — the same end state a crashed `kicad-cli` produces, minus the exit
code.

## In the browser

`?wasm=1` (or `?kicad-wasm=<url of kicad_api.js>`, `VITE_KICAD_WASM=1`, `VITE_KICAD_WASM_URL`) runs
KiCad inside the tab: no bridge, no server, no socket. `KicadSessionService` loads the module,
wraps it in `WasmTransport`, and builds a `WasmSubscriber` for the events the module publishes
in-process. That subscriber is passed to `KicadDocumentService.open()` as the explicit `events`
option — the service's default only recognises a `WebSocketTransport`, and that check stays narrow.
The session is `direct` (nothing spawns anything) and `bridgeless` unless `?bridge=` is given too,
in which case the bridge is still used for `/files/*` and the library's second server.

**Opening a project.** The tab cannot read the user's disk and neither can the module, so the project
screen shows a file picker and a drop target instead of the workspace browser: the chosen files (a
directory picker's `webkitRelativePath` is preserved) are written into MEMFS under `/project` and the
`.kicad_pro` — else the `.kicad_pcb`, else the `.kicad_sch` — is opened. `stat()` and `listFiles()`
answer from MEMFS in this mode, so a `.kicad_pro` still finds the board sitting next to it. There is
no export path yet: a save lands in MEMFS and stays there until someone downloads it.

**Main thread, for now.** The module runs on the tab's main thread, so a slow `kiapi_dispatch` blocks
paint. A Worker needs the loader's `import()` and all of MEMFS behind a message protocol, which is
exactly what the bridge backend already implements; moving the browser to the same shape is the
follow-up, and `WasmModeOptions.createInstance` is the seam it goes behind.

**The package is optional.** `KicadSessionService` reaches `@fp-pcb/kicad-wasm` through a dynamic
`import()` the first time a wasm session connects, so the mock, bridge and direct-ws builds never
bundle the loader (it is its own ~8 KB chunk), and a build with no wasm build at all succeeds with a
warning from the assets plugin — only `?wasm=1` then fails, with a message naming the package.

**Vite.** `kicad_api.js` is loaded by URL at runtime and fetches its own `.wasm` / `.data`, so it is
not bundled: `vite.config.ts` serves `packages/kicad-wasm/dist` under `/kicad-wasm/` in dev and
copies it into `dist/` on build (`KICAD_WASM_DIR` overrides the source). `node:path` and
`node:fs/promises` are aliased to browser stubs, because the loader's entry point re-exports
host-disk helpers the tab never calls but whose imports still have to resolve — the `node:path` stub
is a real POSIX implementation, since MEMFS paths are built with it. No COOP/COEP headers and no
`SharedArrayBuffer` are needed: the module is single-threaded.

## Getting the module without building it

Building `kicad_api.wasm` locally means an emscripten toolchain plus roughly 30 minutes of
dependencies and 50 of KiCad (`kicad/host/STATUS-wasm-deps.md`, `kicad/host/STATUS-wasm-build.md`).
Only the person cutting a release has to do that: the fork's `.github/workflows/wasm-release.yml`
builds the module on every pushed `fp-pcb/*` alignment tag and attaches
`kicad-wasm-<tag with / replaced by ->.tar.gz` to the GitHub release for that tag —
`kicad_api.js`, `kicad_api.wasm`, a `kicad-wasm.json` manifest (fork commit, tag, emscripten and
protobuf versions, build date, sizes) and `SHA256SUMS`.

```sh
# whatever packages/proto/KICAD_TAG pins, i.e. the fork tag the bindings came from
bun run --filter @fp-pcb/kicad-wasm fetch:release

# or a specific tag / a tarball already on disk
KICAD_WASM_RELEASE=fp-pcb/2026-09-09-wasm bun run --filter @fp-pcb/kicad-wasm fetch
KICAD_WASM_RELEASE_FILE=~/Downloads/kicad-wasm-fp-pcb-2026-09-09-wasm.tar.gz \
  bun run --filter @fp-pcb/kicad-wasm fetch
```

`fetch` verifies every file against the tarball's `SHA256SUMS` before anything reaches `dist/`, and
prints which fork commit and toolchain produced the module. The fork is private, so a download needs
`GITHUB_TOKEN` / `GH_TOKEN` (the script uses the releases API with
`Accept: application/octet-stream`) or an authenticated `gh` CLI.

A local build tree still wins when it exists: plain `fetch` copies from `KICAD_WASM_DIR` and only
falls back to a release if told to. To build it yourself, see `kicad/host/STATUS.md`:

```sh
tools/wasm/build-deps.sh                 # ~30 min, idempotent
tools/wasm/host-tools.sh                 # native lemon + protoc 36.1 (Linux; brew covers macOS)
tools/wasm/configure.sh && ninja -C build/wasm kicad_api
tools/wasm/package.sh                    # the same tarball the workflow uploads
```

## Environment variables

| Variable           | Backend | Meaning                                                                     |
| ------------------ | ------- | --------------------------------------------------------------------------- |
| `KICAD_TRANSPORT`  | all     | `ipc` (default) / `stdio` / `wasm`                                          |
| `KICAD_CLI`        | ipc     | `kicad-cli` binary                                                          |
| `KICAD_API_HOST`   | stdio   | `kicad-api-host-native` binary (default `<kicad>/build/native-host/…`)      |
| `KICAD_WASM_DIR`   | wasm    | directory with `kicad_api.js` / `.wasm` (default `<kicad>/build/wasm/host`) |
| `KICAD_WASM_SHARE` | wasm    | host share tree to mount at `/kicad/share` (when the build has no `.data`)  |
| `KICAD_WASM_RELEASE` | wasm | release tag to download instead of copying a build tree (default `packages/proto/KICAD_TAG`) |
| `KICAD_WASM_RELEASE_FILE` | wasm | a `kicad-wasm-*.tar.gz` already on disk; skips the download |
| `KICAD_WASM_REPO` | wasm | `owner/repo` holding the releases (default `TensorFleet/kicad`) |
| `GITHUB_TOKEN` / `GH_TOKEN` | wasm | token for the private fork's release assets (else an authenticated `gh`) |
| `KICAD_SRC`        | all     | the KiCad checkout (defaults to `../kicad`)                                 |

Bridge-only (`packages/bridge`):

| Variable                     | Meaning                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `SESSION_BACKEND`            | `process` (default) or `wasm`; `POST /sessions {backend}` overrides it         |
| `KICAD_WASM_MODULE`          | the `kicad_api.js` to load (default `<KICAD_WASM_DIR>`, else the package dist) |
| `KICAD_WASM_HOME`            | MEMFS home for KiCad's settings (default `/home/kicad`)                        |
| `KICAD_WASM_SHARE_PATH`      | MEMFS path of the share tree (default `/kicad/share`)                          |
| `KICAD_WASM_STOP_TIMEOUT_MS` | how long `stop()` waits for the worker to flush before `terminate()` (5000)    |

Browser-only (`apps/web`, Vite):

| Variable              | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| `VITE_KICAD_WASM`     | `1` runs KiCad in the tab (same as `?wasm=1`)               |
| `VITE_KICAD_WASM_URL` | the `kicad_api.js` URL (default `/kicad-wasm/kicad_api.js`) |

## Running the suites

```sh
# the bridge, with every session as a wasm module in its own worker
SESSION_BACKEND=wasm KICAD_WASM_DIR=../kicad/build/wasm/host bun run --filter @fp-pcb/bridge start

# the app, with KiCad in the tab (open http://localhost:5173/?wasm=1)
bun run --filter @fp-pcb/kicad-wasm fetch && bun run --filter @fp-pcb/app dev
```

```sh
# the default: kicad-cli over the nng ipc socket
KICAD_CLI=../kicad/build/dev/kicad/KiCad.app/Contents/MacOS/kicad-cli \
  bun run test:integration

# the native stdio host
KICAD_TRANSPORT=stdio KICAD_API_HOST=../kicad/build/native-host/kicad-api-host-native \
  bun test --cwd packages/client test/conformance

# the wasm module, in this process
bun run --filter @fp-pcb/kicad-wasm fetch          # dist/kicad_api.{js,wasm}
KICAD_TRANSPORT=wasm KICAD_WASM_DIR=../kicad/build/wasm/host \
  bun test --cwd packages/client test/conformance
```

A backend whose binary is missing skips the suite with a message naming the variable to set; an
unknown `KICAD_TRANSPORT` fails immediately. The summary line names the backend it ran
(`=== wasm conformance (KiCad …) ===`).

`packages/kicad-wasm` also has its own integration test (`test/wasm.kicad.test.ts`) that runs
`Ping` and `GetVersion` straight through `kiapi_dispatch` — the first thing to try when a fresh
build lands.

## Status

Conformance is 168 commands (153 headless + 15 gui-only, skipped by every headless backend) plus 6
extra checks. Measured on an idle machine, 2026-09-09:

|                                | `ipc` (kicad-cli)              | `stdio` (native host)           | `wasm`                                                                 |
| ------------------------------ | ------------------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| Conformance                    | **177/177** (153/153 headless) | **150/153** headless, 6/6 extra | **150/153** headless, 6/6 extra                                        |
| Conformance wall time          | ~5 min                         | ~2 min                          | **63 s** (both files)                                                  |
| Open project + board           | 392 ms                         | 65 ms                           | **115 ms**                                                             |
| DRC, kitchen sink (11 markers) | 69 ms                          | 65 ms                           | **77 ms** (first run 108 ms)                                           |
| Ping, mean of 200              | 0.052 ms                       | 0.031 ms                        | **0.006 ms** raw dispatch (0.19 ms through the harness's MEMFS mirror) |

|                                                 |                                                             |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `kicad_api.wasm` / `kicad_api.js`               | **37.4 MB** / 224 KB, no `.data` bundle                     |
| `createKiCadWasm()`                             | **104 ms** under Bun; 143 ms in a warm browser tab          |
| First browser load                              | 37 MB fetched and instantiated in **564 ms** over localhost |
| Mounting KiCad's share tree (185 files, 5.6 MB) | 16 ms                                                       |
| Bridge `POST /sessions` → running and pinged    | **255 ms**                                                  |
| RSS per instance                                | +346 MB for the first, +209 MB for the second               |

The same three commands fail on `stdio` and `wasm`: `RunSchematicJobExportBOM`
(`FIELDS_TABLE_DATA_MODEL_BASE` derives from `wxGridTableBase`), `RunBoardJobExport3D` (no
OpenCascade) and `RunBoardJobExportRender` (no 3D viewer). `bun packages/client/test/bench-drc.ts`
reproduces the timing rows; `docs/wasm-status.md` is the full report.
