/**
 * The worker side of the browser's wasm mode: it owns exactly one `createKiCadWasm()` instance and
 * its MEMFS, and it is the only place in the tab that touches the module.
 *
 * Why a worker: `kiapi_dispatch` is a synchronous call into a single-threaded module, so a DRC or
 * a zone fill that takes a second takes the main thread with it — no paint, no scroll, no cancel
 * button. On a worker thread the same second costs nothing visible, and `worker.terminate()` ends
 * a wedged command the way the bridge kills a `kicad-cli` process.
 *
 * The logic lives here, apart from `worker.ts` (three lines: `serveKiCadWasm(self)`), so the whole
 * protocol can be driven in-process from a test with a fake port.
 */
import { createKiCadWasm, type KiCadWasm, type KiCadWasmModule, type KiCadWasmModuleFactory } from "./index";
import { exists, listFiles, mkdirTree, readFile, writeFile } from "./fs";
import {
  isWasmAbort,
  type FromKiCadWasmWorker,
  type KiCadWasmWorkerInit,
  type KiCadWasmWorkerPort,
  type ToKiCadWasmWorker,
  type WasmFsRequest,
} from "./worker-protocol";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Serve the protocol on `port` until `{stop}`. Returns nothing: the worker is its own lifetime.
 */
export function serveKiCadWasm(port: KiCadWasmWorkerPort): void {
  let wasm: KiCadWasm | null = null;
  let stopped = false;

  const post = (message: FromKiCadWasmWorker, transfer?: Transferable[]): void => port.postMessage(message, transfer);

  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as ToKiCadWasmWorker;
    // Each branch runs synchronously up to its first await, and `kiapi_dispatch` is synchronous,
    // so requests reach the module in the order the host posted them.
    if ("start" in m) void start(m.start);
    else if ("req" in m) dispatch(m.id, m.req);
    else if ("fs" in m) fsOp(m.id, m.fs);
    else if ("stop" in m) stop();
  };

  async function start(cfg: KiCadWasmWorkerInit): Promise<void> {
    post({ state: "starting" });
    try {
      const factory = await loadFactory(cfg.moduleUrl);
      // The loader awaits the factory and only then runs `kiapi_init`, so this is the one hook
      // that gets files into MEMFS before KiCad opens `preload`.
      const seeding: KiCadWasmModuleFactory = async (moduleArg) => {
        const module = (await factory(moduleArg)) as KiCadWasmModule;
        const files = cfg.files ?? [];
        for (const f of files) writeFile({ FS: module.FS }, f.path, f.bytes);
        if (files.length > 0) post({ log: `seeded ${files.length} file(s) into the module's file system` });
        return module;
      };
      wasm = await createKiCadWasm({
        module: seeding,
        // Not for loading the factory -- that is `seeding` -- but so that `kicad_api.data` and,
        // with no explicit `wasmUrl`, `kicad_api.wasm` resolve next to the glue instead of next to
        // this worker's own script.
        moduleUrl: cfg.moduleUrl,
        wasmUrl: cfg.wasmUrl,
        home: cfg.home,
        share: cfg.share,
        env: cfg.env,
        preload: cfg.preload,
        token: cfg.token,
        publishEvents: cfg.publishEvents,
        print: (line) => post({ log: line }),
        printErr: (line) => post({ log: line, level: "warn" }),
      });
      wasm.onEvent(onModuleEvent);
      post({ state: "running" });
    } catch (e) {
      post({ state: "failed", message: describe(e) });
    }
  }

  /** The module hands the loader a copy already; copy once more so the buffer we transfer is ours. */
  function onModuleEvent(bytes: Uint8Array): void {
    const copy = new Uint8Array(bytes);
    post({ event: copy }, [copy.buffer]);
  }

  function dispatch(id: number, req: Uint8Array): void {
    if (!wasm || stopped) {
      post({ id, error: "the wasm module is not running" });
      return;
    }
    let res: Uint8Array;
    try {
      res = wasm.dispatch(req);
    } catch (e) {
      const fatal = isWasmAbort(e);
      post({ id, error: describe(e), fatal });
      if (fatal) {
        // The module called abort(): its heap is gone and every later dispatch traps again. Say so
        // once, so the host closes the transport instead of waiting out a 120 s timeout per request.
        wasm = null;
        post({ state: "failed", message: describe(e) });
      }
      return;
    }
    // `KiCadWasm.dispatch` returns a `slice()` of the heap, i.e. a buffer nobody else holds.
    post({ id, res }, [res.buffer]);
  }

  function fsOp(id: number, op: WasmFsRequest): void {
    if (!wasm) {
      post({ id, error: "the wasm module is not running" });
      return;
    }
    const instance = wasm;
    try {
      switch (op.op) {
        case "writeFiles": {
          for (const f of op.files) writeFile(instance, f.path, f.bytes);
          post({ id, value: op.files.length });
          return;
        }
        case "readFile": {
          // A copy, because the buffer is transferred and MEMFS keeps its own.
          const bytes = new Uint8Array(readFile(instance, op.path));
          post({ id, value: bytes }, [bytes.buffer]);
          return;
        }
        case "exists": {
          post({ id, value: exists(instance, op.path) });
          return;
        }
        case "stat": {
          if (!exists(instance, op.path)) {
            post({ id, value: null });
            return;
          }
          const st = instance.FS.stat(op.path);
          post({ id, value: { kind: instance.FS.isDir(st.mode) ? "dir" : "file", size: st.size } });
          return;
        }
        case "listFiles": {
          post({ id, value: listFiles(instance, op.path) });
          return;
        }
        case "mkdir": {
          mkdirTree(instance.FS, op.path);
          post({ id, value: undefined });
          return;
        }
      }
    } catch (e) {
      post({ id, error: describe(e) });
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    try {
      wasm?.shutdown();
      post({ state: "exited" });
    } catch (e) {
      post({ state: "failed", message: describe(e) });
    } finally {
      wasm = null;
      port.close?.();
    }
  }
}

/**
 * Resolve the Emscripten factory ourselves rather than letting the loader do it: the factory has
 * to be wrapped so `cfg.files` land in MEMFS before `kiapi_init`.
 *
 * `@vite-ignore` because the URL is a runtime value — the glue is served as a plain file (see
 * `apps/web/vite.config.ts`), never bundled.
 */
async function loadFactory(moduleUrl: string): Promise<KiCadWasmModuleFactory> {
  if (!moduleUrl) throw new Error("no moduleUrl: a worker cannot resolve the packaged kicad_api.js on its own");
  const mod = (await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown };
  if (typeof mod.default !== "function") throw new Error(`${moduleUrl} has no default export (expected the createKicadApi factory)`);
  return mod.default as KiCadWasmModuleFactory;
}
