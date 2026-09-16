/**
 * The message protocol between a page (or any host thread) and the Web Worker that owns one
 * `createKiCadWasm()` instance — `worker-core.ts` on the worker side, `worker-client.ts` on the
 * host side.
 *
 * It is the browser twin of the bridge's `packages/bridge/src/wasm-protocol.ts`, and deliberately
 * the same shape: `{id, req}` in, `{id, res}` out, `{event}` unsolicited, buffers transferred
 * rather than copied. Two things differ, both because the worker here has no host disk to mirror
 * to. There is no `{flush}` — MEMFS *is* the file system in a tab — and the file operations the
 * page needs (the project import, the project browser, `stat`) travel as `{id, fs}` messages
 * instead of happening on the host thread against a `KiCadWasmFS` it can reach directly.
 *
 *   host -> worker   { start }            once, first
 *                    { id, req }          one ApiRequest
 *                    { id, fs }           one MEMFS operation
 *                    { stop }             shut the module down and close the worker
 *   worker -> host   { state, message? }  starting -> running | failed | exited
 *                    { id, res }          the ApiResponse for that id
 *                    { id, value }        the result of that fs operation
 *                    { id, error, fatal } that request failed; `fatal` means the module is gone
 *                    { event }            one kiapi.common.events.Event frame
 *                    { log }              a diagnostic line (the module's stdout/stderr, mounts)
 */

/** One file to put into MEMFS, at an absolute path. */
export interface WasmFile {
  path: string;
  bytes: Uint8Array;
}

/** `FS.stat` reduced to what a file browser needs. */
export interface WasmStat {
  kind: "dir" | "file";
  size: number;
}

/** Everything the worker is told once, before it loads the module. */
export interface KiCadWasmWorkerInit {
  /**
   * ES module whose default export is the Emscripten factory (`kicad_api.js`). It must be
   * **absolute**: a worker's `import()` resolves against the worker script's own URL, which is a
   * bundler-generated path with no relation to where the module is served from.
   */
  moduleUrl: string;
  /** `kicad_api.wasm`, when it does not sit next to `kicad_api.js` (Emscripten `locateFile`). */
  wasmUrl?: string;
  /** Written into MEMFS from inside the module factory, i.e. before `kiapi_init` reads `preload`. */
  files?: WasmFile[];
  home?: string;
  share?: string;
  env?: Record<string, string>;
  preload?: string;
  token?: string;
  publishEvents?: boolean;
}

/** One MEMFS operation, run on the worker thread against the module's own file system. */
export type WasmFsRequest =
  | { op: "writeFiles"; files: WasmFile[] }
  | { op: "readFile"; path: string }
  | { op: "exists"; path: string }
  | { op: "stat"; path: string }
  | { op: "listFiles"; path: string }
  | { op: "mkdir"; path: string };

/** The value `{id, value}` carries back, by operation. */
export type WasmFsResult<Op extends WasmFsRequest["op"]> = Op extends "writeFiles"
  ? number
  : Op extends "readFile"
    ? Uint8Array
    : Op extends "exists"
      ? boolean
      : Op extends "stat"
        ? WasmStat | null
        : Op extends "listFiles"
          ? string[]
          : void;

/** `starting` until `kiapi_init` returns; `exited` after a clean stop, `failed` otherwise. */
export type KiCadWasmWorkerState = "starting" | "running" | "failed" | "exited";

export type ToKiCadWasmWorker =
  | { start: KiCadWasmWorkerInit }
  | { id: number; req: Uint8Array }
  | { id: number; fs: WasmFsRequest }
  | { stop: true };

export type FromKiCadWasmWorker =
  | { state: KiCadWasmWorkerState; message?: string }
  | { id: number; res: Uint8Array }
  | { id: number; value: unknown }
  | { id: number; error: string; fatal?: boolean }
  | { event: Uint8Array }
  | { log: string; level?: "info" | "warn" };

/**
 * The worker side of the channel (`self` inside the worker, or a fake in tests). Narrow on
 * purpose: `worker-core.ts` is written against this so it can be driven in-process.
 */
export interface KiCadWasmWorkerPort {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  /** `self.close()` in a real worker; absent in a fake port. */
  close?(): void;
}

/** The host side of the channel: a `Worker`, or anything shaped like one. */
export interface KiCadWasmWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

/**
 * Did the module abort, as opposed to failing one request? Emscripten's `abort()` compiles to an
 * `unreachable` instruction, which surfaces as a `WebAssembly.RuntimeError`; every KiCad-level
 * failure comes back as a well-formed `ApiResponse` instead. The same test `WasmTransport` makes,
 * repeated here because in worker mode the throw happens on the other thread and only its message
 * survives the structured clone.
 */
export function isWasmAbort(e: unknown): boolean {
  return typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;
}

/** The name `worker-client.ts` gives an error it rethrows for an abort on the worker thread. */
export const WASM_ABORT_ERROR_NAME = "KiCadWasmAbort";
