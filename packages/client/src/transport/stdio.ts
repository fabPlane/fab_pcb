/**
 * `StdioTransport` — Bun-only transport that speaks the KiCad API envelope to a child process over
 * pipes instead of a socket. It is the native counterpart of `WasmTransport`: the same headless
 * KiCad API core, hosted by `kicad-api-host-native`, which reads request frames on **stdin**,
 * writes reply frames on **stdout** and publishes event frames on **fd 3**.
 *
 * Framing (all three channels): `uint32 big-endian length` followed by that many bytes. The payload
 * is a serialized `kiapi.common.ApiRequest` / `ApiResponse` on stdin/stdout and a serialized
 * `kiapi.common.events.Event` on fd 3 — exactly the bytes the nng sockets carry, minus nng's own
 * SP framing.
 *
 * Like REP0, the host answers strictly one request at a time, so `send()` calls are queued FIFO and
 * replies are matched positionally (there is no request id on the wire). A request that times out
 * therefore leaves a "reply we no longer want" behind: the count is tracked and the late frame is
 * dropped instead of being handed to the next caller.
 *
 * fd 3 is used for events because Bun's `Bun.spawn` accepts extra `stdio` entries and exposes the
 * parent-side descriptor as a number (`proc.stdio[3]`). Hosts that cannot open fd 3 may be started
 * with `events: false`; `docs/08-wasm.md` records the convention for the C++ side.
 */

import { TransportError, type SendOptions, type Transport, type TransportState } from "./types";
import type { Subscriber, SubscriberState } from "./nng-ipc-sub";

/** Length prefix in front of every request, reply and event frame. */
export const STDIO_FRAME_HEADER_LENGTH = 4;
/** Child descriptor the host publishes events on. */
export const STDIO_EVENTS_FD = 3;

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** `uint32be length || payload`. */
export function encodeStdioFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(STDIO_FRAME_HEADER_LENGTH + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, STDIO_FRAME_HEADER_LENGTH);
  return out;
}

/** Incremental parser for the length-prefixed stream; `push()` returns the frames it completed. */
export class StdioFrameParser {
  private buf: Uint8Array = new Uint8Array(0);
  constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buf.length === 0) this.buf = chunk;
    else {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < STDIO_FRAME_HEADER_LENGTH) break;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(0, false);
      if (len > this.maxFrameBytes) {
        throw new TransportError("protocol", `frame of ${len} bytes exceeds the ${this.maxFrameBytes} byte limit`);
      }
      if (this.buf.length < STDIO_FRAME_HEADER_LENGTH + len) break;
      out.push(this.buf.slice(STDIO_FRAME_HEADER_LENGTH, STDIO_FRAME_HEADER_LENGTH + len));
      this.buf = this.buf.subarray(STDIO_FRAME_HEADER_LENGTH + len);
    }
    return out;
  }

  /** Bytes buffered behind an incomplete frame (diagnostics). */
  get pending(): number {
    return this.buf.length;
  }
}

export interface StdioTransportOptions {
  /** Executable to spawn, e.g. `kicad-api-host-native`. */
  command: string;
  /** Extra arguments (a document to preload, `--token`, ...). */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Default per-request timeout when `send()` gets no `timeoutMs`. `0` disables. Default 30 000 ms. */
  defaultTimeoutMs?: number;
  /** Open the fd 3 events channel. Default `true`. */
  events?: boolean;
  /** Reject frames larger than this. Default 256 MiB. */
  maxFrameBytes?: number;
  /** How long `close()` waits after SIGTERM before SIGKILL. Default 3000 ms. */
  killGraceMs?: number;
  /** Diagnostic logger. */
  log?: (message: string) => void;
}

interface Pending {
  payload: Uint8Array;
  timeoutMs: number;
  resolve: (reply: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class StdioTransport implements Transport {
  readonly command: string;
  private readonly defaultTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly log: (message: string) => void;

  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private _state: TransportState = "connecting";
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private readonly eventListeners = new Set<(bytes: Uint8Array) => void>();
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  /** Replies belonging to timed-out requests that are still on their way. */
  private orphanReplies = 0;
  private stderrChunks: string[] = [];
  private closedByUser = false;
  private lastError: Error | null = null;
  private _eventsOpen = false;

  /** Spawn the host and resolve once its pipes are up. Rejects with `TransportError('connect')`. */
  static async connect(opts: StdioTransportOptions | string): Promise<StdioTransport> {
    const t = new StdioTransport(opts);
    await t.ready();
    return t;
  }

  constructor(opts: StdioTransportOptions | string) {
    const o: StdioTransportOptions = typeof opts === "string" ? { command: opts } : opts;
    this.command = o.command;
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? 30_000;
    this.killGraceMs = o.killGraceMs ?? 3000;
    this.log = o.log ?? (() => {});
    const wantEvents = o.events !== false;
    const maxFrameBytes = o.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    try {
      const stdio = wantEvents ? (["pipe", "pipe", "pipe", "pipe"] as const) : (["pipe", "pipe", "pipe"] as const);
      const proc = Bun.spawn([o.command, ...(o.args ?? [])], {
        cwd: o.cwd,
        env: o.env ? ({ ...process.env, ...o.env } as Record<string, string>) : undefined,
        stdio: stdio as unknown as ["pipe", "pipe", "pipe"],
      }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
      this.proc = proc;
      // Resolve the events descriptor synchronously so a `StdioSubscriber` built right after the
      // constructor already reports `open`, the way `NngIpcSubscriber.connect()` does.
      const eventsFd = wantEvents ? (proc as unknown as { stdio?: unknown[] }).stdio?.[STDIO_EVENTS_FD] : undefined;
      if (wantEvents && typeof eventsFd !== "number") {
        this.log(`events fd ${STDIO_EVENTS_FD} is not available on this Bun build; events are off`);
      }
      this._eventsOpen = typeof eventsFd === "number";
      void this.pumpStdout(proc, maxFrameBytes);
      void this.pumpStderr(proc);
      if (typeof eventsFd === "number") void this.pumpEvents(eventsFd, maxFrameBytes);
      void proc.exited.then((code) => this.onExit(code));
      this.setState("open");
    } catch (e) {
      this.lastError = new TransportError("connect", `spawning ${o.command} failed: ${errorMessage(e)}`, { cause: e });
      this.log(this.lastError.message);
      this.setState("closed");
    }
  }

  get state(): TransportState {
    return this._state;
  }

  /** True while the fd 3 events channel is readable. */
  get eventsOpen(): boolean {
    return this._eventsOpen;
  }

  /** Number of requests waiting behind the one in flight. */
  get queued(): number {
    return this.queue.length;
  }

  /** Exit code of the host process, or `null` while it runs. */
  get exitCode(): number | null {
    return this.proc?.exitCode ?? null;
  }

  /** Everything the host wrote to stderr so far (crash diagnostics). */
  stderr(): string {
    return this.stderrChunks.join("");
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Raw event frames from fd 3. Wrap with `StdioSubscriber` for the `Subscriber` interface. */
  onEvent(cb: (bytes: Uint8Array) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  /** Resolves when the host is up; rejects if it failed to start. */
  ready(): Promise<void> {
    if (this._state === "open") return Promise.resolve();
    if (this._state === "closed") {
      return Promise.reject(this.lastError ?? new TransportError("closed", `${this.command} is closed`));
    }
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s) => {
        if (s === "open") (off(), resolve());
        else if (s === "closed") (off(), reject(this.lastError ?? new TransportError("closed", `${this.command} is closed`)));
      });
    });
  }

  send(request: Uint8Array, opts: SendOptions = {}): Promise<Uint8Array> {
    if (this._state === "closed") {
      return Promise.reject(this.lastError ?? new TransportError("closed", `${this.command} is closed`));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      this.queue.push({ payload: request, timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs, resolve, reject, timer: null });
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    const err = new TransportError("closed", `${this.command} closed`);
    this.failAll(err);
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.stdin.end();
      } catch {
        /* already gone */
      }
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), this.killGraceMs);
      await proc.exited;
      clearTimeout(t);
    }
    this._eventsOpen = false;
    this.setState("closed");
  }

  // ---------------------------------------------------------------- data path

  private async pumpStdout(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, maxFrameBytes: number): Promise<void> {
    const parser = new StdioFrameParser(maxFrameBytes);
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value;
        let frames: Uint8Array[];
        try {
          frames = parser.push(new Uint8Array(chunk));
        } catch (e) {
          const err = e instanceof TransportError ? e : new TransportError("protocol", errorMessage(e), { cause: e });
          this.lastError = err;
          this.log(`protocol error: ${err.message}`);
          this.failAll(err);
          void this.close();
          return;
        }
        for (const frame of frames) this.onReply(frame);
      }
    } catch (e) {
      this.log(`stdout stream ended: ${errorMessage(e)}`);
    }
  }

  private async pumpEvents(fd: number, maxFrameBytes: number): Promise<void> {
    const parser = new StdioFrameParser(maxFrameBytes);
    const reader = Bun.file(fd).stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value;
        let frames: Uint8Array[];
        try {
          frames = parser.push(new Uint8Array(chunk));
        } catch (e) {
          this.log(`dropping events channel: ${errorMessage(e)}`);
          break;
        }
        for (const frame of frames) for (const cb of Array.from(this.eventListeners)) cb(frame);
      }
    } catch (e) {
      this.log(`events fd ${STDIO_EVENTS_FD} ended: ${errorMessage(e)}`);
    }
    this._eventsOpen = false;
  }

  private async pumpStderr(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    try {
      const dec = new TextDecoder();
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrChunks.push(dec.decode(value, { stream: true }));
        if (this.stderrChunks.length > 4096) this.stderrChunks = this.stderrChunks.slice(-2048);
      }
    } catch {
      /* the process is gone; stop collecting */
    }
  }

  private onReply(frame: Uint8Array): void {
    if (this.orphanReplies > 0) {
      this.orphanReplies--;
      this.log(`dropping late reply for a timed-out request (${this.orphanReplies} still outstanding)`);
      return;
    }
    const p = this.inFlight;
    if (!p) {
      this.log(`dropping unsolicited reply of ${frame.length} bytes`);
      return;
    }
    this.inFlight = null;
    if (p.timer) clearTimeout(p.timer);
    p.resolve(frame);
    this.pump();
  }

  private onExit(code: number | null): void {
    if (this.closedByUser) return;
    const tail = this.stderr().trim().split("\n").slice(-3).join(" | ");
    const err = new TransportError("closed", `${this.command} exited with code ${code}${tail ? `: ${tail}` : ""}`);
    this.lastError = err;
    this.log(err.message);
    this._eventsOpen = false;
    this.failAll(err);
    this.setState("closed");
  }

  private pump(): void {
    if (this._state !== "open" || this.inFlight || this.queue.length === 0) return;
    const proc = this.proc;
    if (!proc) return;
    const p = this.queue.shift()!;
    this.inFlight = p;
    if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) {
      p.timer = setTimeout(() => this.onRequestTimeout(p), p.timeoutMs);
    }
    try {
      proc.stdin.write(encodeStdioFrame(p.payload));
      proc.stdin.flush();
    } catch (e) {
      const err = new TransportError("closed", `writing to ${this.command} failed: ${errorMessage(e)}`, { cause: e });
      this.lastError = err;
      this.inFlight = null;
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
      this.failAll(err);
      this.setState("closed");
    }
  }

  private onRequestTimeout(p: Pending): void {
    if (this.inFlight !== p) return;
    this.inFlight = null;
    p.timer = null;
    // The host will still answer this one; without request ids the only correlation is order.
    this.orphanReplies++;
    p.reject(new TransportError("timeout", `request to ${this.command} timed out after ${p.timeoutMs} ms`));
    this.pump();
  }

  private failAll(err: Error): void {
    if (this.inFlight) {
      const p = this.inFlight;
      this.inFlight = null;
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    const q = this.queue;
    this.queue = [];
    for (const p of q) {
      if (p.timer) clearTimeout(p.timer);
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
 * `Subscriber` over a `StdioTransport`'s fd 3 channel, so `KiCadEvents` works the same as with
 * `NngIpcSubscriber`. `open` while the host runs with events enabled, `closed` once the process is
 * gone or `close()` was called. Closing the subscriber detaches; it never kills the host.
 */
export class StdioSubscriber implements Subscriber {
  private readonly messageListeners = new Set<(body: Uint8Array) => void>();
  private readonly stateListeners = new Set<(s: SubscriberState, error?: Error) => void>();
  private _state: SubscriberState;
  private detach: (() => void) | undefined;

  constructor(readonly transport: StdioTransport) {
    this._state = transport.state === "closed" ? "closed" : transport.eventsOpen ? "open" : "connecting";
    const offEvent = transport.onEvent((b) => {
      if (this._state === "connecting") this.setState("open");
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
