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
  dev `kicad-cli`: **176/177** (153/153 headless commands, 15 gui-only skips). The one failure,
  `Events: DocumentChanged/DocumentSaved`, reports 3 event-sequence gaps and was recorded while
  another agent was building KiCad at load 100+ (nng pub/sub drops frames behind a stalled
  subscriber); re-check on an idle machine before calling it a regression. The `stdio` and `wasm`
  paths of the harness were smoke-tested against fake hosts that answer a canned `AS_OK`: both load,
  mount, connect and run until the fixtures' real content is needed.
- **Blocked on the C++ side** — nothing exists yet at `kicad/build/native-host/kicad-api-host-native`
  or `kicad/build/wasm/host/kicad_api.js`, so neither backend has run against real KiCad. Change
  `docs/08-wasm.md` if the build lands with different names, paths, or an `--events-fd` fallback.
- **Known wasm divergence** — files KiCad writes land in MEMFS, so conformance checks that
  `existsSync()` a job output on the host will fail until the suite exports those directories.
