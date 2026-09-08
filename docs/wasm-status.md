# wasm status

TypeScript side (branch `wasm`, agent `ts-side`), 2026-09-09.

- **WT1 done** — `StdioTransport`/`StdioSubscriber` (spawn `kicad-api-host-native`, `uint32be`
  frames on stdin/stdout, events on fd 3, replies matched by order) and
  `WasmTransport`/`WasmSubscriber` (in-process, microtask-queued dispatch, events raised during a
  dispatch flushed after that reply). 20 unit tests against a fake stdio host and a fake instance.
- **WT2 done** — `@fp-pcb/kicad-wasm`: `createKiCadWasm()` (the `kiapi_*` C ABI, `__kiapiEvent`
  wired before init, heap copies, `kiapi_last_error` surfaced), MEMFS helpers
  (`mountProject`/`mountPath`/`exportDir`), `bun run fetch` into `dist/`. 11 unit tests against a JS
  mock of the ABI; `test/wasm.kicad.test.ts` runs Ping/GetVersion and skips until a build exists.
- **WT3 done** — `KICAD_TRANSPORT=ipc|stdio|wasm` picks the backend inside `startKiCad()`; the
  conformance and round-trip suites now use `RunningKiCad` only (`subscribe()`, `secondTransport()`,
  `server.eventsUrl`). Missing backend binaries skip with the variable to set. `docs/08-wasm.md` is
  the contract for the C++ side.
- **Verified**: `bun run test:unit` 10/10 packages green. `KICAD_TRANSPORT=ipc` conformance with the
  dev `kicad-cli`: **176/177** (153/153 headless commands, 15 gui-only skips); the single failure is
  `Events: DocumentChanged/DocumentSaved` reporting 3 event-sequence gaps, seen while the machine was
  building KiCad at load 100+ (nng pub/sub drops frames under a stalled subscriber) — re-check on an
  idle machine before treating it as a regression.
- **Blocked on the C++ side**: nothing exists yet at `kicad/build/native-host/kicad-api-host-native`
  or `kicad/build/wasm/host/kicad_api.js`, so `stdio` and `wasm` have never been run end to end.
  Conventions I picked and documented (change them in `docs/08-wasm.md` if the build differs):
  binary names/paths above, `--events-fd <n>` as the fallback when fd 3 cannot be inherited,
  `inproc://kicad` + `inproc://kicad-events` from `GetServerInfo`.
- **Known wasm divergence**: files KiCad writes land in MEMFS, so conformance assertions that
  `existsSync()` a job output on the host will fail until the suite exports those directories.
