# wasm status

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
  `kiapi_*` ABI. Nothing here has met a real `kicad_api.js` yet: when one lands, `SESSION_BACKEND=wasm
KICAD_WASM_DIR=… bun run --filter @fp-pcb/bridge start` and `?wasm=1` are the two things to try.
