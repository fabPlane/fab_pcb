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

## Environment variables

| Variable           | Backend | Meaning                                                                     |
| ------------------ | ------- | --------------------------------------------------------------------------- |
| `KICAD_TRANSPORT`  | all     | `ipc` (default) / `stdio` / `wasm`                                          |
| `KICAD_CLI`        | ipc     | `kicad-cli` binary                                                          |
| `KICAD_API_HOST`   | stdio   | `kicad-api-host-native` binary (default `<kicad>/build/native-host/…`)      |
| `KICAD_WASM_DIR`   | wasm    | directory with `kicad_api.js` / `.wasm` (default `<kicad>/build/wasm/host`) |
| `KICAD_WASM_SHARE` | wasm    | host share tree to mount at `/kicad/share` (when the build has no `.data`)  |
| `KICAD_SRC`        | all     | the KiCad checkout (defaults to `../kicad`)                                 |

## Running the suites

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

`docs/wasm-status.md` tracks what works and what is still missing.
