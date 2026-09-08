/**
 * The worker behind `WasmSession`: it owns exactly one `createKiCadWasm()` instance and its MEMFS,
 * and it is the only place in the bridge that touches the wasm module.
 *
 * Why a worker at all: `kiapi_dispatch` is a synchronous call into a single-threaded module, so a
 * KiCad operation that wedges (an infinite loop in a DRC provider, a pathological zone fill) would
 * block the bridge's event loop and with it every *other* session. In a worker it blocks one
 * thread, and `worker.terminate()` from the main thread ends it deterministically — the wasm
 * equivalent of SIGKILL on the `kicad-cli` process.
 *
 * MEMFS lifecycle:
 *  - the host project directory is copied in *inside the module factory*, i.e. after the Emscripten
 *    module exists but before the loader calls `kiapi_init`, so `preload` finds its document;
 *  - it is copied back out after a `Save*` / `CloseDocument` request, after a `DocumentSaved`
 *    event, on `{flush}`, and once more on `{stop}` (see `shouldFlushAfter`).
 */
import { createKiCadWasm, defaultModuleUrl, type KiCadWasm, type KiCadWasmModule, type KiCadWasmModuleFactory } from "@fp-pcb/kicad-wasm";
import { exportDir, mountProject } from "@fp-pcb/kicad-wasm/fs";
import { decodeEvent } from "@fp-pcb/client";
import { requestTypeName, shouldFlushAfter, type FromWasmWorker, type ToWasmWorker, type WasmWorkerInit } from "./wasm-protocol";

declare const self: {
  onmessage: ((ev: MessageEvent<ToWasmWorker>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

let wasm: KiCadWasm | null = null;
let init: WasmWorkerInit | null = null;
let flushing: Promise<void> = Promise.resolve();
let stopped = false;

function post(message: FromWasmWorker, transfer?: Transferable[]): void {
  self.postMessage(message, transfer);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

self.onmessage = (ev: MessageEvent<ToWasmWorker>) => {
  const m = ev.data;
  // Each branch runs synchronously up to its first await, and `kiapi_dispatch` is synchronous, so
  // requests reach the module in the order the main thread posted them.
  if ("start" in m) void start(m.start);
  else if ("req" in m) void dispatch(m.id, m.req);
  else if ("flush" in m) void flush();
  else if ("stop" in m) void stop();
};

async function start(cfg: WasmWorkerInit): Promise<void> {
  init = cfg;
  post({ state: "starting" });
  try {
    const factory = await loadFactory(cfg.moduleUrl);
    // The loader awaits the factory and only then runs `kiapi_init`, so this is the one hook that
    // gets the project into MEMFS before KiCad opens `preload`.
    const mounting: KiCadWasmModuleFactory = async (moduleArg) => {
      const module = (await factory(moduleArg)) as KiCadWasmModule;
      if (cfg.shareDir) {
        const r = await mountProject({ FS: module.FS }, cfg.shareDir, cfg.share);
        post({ log: `mounted share ${cfg.shareDir} at ${cfg.share} (${r.files} files, ${r.bytes} bytes)` });
      }
      if (cfg.projectDir) {
        const r = await mountProject({ FS: module.FS }, cfg.projectDir);
        post({ log: `mounted ${cfg.projectDir} (${r.files} files, ${r.bytes} bytes)` });
      }
      return module;
    };
    wasm = await createKiCadWasm({
      module: mounting,
      home: cfg.home,
      share: cfg.share,
      env: cfg.env,
      preload: cfg.preload,
      token: cfg.token,
      publishEvents: cfg.publishEvents,
      print: (line) => post({ log: `[out] ${line}` }),
      printErr: (line) => post({ log: `[err] ${line}` }),
    });
    wasm.onEvent(onModuleEvent);
    post({ state: "running" });
  } catch (e) {
    post({ state: "failed", message: describe(e) });
  }
}

/** The module hands the loader a copy already; copy once more so the buffer we transfer is ours. */
function onModuleEvent(bytes: Uint8Array): void {
  let saved = false;
  try {
    saved = decodeEvent(bytes).kind.case === "documentSaved";
  } catch {
    /* an undecodable frame is still relayed verbatim; the bridge only sniffs it for the flush */
  }
  const copy = new Uint8Array(bytes);
  post({ event: copy }, [copy.buffer]);
  if (saved) void flush();
}

async function dispatch(id: number, req: Uint8Array): Promise<void> {
  if (!wasm || stopped) {
    post({ id, error: "the wasm module is not running" });
    return;
  }
  let res: Uint8Array;
  try {
    res = wasm.dispatch(req);
  } catch (e) {
    post({ id, error: describe(e) });
    return;
  }
  // `KiCadWasm.dispatch` returns a `slice()` of the heap, i.e. a buffer nobody else holds.
  post({ id, res }, [res.buffer]);
  if (shouldFlushAfter(requestTypeName(req))) await flush();
}

/**
 * Copy the project tree back to the host. Serialised through one promise chain so two saves in a
 * row cannot interleave two `exportDir` walks over the same directory.
 */
function flush(): Promise<void> {
  const cfg = init;
  if (!wasm || !cfg?.projectDir) return Promise.resolve();
  const dir = cfg.projectDir;
  flushing = flushing
    .then(async () => {
      if (!wasm || wasm.isShutDown) return;
      const files = await exportDir(wasm, dir, dir);
      post({ log: `flushed ${files} file(s) from MEMFS to ${dir}` });
    })
    .catch((e: unknown) => post({ log: `flush of ${dir} failed: ${describe(e)}` }));
  return flushing;
}

async function stop(): Promise<void> {
  if (stopped) return;
  stopped = true;
  try {
    await flush();
    wasm?.shutdown();
    post({ state: "exited" });
  } catch (e) {
    post({ state: "failed", message: describe(e) });
  } finally {
    wasm = null;
    self.close();
  }
}

/**
 * Resolve the Emscripten factory ourselves rather than letting the loader do it: the factory has
 * to be wrapped so the project can be mounted before `kiapi_init`.
 */
async function loadFactory(moduleUrl: string): Promise<KiCadWasmModuleFactory> {
  const url = toUrl(moduleUrl);
  const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error(`${url} has no default export (expected the createKicadApi factory)`);
  return mod.default as KiCadWasmModuleFactory;
}

function toUrl(moduleUrl: string): string {
  if (!moduleUrl) return defaultModuleUrl().href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(moduleUrl)) return moduleUrl;
  return new URL(moduleUrl, `file://${process.cwd()}/`).href;
}
