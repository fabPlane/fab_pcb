/**
 * `WasmTransport` — in-process transport over KiCad's headless API core compiled to WebAssembly.
 * There is no socket and no serialisation beyond the envelope itself: `send()` hands the request
 * bytes to the module's synchronous `kiapi_dispatch` and gets the reply bytes straight back.
 *
 * The module is single-threaded and re-entrant calls into it are undefined, so requests are queued
 * FIFO and dispatched one at a time from a microtask — `send()` never runs the module inside the
 * caller's stack frame, which keeps `await client.call(...)` inside an event handler safe.
 *
 * Events (`kiapi.common.events.Event` frames the module emits through `Module.__kiapiEvent`) are
 * buffered while a dispatch is running and flushed after the reply promise has resolved, so a
 * listener never observes an event for a change whose reply the caller has not seen yet — the same
 * ordering the socket transports get for free from the event loop.
 *
 * The loader lives in `@fp-pcb/kicad-wasm`; this file only depends on the tiny interface below so
 * `@fp-pcb/client` stays free of Emscripten glue.
 */

import { TransportError, type SendOptions, type Transport, type TransportState } from "./types";
import type { Subscriber, SubscriberState } from "./nng-ipc-sub";

/** What `WasmTransport` needs from a loaded module (`createKiCadWasm()` in `@fp-pcb/kicad-wasm`). */
export interface KiCadWasmInstance {
  /** Synchronously dispatch one serialized `ApiRequest`; returns the serialized `ApiResponse`. */
  dispatch(request: Uint8Array): Uint8Array;
  /**
   * The same dispatch, one round trip away — implemented by an instance that lives on another
   * thread (`createKiCadWasmInWorker()` in the browser), where the module's synchronous ABI cannot
   * be reached synchronously. `WasmTransport` prefers it when it is there; an in-process instance
   * omits it and keeps the straight-line `dispatch` path.
   */
  dispatchAsync?(request: Uint8Array): Promise<Uint8Array>;
  /** Subscribe to serialized `kiapi.common.events.Event` frames. Returns an unsubscribe function. */
  onEvent(cb: (bytes: Uint8Array) => void): () => void;
  /** Tear the module down (`kiapi_shutdown`). */
  shutdown(): void | Promise<void>;
}

export interface WasmTransportOptions {
  /**
   * Default per-request budget when `send()` gets no `timeoutMs`. `0` disables. Default 30 000 ms.
   * A dispatch already under way cannot be interrupted (it is a synchronous call into the module),
   * so the timeout only covers the time a request spends queued.
   */
  defaultTimeoutMs?: number;
  /** Call `instance.shutdown()` from `close()`. Default `true`. */
  ownsInstance?: boolean;
  /** Diagnostic logger. */
  log?: (message: string) => void;
}

interface Pending {
  payload: Uint8Array;
  timeoutMs: number;
  resolve: (reply: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
}

export class WasmTransport implements Transport {
  private readonly defaultTimeoutMs: number;
  private readonly ownsInstance: boolean;
  private readonly log: (message: string) => void;

  private _state: TransportState = "open";
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private readonly eventListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly offInstanceEvents: () => void;
  private queue: Pending[] = [];
  private pumping = false;
  private dispatching = false;
  private eventBuffer: Uint8Array[] = [];
  private lastError: Error | null = null;

  /** Symmetry with the socket transports; the module is ready as soon as it is loaded. */
  static async connect(instance: KiCadWasmInstance, opts: WasmTransportOptions = {}): Promise<WasmTransport> {
    return new WasmTransport(instance, opts);
  }

  constructor(
    readonly instance: KiCadWasmInstance,
    opts: WasmTransportOptions = {},
  ) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.ownsInstance = opts.ownsInstance ?? true;
    this.log = opts.log ?? (() => {});
    this.offInstanceEvents = instance.onEvent((bytes) => this.onModuleEvent(bytes));
  }

  get state(): TransportState {
    return this._state;
  }

  /** Number of requests waiting behind the one being dispatched. */
  get queued(): number {
    return this.queue.length;
  }

  /** Events emitted during the current dispatch, waiting to be flushed. */
  get bufferedEvents(): number {
    return this.eventBuffer.length;
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Raw event frames. Wrap with `WasmSubscriber` for the `Subscriber` interface. */
  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  send(request: Uint8Array, opts: SendOptions = {}): Promise<Uint8Array> {
    if (this._state === "closed") {
      return Promise.reject(this.lastError ?? new TransportError("closed", "wasm transport is closed"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const p: Pending = {
        payload: request,
        timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
        resolve,
        reject,
        timer: null,
        cancelled: false,
      };
      if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) {
        p.timer = setTimeout(() => {
          if (p.cancelled) return;
          p.cancelled = true;
          p.reject(new TransportError("timeout", `request timed out after ${p.timeoutMs} ms waiting for the wasm module`));
        }, p.timeoutMs);
      }
      this.queue.push(p);
      this.schedule();
    });
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    const err = new TransportError("closed", "wasm transport closed");
    this.lastError = err;
    this.failAll(err);
    this.offInstanceEvents();
    this.eventBuffer = [];
    this.setState("closed");
    if (this.ownsInstance) {
      try {
        await this.instance.shutdown();
      } catch (e) {
        this.log(`shutdown threw: ${errorMessage(e)}`);
      }
    }
  }

  // ---------------------------------------------------------------- dispatch loop

  private schedule(): void {
    if (this.pumping) return;
    this.pumping = true;
    queueMicrotask(() => {
      this.pumping = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this._state === "closed") return;
    let p = this.queue.shift();
    while (p && p.cancelled) p = this.queue.shift(); // timed out while queued
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.cancelled = true; // no timeout can fire once the module has the request

    // An instance on another thread cannot answer synchronously; the event buffering and the
    // strict one-at-a-time ordering are the same either way, only the reply arrives later.
    if (this.instance.dispatchAsync) {
      void this.pumpAsync(p);
      return;
    }
    let reply: Uint8Array;
    this.dispatching = true;
    try {
      reply = this.instance.dispatch(p.payload);
    } catch (e) {
      this.dispatching = false;
      this.failDispatch(p, e);
      return;
    }
    this.dispatching = false;
    // Resolving schedules the caller's continuation; flushing from a later microtask therefore
    // delivers events strictly after the reply the module produced them for.
    p.resolve(reply);
    this.afterDispatch();
  }

  /** `pump()` for an instance behind `dispatchAsync` (a Worker); nothing else runs meanwhile. */
  private async pumpAsync(p: Pending): Promise<void> {
    let reply: Uint8Array;
    this.dispatching = true;
    try {
      reply = await this.instance.dispatchAsync!(p.payload);
    } catch (e) {
      this.dispatching = false;
      this.failDispatch(p, e);
      return;
    }
    this.dispatching = false;
    p.resolve(reply);
    this.afterDispatch();
  }

  private failDispatch(p: Pending, e: unknown): void {
    const err = e instanceof TransportError ? e : new TransportError("protocol", `wasm dispatch failed: ${errorMessage(e)}`, { cause: e });
    this.log(err.message);
    p.reject(err);
    if (isRuntimeAbort(e)) {
      // The module called abort(): a headless GUI stub reached ___trap(), or the runtime ran
      // out of memory. Everything in it is gone -- later dispatches trap again or return
      // nothing, and the caller waits out its whole timeout instead of failing. The stdio
      // transport gets this for free from the process exiting; do the same here so the owner
      // sees a closed transport and can restart the module.
      this.close();
      return;
    }
    this.afterDispatch();
  }

  private afterDispatch(): void {
    queueMicrotask(() => {
      this.flushEvents();
      if (this.queue.length > 0) this.schedule();
    });
  }

  private onModuleEvent(bytes: Uint8Array): void {
    // The module may hand out a view into its heap; copy before it moves or is freed.
    const copy = new Uint8Array(bytes);
    if (this.dispatching) {
      this.eventBuffer.push(copy);
      return;
    }
    this.emit(copy);
  }

  private flushEvents(): void {
    if (this.eventBuffer.length === 0) return;
    const buffered = this.eventBuffer;
    this.eventBuffer = [];
    for (const b of buffered) this.emit(b);
  }

  private emit(bytes: Uint8Array): void {
    for (const cb of Array.from(this.eventListeners)) {
      try {
        cb(bytes);
      } catch (e) {
        this.log(`event listener threw: ${errorMessage(e)}`);
      }
    }
  }

  private failAll(err: Error): void {
    const q = this.queue;
    this.queue = [];
    for (const p of q) {
      if (p.timer) clearTimeout(p.timer);
      if (p.cancelled) continue;
      p.cancelled = true;
      p.reject(err);
    }
  }

  private setState(s: TransportState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of Array.from(this.stateListeners)) {
      try {
        cb(s);
      } catch (e) {
        this.log(`state listener threw: ${errorMessage(e)}`);
      }
    }
  }
}

/**
 * `Subscriber` over a `WasmTransport`, so `KiCadEvents` works the same as with `NngIpcSubscriber`.
 * `open` while the transport is open (the module publishes events synchronously, there is nothing
 * to dial), `closed` once the transport is closed or `close()` was called. Closing the subscriber
 * detaches; it never closes the transport or the module.
 */
export class WasmSubscriber implements Subscriber {
  private readonly messageListeners = new Set<(body: Uint8Array) => void>();
  private readonly stateListeners = new Set<(s: SubscriberState, error?: Error) => void>();
  private _state: SubscriberState;
  private detach: (() => void) | undefined;

  constructor(readonly transport: WasmTransport) {
    this._state = transport.state === "closed" ? "closed" : "open";
    const offEvent = transport.onEvent((b) => {
      for (const cb of Array.from(this.messageListeners)) cb(b);
    });
    const offState = transport.onStateChange((s) => {
      if (s === "closed") this.setState("closed");
    });
    this.detach = () => {
      offEvent();
      offState();
    };
  }

  get state(): SubscriberState {
    return this._state;
  }

  onMessage(cb: (body: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => {
      this.messageListeners.delete(cb);
    };
  }

  onStateChange(cb: (state: SubscriberState, error?: Error) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  async close(): Promise<void> {
    this.detach?.();
    this.detach = undefined;
    this.setState("closed");
  }

  private setState(s: SubscriberState, error?: Error): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of Array.from(this.stateListeners)) cb(s, error);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Did the module abort, as opposed to failing one request?
 *
 * Emscripten's `abort()` compiles to an `unreachable` instruction, which surfaces in JavaScript
 * as a `WebAssembly.RuntimeError`. Every KiCad-level failure comes back as a well-formed
 * `ApiResponse` with a non-OK status instead, so a RuntimeError out of `dispatch` always means
 * the instance is unusable.
 *
 * An instance on another thread cannot throw the RuntimeError itself — only its message survives
 * the structured clone — so it renames the error it rethrows instead. `@fp-pcb/kicad-wasm` exports
 * that name as `WASM_ABORT_ERROR_NAME`; it is compared as a string here so the transport keeps no
 * dependency on the loader.
 */
function isRuntimeAbort(e: unknown): boolean {
  if (e instanceof Error && e.name === "KiCadWasmAbort") return true;
  return typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError;
}
