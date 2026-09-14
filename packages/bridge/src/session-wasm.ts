/**
 * `WasmSession` — a session whose KiCad is `kicad_api.wasm` running inside one Bun `Worker`
 * instead of a `kicad-cli api-server` process.
 *
 * It presents exactly the `SessionLike` surface `server.ts` uses, so the WebSocket frame
 * pass-through, the SSE stream, the route/compile jobs and the idle reaper are unchanged: a
 * `Transport` in, event frames out, `start()` / `stop()`, an id and a token.
 *
 * What the Worker buys us, given the module has no OS process boundary:
 *  - **isolation of the failure mode that matters.** `kiapi_dispatch` is a synchronous call into a
 *    single-threaded module. On the main thread a KiCad operation that never returns would freeze
 *    the bridge and every other session with it; on its own thread it freezes only that session.
 *  - **deterministic teardown.** `worker.terminate()` ends the thread and frees its heap whether or
 *    not the module cooperates — the wasm answer to SIGKILL. It is what the per-request timeout
 *    below reaches for, and it is why a wedged session can be reaped at all.
 *
 * What it does not buy: the module shares the process's address space limits and its crash is
 * still a process-wide `abort()` if Emscripten traps hard. See `docs/08-wasm.md`.
 */
import { dirname, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  TransportError,
  encodeControl,
  encodeEventFrame,
  type BridgeControlMessage,
  type BridgeEventsState,
  type KiCadServerState,
  type SendOptions,
  type Transport,
  type TransportState,
} from "@fp-pcb/client/transport";
import type { BridgeConfig } from "./config";
import { pingUntilReady } from "./kicad-ping";
import type { SessionInfo, SessionLike, WsData } from "./session";
import type { FromWasmWorker, ToWasmWorker, WasmWorkerInit } from "./wasm-protocol";

const LOG_RING = 200;

/**
 * `Transport` over the worker's message port. One `{id, req}` per `send()`, replies matched by id
 * (unlike the stdio host, the worker may answer out of order without harm, though it does not).
 * A request that outlives its budget is not just rejected: the module cannot be interrupted, so
 * the only way back is `onTimeout`, which terminates the whole worker.
 */
class WasmWorkerTransport implements Transport {
  private readonly pending = new Map<
    number,
    { resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
  >();
  private nextId = 1;
  private _state: TransportState = "open";
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private lastError: Error | null = null;

  constructor(
    private readonly post: (m: ToWasmWorker, transfer?: Transferable[]) => void,
    private readonly opts: { defaultTimeoutMs: number; onTimeout: (message: string) => void },
  ) {}

  get state(): TransportState {
    return this._state;
  }

  /** Requests the worker has not answered yet. */
  get queued(): number {
    return this.pending.size;
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  send(request: Uint8Array, opts: SendOptions = {}): Promise<Uint8Array> {
    if (this._state === "closed") return Promise.reject(this.lastError ?? new TransportError("closed", "the wasm session is closed"));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(() => {
              const message = `the wasm module did not answer within ${timeoutMs} ms; terminating the worker`;
              this.settle(id)?.reject(new TransportError("timeout", message));
              this.opts.onTimeout(message);
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      // The caller owns `request` (it is a copy of the WebSocket frame), so hand the buffer over.
      const body = new Uint8Array(request);
      this.post({ id, req: body }, [body.buffer]);
    });
  }

  /** Called from the session when the worker answers. */
  resolve(id: number, reply: Uint8Array): void {
    this.settle(id)?.resolve(reply);
  }

  rejectOne(id: number, message: string): void {
    this.settle(id)?.reject(new TransportError("protocol", message));
  }

  /** Reject everything in flight; used by the timeout, a worker crash and `close()`. */
  failAll(err: Error): void {
    this.lastError = err;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    const err = new TransportError("closed", "the wasm session is closed");
    this.failAll(err);
    this._state = "closed";
    for (const cb of [...this.stateListeners]) {
      try {
        cb("closed");
      } catch {
        /* ignore */
      }
    }
  }

  private settle(id: number): { resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    return p;
  }
}

export interface WasmSessionOptions {
  /**
   * Where `new Worker()` finds the worker script. Only tests set it (to a copy that loads a mock
   * of the ABI); production uses `./wasm-worker.ts` next to this file.
   */
  workerUrl?: URL;
  /** Overrides `cfg.wasmModuleUrl` for this session (tests point it at a JS mock). */
  moduleUrl?: string;
}

export class WasmSession implements SessionLike {
  readonly backend = "wasm" as const;
  readonly id: string;
  path: string | null;
  /** There is no socket; the label is what `GetServerInfo` reports and what the UI shows. */
  readonly socketPath: string;
  readonly eventsSocketPath: string | null = "inproc://kicad-events";
  readonly startedAt = new Date();
  readyAt: Date | null = null;
  state: KiCadServerState = "starting";
  kicadToken: string | null = null;
  exitCode: number | null = null;
  signal: string | null = null;
  error: string | null = null;
  transport: WasmWorkerTransport | null = null;
  eventsState: BridgeEventsState = "disconnected";
  eventsRelayed = 0;
  lastClientAt = new Date();
  readonly clients = new Set<ServerWebSocket<WsData>>();
  readonly logLines: string[] = [];

  private worker: Worker | null = null;
  private readonly eventListeners = new Set<(event: Uint8Array) => void>();
  private readonly eventsStateListeners = new Set<(state: BridgeEventsState, message?: string) => void>();
  private stopping = false;
  private onWorkerState: ((state: string, message?: string) => void) | null = null;

  constructor(
    private readonly cfg: BridgeConfig,
    id: string,
    path: string | null,
    private readonly opts: WasmSessionOptions = {},
  ) {
    this.id = id;
    this.path = path;
    this.socketPath = `inproc://kicad-${id}`;
  }

  /** Refresh discovery metadata after a compile creates a project in a bare session. */
  updateProjectPath(path: string): void {
    this.path = resolve(path);
  }

  info(): SessionInfo {
    return {
      id: this.id,
      backend: this.backend,
      state: this.state,
      path: this.path,
      socketPath: this.socketPath,
      eventsSocketPath: this.eventsState === "connected" ? this.eventsSocketPath : null,
      eventsState: this.eventsState,
      eventsRelayed: this.eventsRelayed,
      pid: null,
      kicadToken: this.kicadToken,
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.error,
      startedAt: this.startedAt.toISOString(),
      readyAt: this.readyAt?.toISOString() ?? null,
      lastClientAt: this.lastClientAt.toISOString(),
      clients: this.clients.size,
      listeners: this.eventListeners.size,
      queued: this.transport?.queued ?? 0,
    };
  }

  get idle(): boolean {
    return this.clients.size === 0 && this.eventListeners.size === 0;
  }

  touch(): void {
    this.lastClientAt = new Date();
  }

  onEvent(cb: (event: Uint8Array) => void): () => void {
    this.eventListeners.add(cb);
    this.touch();
    return () => {
      this.eventListeners.delete(cb);
      this.touch();
    };
  }

  onEventsState(cb: (state: BridgeEventsState, message?: string) => void): () => void {
    this.eventsStateListeners.add(cb);
    return () => {
      this.eventsStateListeners.delete(cb);
    };
  }

  broadcast(msg: BridgeControlMessage): void {
    const text = encodeControl(msg);
    for (const ws of this.clients) {
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  tailLog(lines = 10): string {
    const tail = this.logLines.slice(-lines);
    return tail.length ? `\n--- kicad wasm output ---\n${tail.join("\n")}` : "";
  }

  /** Ask the worker to copy MEMFS back to the workspace now (a job wrote files, a tab is leaving). */
  flush(): void {
    this.worker?.postMessage({ flush: true } satisfies ToWasmWorker);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start the worker, load the module (mounting the project into MEMFS), Ping until AS_OK. */
  async start(): Promise<void> {
    const { cfg } = this;
    const token = crypto.randomUUID();
    const workerUrl = this.opts.workerUrl ?? new URL("./wasm-worker.ts", import.meta.url);
    const init: WasmWorkerInit = {
      sessionId: this.id,
      moduleUrl: this.opts.moduleUrl ?? cfg.wasmModuleUrl,
      projectDir: this.path ? dirname(this.path) : null,
      preload: this.path ?? "",
      shareDir: cfg.wasmShareDir,
      home: cfg.wasmHome,
      share: cfg.wasmShare,
      env: cfg.kicadEnv,
      token,
      publishEvents: cfg.relayEvents,
    };
    cfg.log(`session ${this.id}: loading ${init.moduleUrl} in a worker${init.projectDir ? ` (project ${init.projectDir})` : ""}`);

    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { type: "module" });
    } catch (e) {
      this.fail(`cannot start the wasm worker: ${errorMessage(e)}`);
      throw new Error(this.error!);
    }
    this.worker = worker;
    worker.addEventListener("message", (ev) => this.onWorkerMessage((ev as MessageEvent<FromWasmWorker>).data));
    worker.addEventListener("error", (ev) => {
      const message = (ev as unknown as { message?: string }).message ?? "worker error";
      this.pushLog(`[worker] ${message}`);
      this.onWorkerState?.("failed", message);
      if (this.state === "running" && !this.stopping) this.crash(message);
    });

    const transport = new WasmWorkerTransport((m, t) => worker.postMessage(m, t ?? []), {
      defaultTimeoutMs: cfg.requestTimeoutMs,
      onTimeout: (message) => this.crash(message),
    });
    this.transport = transport;

    const deadline = Date.now() + cfg.startTimeoutMs;
    try {
      worker.postMessage({ start: init } satisfies ToWasmWorker);
      await this.awaitRunning(deadline);
      this.kicadToken = await pingUntilReady(transport, {
        timeoutMs: Math.max(1000, deadline - Date.now()),
        clientName: `fp-pcb/bridge/${this.id}`,
        isCancelled: () => this.state !== "starting",
      });
      if (this.state !== "starting") throw new Error(this.error ?? `the wasm session is ${this.state}`);
      this.state = "running";
      this.readyAt = new Date();
      cfg.log(`session ${this.id}: running in a worker (token ${this.kicadToken}) after ${Date.now() - this.startedAt.getTime()} ms`);
      this.broadcast({ type: "server-state", sessionId: this.id, state: "running", kicadToken: this.kicadToken });
      // The module publishes events in-process, so there is nothing to dial and nothing to retry:
      // either `publishEvents` was on and frames arrive, or the session never has events.
      if (cfg.relayEvents) this.setEventsState("connected", this.eventsSocketPath ?? undefined);
    } catch (e) {
      const message = this.error ?? `${errorMessage(e)}${this.tailLog()}`;
      await this.stop();
      this.fail(message);
      throw new Error(message);
    }
  }

  /** Stop the module, then the thread. `terminate()` always runs: a wedged worker must still go. */
  async stop(): Promise<void> {
    this.stopping = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      // Give the worker a moment to flush MEMFS and call `kiapi_shutdown`, then take the thread.
      const exited = new Promise<void>((r) => {
        this.onWorkerState = (state) => {
          if (state === "exited" || state === "failed") r();
        };
        setTimeout(r, this.cfg.wasmStopTimeoutMs);
      });
      try {
        worker.postMessage({ stop: true } satisfies ToWasmWorker);
      } catch {
        /* the thread is already gone */
      }
      await exited;
      this.onWorkerState = null;
      worker.terminate();
    }
    await this.transport?.close();
    if (this.state === "running" || this.state === "starting") this.state = "exited";
    this.setEventsState("disconnected", "session stopped");
    for (const ws of this.clients) {
      try {
        ws.close(1001, "session closed");
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.eventListeners.clear();
    this.eventsStateListeners.clear();
  }

  // ---------------------------------------------------------------- worker plumbing

  private onWorkerMessage(m: FromWasmWorker): void {
    if ("res" in m) {
      this.transport?.resolve(m.id, m.res);
      return;
    }
    if ("id" in m && "error" in m) {
      this.transport?.rejectOne(m.id, m.error);
      return;
    }
    if ("event" in m) {
      this.relayEvent(m.event);
      return;
    }
    if ("log" in m) {
      this.pushLog(m.log);
      return;
    }
    if ("state" in m) {
      this.onWorkerState?.(m.state, m.message);
      if (m.state === "failed" && this.state === "running" && !this.stopping) this.crash(m.message ?? "the wasm module failed");
      return;
    }
    if ("error" in m) {
      this.pushLog(`[worker] ${m.error}`);
      if (this.state === "running" && !this.stopping) this.crash(m.error);
    }
  }

  /** Resolve once the worker reports `running`, or reject on `failed` / the start deadline. */
  private awaitRunning(deadline: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.onWorkerState = null;
          reject(new Error(`the wasm module did not load within ${this.cfg.startTimeoutMs} ms${this.tailLog()}`));
        },
        Math.max(1000, deadline - Date.now()),
      );
      this.onWorkerState = (state, message) => {
        if (state === "starting") return;
        clearTimeout(timer);
        this.onWorkerState = null;
        if (state === "running") resolve();
        else reject(new Error(message ?? `the wasm worker is ${state}${this.tailLog()}`));
      };
    });
  }

  private relayEvent(event: Uint8Array): void {
    this.eventsRelayed++;
    const frame = encodeEventFrame(event);
    for (const ws of this.clients) {
      try {
        ws.send(frame);
      } catch {
        /* ignore */
      }
    }
    for (const cb of [...this.eventListeners]) {
      try {
        cb(event);
      } catch (e) {
        this.cfg.log(`session ${this.id}: event listener threw: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * The unrecoverable path: a request that never came back, a worker error, a module that reported
   * failure while running. Terminate the thread, fail everything in flight and mark the session
   * `failed` — the same end state a `kicad-cli` crash produces, minus the exit code.
   */
  private crash(message: string): void {
    if (this.state === "failed" || this.stopping) return;
    this.cfg.log(`session ${this.id}: ${message}`);
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    this.state = "failed";
    this.error = message;
    this.transport?.failAll(new TransportError("closed", message));
    void this.transport?.close();
    this.setEventsState("disconnected", message);
    this.broadcast({ type: "server-state", sessionId: this.id, state: "failed", exitCode: null, signal: null, message });
  }

  private fail(message: string): void {
    this.state = "failed";
    this.error = message;
  }

  private setEventsState(state: BridgeEventsState, message?: string): void {
    if (this.eventsState === state) return;
    this.eventsState = state;
    this.cfg.log(`session ${this.id}: events ${state}${message ? ` (${message})` : ""}`);
    this.broadcast({ type: "events", sessionId: this.id, state, message });
    for (const cb of [...this.eventsStateListeners]) {
      try {
        cb(state, message);
      } catch {
        /* ignore */
      }
    }
  }

  private pushLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > LOG_RING) this.logLines.splice(0, this.logLines.length - LOG_RING);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
