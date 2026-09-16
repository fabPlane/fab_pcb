/**
 * The host side of the browser's wasm mode: `createKiCadWasmInWorker()` starts the worker from
 * `worker.ts`, waits for the module to report `running`, and hands back an object that
 * `WasmTransport` consumes and that answers MEMFS questions over the same channel.
 *
 * The one thing that does not survive the thread boundary is `KiCadWasmInstance.dispatch`, which
 * is synchronous by definition — the module's ABI is. So the client implements `dispatchAsync`
 * instead, which `WasmTransport` prefers when it is there and which is the only reason the
 * interface in `@fp-pcb/client` needed widening at all: in the same thread (Bun, the bridge's
 * worker, the conformance harness) `dispatch` is still called directly and nothing changed.
 *
 *   const wasm = await createKiCadWasmInWorker({ moduleUrl: "/kicad-wasm/kicad_api.js" });
 *   const transport = new WasmTransport(wasm);
 *   await wasm.writeFiles([{ path: "/project/x.kicad_pcb", bytes }]);
 */
import {
  WASM_ABORT_ERROR_NAME,
  type FromKiCadWasmWorker,
  type KiCadWasmWorkerInit,
  type KiCadWasmWorkerLike,
  type KiCadWasmWorkerState,
  type WasmFile,
  type WasmFsRequest,
  type WasmStat,
} from "./worker-protocol";

export type { KiCadWasmWorkerInit, KiCadWasmWorkerLike, KiCadWasmWorkerState, WasmFile, WasmFsRequest, WasmStat };

export interface KiCadWasmInWorkerOptions extends Partial<KiCadWasmWorkerInit> {
  /** Build the worker. Default: `worker.ts` next to this file, as an ES module. */
  createWorker?: () => KiCadWasmWorkerLike;
  /** The module's stdout/stderr and the worker's own diagnostics. */
  log?: (line: string, level?: "info" | "warn") => void;
  /** Event frames the module published (already copied; the worker transferred them). */
  onEvent?: (bytes: Uint8Array) => void;
  /** How long to wait for `kiapi_init` before giving up. Default 120 000 ms; `0` disables. */
  startTimeoutMs?: number;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
}

/**
 * A module running in a Worker, shaped like `KiCadWasmInstance` from `@fp-pcb/client` plus the
 * async MEMFS calls a page needs (`KiCadWasm` exposes `FS` directly; across a thread it cannot).
 */
export class KiCadWasmWorkerClient {
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private readonly log: (line: string, level?: "info" | "warn") => void;
  private readonly onEventOpt: ((bytes: Uint8Array) => void) | undefined;
  private nextId = 1;
  private _state: KiCadWasmWorkerState = "starting";
  private closed = false;
  private stateWaiters = new Set<(s: KiCadWasmWorkerState, message?: string) => void>();

  constructor(
    readonly worker: KiCadWasmWorkerLike,
    opts: KiCadWasmInWorkerOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.onEventOpt = opts.onEvent;
    worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as FromKiCadWasmWorker);
    worker.onerror = (ev: ErrorEvent) => {
      const message = ev?.message ? String(ev.message) : "the KiCad wasm worker failed to start";
      this.fail(message);
    };
  }

  get state(): KiCadWasmWorkerState {
    return this._state;
  }

  /** True once the worker has stopped, cleanly or not; the client is unusable afterwards. */
  get isShutDown(): boolean {
    return this.closed || this._state === "exited" || this._state === "failed";
  }

  // ------------------------------------------------------------------ KiCadWasmInstance

  /**
   * Present so the object still satisfies `KiCadWasmInstance` structurally, and always a mistake
   * to call: a worker cannot answer synchronously. `WasmTransport` uses `dispatchAsync` when it
   * exists, so nothing in the app reaches this.
   */
  dispatch(_request: Uint8Array): Uint8Array {
    throw new Error("this KiCad module runs in a Worker; use dispatchAsync() (WasmTransport does)");
  }

  /** One serialized `ApiRequest` in, one serialized `ApiResponse` out, one round trip. */
  dispatchAsync(request: Uint8Array): Promise<Uint8Array> {
    // A copy, because the buffer is transferred: neutering the caller's request bytes would be a
    // surprise, and requests are small next to the replies.
    const copy = new Uint8Array(request);
    return this.send<Uint8Array>({ req: copy }, [copy.buffer]);
  }

  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** `kiapi_shutdown()` on the worker thread, then `terminate()`. Idempotent. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const exited = this.waitForState(["exited", "failed"], 2000);
      this.worker.postMessage({ stop: true });
      await exited;
    } catch {
      /* the worker never answered; terminate() ends it either way */
    } finally {
      this.worker.terminate();
      this.failAll(new Error("the KiCad wasm worker has been shut down"));
      this.listeners.clear();
    }
  }

  /**
   * `terminate()` and nothing else — the escape hatch a worker exists for.
   *
   * `shutdown()` asks the module to stop first, which a wedged one cannot answer: `kiapi_dispatch`
   * is a synchronous call into a single-threaded module, so a command that never returns holds the
   * worker's message loop and the `{stop: true}` frame is never read. This skips the handshake and
   * kills the thread, taking MEMFS with it. Idempotent, synchronous, and always a hard stop: the
   * caller has to reload a module and replay whatever it had written.
   */
  terminate(reason = "the KiCad wasm worker was terminated"): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this._state = "failed";
    this.notifyState("failed", reason);
    // `fatal`, so a `WasmTransport` still holding this client closes itself rather than dispatching
    // into a thread that no longer exists.
    this.failAll(new Error(reason), true);
    this.listeners.clear();
    this.log(reason, "warn");
  }

  // ------------------------------------------------------------------ MEMFS, over messages

  /** Write files into MEMFS (parents created). Returns how many. */
  writeFiles(files: WasmFile[]): Promise<number> {
    if (files.length === 0) return Promise.resolve(0);
    return this.fs<number>({ op: "writeFiles", files });
  }

  writeFile(path: string, bytes: Uint8Array): Promise<number> {
    return this.writeFiles([{ path, bytes }]);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.fs<Uint8Array>({ op: "readFile", path });
  }

  exists(path: string): Promise<boolean> {
    return this.fs<boolean>({ op: "exists", path });
  }

  stat(path: string): Promise<WasmStat | null> {
    return this.fs<WasmStat | null>({ op: "stat", path });
  }

  /** Every file under `path`, as absolute MEMFS paths (the worker's `listFiles`). */
  listFiles(path: string): Promise<string[]> {
    return this.fs<string[]>({ op: "listFiles", path });
  }

  mkdir(path: string): Promise<void> {
    return this.fs<void>({ op: "mkdir", path });
  }

  // ------------------------------------------------------------------ plumbing

  /** Resolves when the module reports `running`; rejects with `kiapi_init`'s error otherwise. */
  async ready(timeoutMs = 120_000): Promise<void> {
    if (this._state === "running") return;
    const s = await this.waitForState(["running", "failed", "exited"], timeoutMs);
    if (s.state !== "running") throw new Error(s.message ?? `the KiCad wasm worker is ${s.state}`);
  }

  private fs<T>(op: WasmFsRequest): Promise<T> {
    // Deliberately no transfer list for `writeFiles`: the caller keeps its bytes (the app replays
    // every imported file into a module it has to reload), and neutering them under it would turn
    // a second import into an empty file. Replies are transferred; requests are cloned.
    return this.send<T>({ fs: op });
  }

  private send<T>(body: { req: Uint8Array } | { fs: WasmFsRequest }, transfer?: Transferable[]): Promise<T> {
    if (this.isShutDown) return Promise.reject(new Error("the KiCad wasm worker is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      try {
        this.worker.postMessage({ id, ...body }, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onMessage(m: FromKiCadWasmWorker): void {
    if ("state" in m) {
      this._state = m.state;
      if (m.state === "failed" || m.state === "exited") {
        this.notifyState(m.state, m.message);
        // Everything queued behind a dead module would otherwise wait out its timeout.
        this.failAll(new Error(m.message ?? `the KiCad wasm worker ${m.state}`), m.state === "failed");
        return;
      }
      this.notifyState(m.state, m.message);
      return;
    }
    if ("log" in m) {
      this.log(m.log, m.level);
      return;
    }
    if ("event" in m) {
      for (const cb of Array.from(this.listeners)) {
        try {
          cb(m.event);
        } catch (e) {
          this.log(`event listener threw: ${e instanceof Error ? e.message : String(e)}`, "warn");
        }
      }
      this.onEventOpt?.(m.event);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return; // a reply to a request the shutdown already failed
    this.pending.delete(m.id);
    if ("error" in m) {
      const err = new Error(m.error);
      // Marked so `WasmTransport` closes itself instead of dispatching into a dead module — the
      // worker's equivalent of the `WebAssembly.RuntimeError` it recognises in the same thread.
      if (m.fatal) err.name = WASM_ABORT_ERROR_NAME;
      p.reject(err);
      return;
    }
    p.resolve(("res" in m ? m.res : m.value) as never);
  }

  private fail(message: string): void {
    this._state = "failed";
    this.notifyState("failed", message);
    this.failAll(new Error(message));
    this.log(message, "warn");
  }

  private failAll(err: Error, fatal = false): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    if (fatal) err.name = WASM_ABORT_ERROR_NAME;
    for (const p of waiting) p.reject(err);
  }

  private notifyState(state: KiCadWasmWorkerState, message?: string): void {
    for (const cb of Array.from(this.stateWaiters)) cb(state, message);
  }

  private waitForState(want: KiCadWasmWorkerState[], timeoutMs: number): Promise<{ state: KiCadWasmWorkerState; message?: string }> {
    if (want.includes(this._state)) return Promise.resolve({ state: this._state });
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.stateWaiters.delete(cb);
              reject(new Error(`the KiCad wasm worker did not report ${want.join("/")} within ${timeoutMs} ms`));
            }, timeoutMs)
          : null;
      const cb = (state: KiCadWasmWorkerState, message?: string): void => {
        if (!want.includes(state)) return;
        if (timer) clearTimeout(timer);
        this.stateWaiters.delete(cb);
        resolve({ state, message });
      };
      this.stateWaiters.add(cb);
    });
  }
}

/**
 * Start `kicad_api.js` in a Worker and resolve once `kiapi_init` has returned.
 *
 * `moduleUrl` is resolved against the page before it is posted: a worker's own `import()` resolves
 * against the worker script's URL, which after bundling has nothing to do with where the module is
 * served from (`/kicad-wasm/kicad_api.js`).
 */
export async function createKiCadWasmInWorker(opts: KiCadWasmInWorkerOptions = {}): Promise<KiCadWasmWorkerClient> {
  const worker = opts.createWorker ? opts.createWorker() : defaultWorker();
  const client = new KiCadWasmWorkerClient(worker, opts);
  const files = opts.files ?? [];
  const init: KiCadWasmWorkerInit = {
    moduleUrl: absoluteModuleUrl(opts.moduleUrl ?? ""),
    wasmUrl: opts.wasmUrl ? absoluteModuleUrl(opts.wasmUrl) : undefined,
    files,
    home: opts.home,
    share: opts.share,
    env: opts.env,
    preload: opts.preload,
    token: opts.token,
    publishEvents: opts.publishEvents,
  };
  worker.postMessage({ start: init });
  try {
    await client.ready(opts.startTimeoutMs ?? 120_000);
  } catch (e) {
    await client.shutdown();
    throw e;
  }
  return client;
}

/**
 * The worker built from `worker.ts`. The `new URL(..., import.meta.url)` form is what bundlers
 * recognise: Vite emits `worker.ts` as its own ES-module chunk and rewrites the URL.
 */
function defaultWorker(): KiCadWasmWorkerLike {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

/** Absolute, because the worker resolves relative URLs against its own script. */
function absoluteModuleUrl(url: string): string {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = typeof location !== "undefined" && location.href ? location.href : undefined;
  return base ? new URL(url, base).href : url;
}
