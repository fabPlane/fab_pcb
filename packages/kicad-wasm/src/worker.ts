/**
 * Worker entry point: everything it does is in `serveKiCadWasm` (see `worker-core.ts`), which is
 * written against a port interface so the protocol can be tested without a real worker.
 *
 * Bundlers find this file through the `new Worker(new URL("./worker.ts", import.meta.url), {type:
 * "module"})` in `worker-client.ts`; nothing imports it as a module.
 */
import { serveKiCadWasm } from "./worker-core";
import type { KiCadWasmWorkerPort } from "./worker-protocol";

// `self` inside a dedicated worker. Declared rather than taken from the DOM lib, which types the
// global as a `Window` whose `postMessage` has a different signature.
declare const self: KiCadWasmWorkerPort;

serveKiCadWasm(self);
