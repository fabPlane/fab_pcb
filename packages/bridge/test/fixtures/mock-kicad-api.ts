/**
 * A stand-in for `kicad_api.js`: the same default export (an Emscripten-style factory), built on
 * `@fp-pcb/kicad-wasm`'s JS mock of the `kiapi_*` ABI, with just enough behaviour to drive
 * `WasmSession` end to end without a wasm build:
 *
 *  - every request is answered with a well-formed `ApiResponse{header{kicad_token}, status{AS_OK}}`
 *    carrying the token `kiapi_init` was given, so `pingUntilReady` succeeds;
 *  - every request except `Ping` publishes one `kiapi.common.events.Event` from inside the
 *    dispatch, which is the ordering the real module has;
 *  - `SaveDocument` writes to the preloaded document *in MEMFS*, so the test can prove the worker
 *    copies it back to the workspace;
 *  - `GetVersion` blocks the thread for `SLOW_MS`, which is how the per-request timeout and the
 *    `worker.terminate()` path are exercised. It is bounded so a terminate that does not land
 *    still cannot hang the suite.
 *
 * Loaded by the worker through `WasmSessionOptions.moduleUrl`, i.e. exactly the way the real build
 * is loaded — this file is never imported by the test process itself.
 */
import { createMockFactory, type MockModule } from "../../../kicad-wasm/test/mock-module";
import { requestTypeName } from "../../src/wasm-protocol";

/** How long `GetVersion` wedges the module for. Longer than the timeout the test configures. */
export const SLOW_MS = 1500;
export const SAVED_TEXT = "saved by the mock wasm module\n";
/** `Event{ sequence: 1 }` — decodable, so the worker's `documentSaved` sniff does not throw. */
const EVENT = Uint8Array.from([0x08, 0x01]);

let module: MockModule | null = null;
let token = "";

const base = createMockFactory({
  eventsPerDispatch: (req) => (requestTypeName(req) === "Ping" ? [] : [EVENT]),
  reply: (req) => {
    const name = requestTypeName(req);
    if (name === "GetVersion") blockThread(SLOW_MS);
    if (name === "SaveDocument") saveToMemfs();
    return okResponse(token);
  },
});

export default async function createMockKicadApi(moduleArg: Record<string, unknown> = {}): Promise<MockModule> {
  const m = await base(moduleArg);
  module = m;
  const init = m._kiapi_init.bind(m);
  m._kiapi_init = (ptr: number): number => {
    const rc = init(ptr);
    token = (JSON.parse(m.initConfig ?? "{}") as { token?: string }).token ?? "";
    return rc;
  };
  return m;
}

/** What KiCad does on `SaveDocument`: write the open document back to its (MEMFS) path. */
function saveToMemfs(): void {
  if (!module) return;
  const { preload } = JSON.parse(module.initConfig ?? "{}") as { preload?: string };
  if (preload) module.FS.writeFile(preload, SAVED_TEXT);
}

/** `ApiResponse{ header{ kicad_token }, status{ status: AS_OK } }`. */
function okResponse(kicadToken: string): Uint8Array {
  const id = new TextEncoder().encode(kicadToken);
  return Uint8Array.from([0x0a, id.length + 2, 0x0a, id.length, ...id, 0x12, 0x02, 0x08, 0x01]);
}

/** A synchronous sleep — `kiapi_dispatch` blocks its thread, and so must the mock. */
function blockThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
