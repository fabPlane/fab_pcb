/**
 * `NngIpcTransport` — Bun-only transport that dials `kicad-cli api-server`'s nng REQ/REP socket
 * over `ipc://<path>` with `Bun.connect({ unix })`. No dependencies.
 *
 * - SP handshake with peer verification (we are REQ0, the peer must be REP0).
 * - 9-byte nng IPC framing, 4-byte REQ0 request ids.
 * - Strictly one request in flight (REQ/REP semantics); `send()` calls are queued FIFO so callers
 *   may pipeline freely.
 * - Per-request timeout. A timed-out request leaves its id in a "stale" set so the late reply is
 *   dropped instead of being mis-delivered.
 * - Optional reconnect with exponential backoff when the peer closes the socket unexpectedly (the
 *   KiCad process exited or restarted). The in-flight request is rejected with `closed`; queued
 *   requests survive a successful reconnect.
 */

import { TransportError, type SendOptions, type Transport, type TransportState } from "./types";
import {
  NngFrameParser,
  REQ_ID_FLAG,
  SP_PROTO_REP0,
  SP_PROTO_REQ0,
  encodeNngFrame,
  encodeReqBody,
  encodeSpHandshake,
  splitReqBody,
} from "./nng-framing";

export interface ReconnectOptions {
  /** Give up (state -> 'closed') after this many consecutive failed attempts. Default: Infinity. */
  maxAttempts?: number;
  /** Delay before the first retry. Default 100 ms. */
  initialDelayMs?: number;
  /** Cap on the backoff delay. Default 5000 ms. */
  maxDelayMs?: number;
  /** Backoff multiplier. Default 2. */
  factor?: number;
}

export interface NngIpcOptions {
  /** Unix socket path, e.g. `/tmp/kicad/api.sock` (the `ipc://` prefix is accepted and stripped). */
  path: string;
  /** Time allowed for dial + SP handshake. Default 5000 ms. */
  connectTimeoutMs?: number;
  /** Default per-request timeout when `send()` gets no `timeoutMs`. `0` disables. Default 30 000 ms. */
  defaultTimeoutMs?: number;
  /** Reconnect with backoff when the socket drops. `true` uses the defaults. Default: off. */
  reconnect?: boolean | ReconnectOptions;
  /**
   * What to do with the connection after a request times out. `'keep'` (default) keeps the socket
   * and drops the late reply when it arrives; `'reconnect'` tears the socket down so the server
   * side abandons the stuck request too (a reconnect follows only if `reconnect` is enabled).
   */
  onTimeout?: "keep" | "reconnect";
  /** Reject frames larger than this. Default 256 MiB. */
  maxFrameBytes?: number;
  /** Diagnostic logger. */
  log?: (message: string) => void;
}

type BunSocket = Awaited<ReturnType<typeof Bun.connect>>;

interface Connection {
  sock: BunSocket | null;
  parser: NngFrameParser;
  /** Bytes not yet accepted by the kernel; flushed on `drain`. */
  writeBacklog: Uint8Array | null;
  closed: boolean;
}

interface Pending {
  id: number;
  payload: Uint8Array;
  timeoutMs: number;
  resolve: (reply: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  maxAttempts: Number.POSITIVE_INFINITY,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  factor: 2,
};

export class NngIpcTransport implements Transport {
  readonly path: string;
  private readonly connectTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly reconnect: Required<ReconnectOptions> | null;
  private readonly onTimeout: "keep" | "reconnect";
  private readonly maxFrameBytes: number | undefined;
  private readonly log: (message: string) => void;

  private _state: TransportState = "connecting";
  private readonly stateListeners = new Set<(s: TransportState) => void>();

  private conn: Connection | null = null;
  private queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private nextId = 1;
  private readonly staleIds = new Set<number>();

  private closedByUser = false;
  private everOpened = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: Error | null = null;

  /** Dial and resolve once the SP handshake has completed. Rejects with `TransportError('connect')`. */
  static async connect(opts: string | NngIpcOptions): Promise<NngIpcTransport> {
    const t = new NngIpcTransport(opts);
    await t.ready();
    return t;
  }

  /** Starts dialing immediately; `state` is `'connecting'` until the handshake completes. */
  constructor(opts: string | NngIpcOptions) {
    const o: NngIpcOptions = typeof opts === "string" ? { path: opts } : opts;
    this.path = o.path.startsWith("ipc://") ? o.path.slice("ipc://".length) : o.path;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 5000;
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? 30_000;
    this.reconnect = o.reconnect ? { ...DEFAULT_RECONNECT, ...(o.reconnect === true ? {} : o.reconnect) } : null;
    this.onTimeout = o.onTimeout ?? "keep";
    this.maxFrameBytes = o.maxFrameBytes;
    this.log = o.log ?? (() => {});
    void this.dial();
  }

  get state(): TransportState {
    return this._state;
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Resolves when the transport is open; rejects if it closes first. */
  ready(): Promise<void> {
    if (this._state === "open") return Promise.resolve();
    if (this._state === "closed") {
      return Promise.reject(this.lastError ?? new TransportError("closed", `transport to ${this.path} is closed`));
    }
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s) => {
        if (s === "open") {
          off();
          resolve();
        } else if (s === "closed") {
          off();
          reject(this.lastError ?? new TransportError("closed", `transport to ${this.path} is closed`));
        }
      });
    });
  }

  /** Number of requests waiting behind the one in flight. */
  get queued(): number {
    return this.queue.length;
  }

  send(request: Uint8Array, opts: SendOptions = {}): Promise<Uint8Array> {
    if (this.closedByUser || this._state === "closed") {
      return Promise.reject(this.lastError ?? new TransportError("closed", `transport to ${this.path} is closed`));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      this.queue.push({
        id: 0,
        payload: request,
        timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
        resolve,
        reject,
        timer: null,
      });
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const err = new TransportError("closed", `transport to ${this.path} closed`);
    this.failAll(err);
    this.dropConnection();
    this.setState("closed");
  }

  // ---------------------------------------------------------------- connection lifecycle

  private async dial(): Promise<void> {
    if (this.closedByUser) return;
    this.setState("connecting");
    const conn: Connection = {
      sock: null,
      parser: new NngFrameParser({ expectPeerProto: SP_PROTO_REP0, maxFrameBytes: this.maxFrameBytes }),
      writeBacklog: null,
      closed: false,
    };
    this.conn = conn;

    const connectTimer = setTimeout(() => {
      if (this.conn === conn && this._state !== "open") {
        this.log(`connect to ${this.path} timed out after ${this.connectTimeoutMs} ms`);
        this.onConnectFailure(conn, new TransportError("connect", `connect to ${this.path} timed out`));
      }
    }, this.connectTimeoutMs);

    try {
      const sock = await Bun.connect({
        unix: this.path,
        socket: {
          open: (s) => {
            s.write(encodeSpHandshake(SP_PROTO_REQ0));
          },
          data: (_s, chunk) => this.onData(conn, chunk),
          drain: () => this.onDrain(conn),
          close: () => this.onSocketClosed(conn, null),
          error: (_s, e) => this.onSocketClosed(conn, e),
          connectError: (_s, e) => this.onConnectFailure(conn, e),
          end: () => this.onSocketClosed(conn, null),
        },
      });
      if (this.conn !== conn || conn.closed) {
        // superseded (close() or timeout raced the dial)
        clearTimeout(connectTimer);
        sock.end();
        return;
      }
      conn.sock = sock;
      // handshake completion is observed in onData; clear the timer there
      const off = this.onStateChange((s) => {
        if (s !== "connecting") {
          clearTimeout(connectTimer);
          off();
        }
      });
    } catch (e) {
      clearTimeout(connectTimer);
      this.onConnectFailure(conn, e);
    }
  }

  private onConnectFailure(conn: Connection, cause: unknown): void {
    if (this.conn !== conn || conn.closed) return;
    conn.closed = true;
    this.conn = null;
    conn.sock?.end();
    const err =
      cause instanceof TransportError
        ? cause
        : new TransportError("connect", `connect to ${this.path} failed: ${errorMessage(cause)}`, { cause });
    this.lastError = err;
    this.log(err.message);
    this.afterDisconnect(err);
  }

  private onSocketClosed(conn: Connection, cause: unknown): void {
    if (this.conn !== conn || conn.closed) return;
    conn.closed = true;
    this.conn = null;
    const err = this.everOpened
      ? new TransportError("closed", `socket ${this.path} closed by peer${cause ? `: ${errorMessage(cause)}` : ""}`, {
          cause: cause ?? undefined,
        })
      : new TransportError("connect", `socket ${this.path} closed during handshake`, { cause: cause ?? undefined });
    this.lastError = err;
    this.log(err.message);
    if (this.inFlight) {
      const p = this.inFlight;
      this.inFlight = null;
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.afterDisconnect(err);
  }

  /** Decide between reconnecting and closing for good. */
  private afterDisconnect(err: Error): void {
    if (this.closedByUser) return;
    if (this.reconnect && this.attempt < this.reconnect.maxAttempts) {
      const delay = Math.min(this.reconnect.maxDelayMs, this.reconnect.initialDelayMs * Math.pow(this.reconnect.factor, this.attempt));
      this.attempt += 1;
      this.setState("connecting");
      this.log(`reconnect attempt ${this.attempt} in ${delay} ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.dial();
      }, delay);
      return;
    }
    this.failAll(err);
    this.setState("closed");
  }

  private dropConnection(): void {
    const conn = this.conn;
    if (!conn) return;
    conn.closed = true;
    this.conn = null;
    try {
      conn.sock?.end();
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- data path

  private onData(conn: Connection, chunk: Uint8Array): void {
    if (this.conn !== conn || conn.closed) return;
    let bodies: Uint8Array[];
    try {
      // Copy: Bun may reuse the incoming buffer after the callback returns.
      bodies = conn.parser.push(new Uint8Array(chunk));
    } catch (e) {
      const err = e instanceof TransportError ? e : new TransportError("protocol", errorMessage(e), { cause: e });
      this.log(`protocol error: ${err.message}`);
      this.lastError = err;
      conn.closed = true;
      this.conn = null;
      conn.sock?.end();
      if (this.inFlight) {
        const p = this.inFlight;
        this.inFlight = null;
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.afterDisconnect(err);
      return;
    }
    if (this._state === "connecting" && conn.parser.handshaken) {
      this.everOpened = true;
      this.attempt = 0;
      this.setState("open");
      this.pump();
    }
    for (const body of bodies) this.onMessage(body);
  }

  private onMessage(body: Uint8Array): void {
    let id: number;
    let payload: Uint8Array;
    try {
      ({ id, payload } = splitReqBody(body));
    } catch (e) {
      this.log(`dropping malformed reply: ${errorMessage(e)}`);
      return;
    }
    const p = this.inFlight;
    if (p && p.id === id) {
      this.inFlight = null;
      if (p.timer) clearTimeout(p.timer);
      p.resolve(payload);
      this.pump();
      return;
    }
    if (this.staleIds.delete(id)) {
      this.log(`dropping late reply for timed-out request 0x${id.toString(16)}`);
      return;
    }
    this.log(`dropping reply with unknown request id 0x${id.toString(16)}`);
  }

  private onDrain(conn: Connection): void {
    if (this.conn !== conn || !conn.sock || !conn.writeBacklog) return;
    const backlog = conn.writeBacklog;
    conn.writeBacklog = null;
    this.writeAll(conn, backlog);
  }

  private writeAll(conn: Connection, bytes: Uint8Array): void {
    if (!conn.sock) return;
    const n = conn.sock.write(bytes);
    if (n < bytes.length) {
      conn.writeBacklog = bytes.subarray(Math.max(n, 0));
    }
  }

  private pump(): void {
    if (this._state !== "open" || this.inFlight || this.queue.length === 0) return;
    const conn = this.conn;
    if (!conn || !conn.sock) return;
    const p = this.queue.shift()!;
    p.id = this.allocId();
    this.inFlight = p;
    if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) {
      p.timer = setTimeout(() => this.onRequestTimeout(p), p.timeoutMs);
    }
    this.writeAll(conn, encodeNngFrame(encodeReqBody(p.id, p.payload)));
  }

  private onRequestTimeout(p: Pending): void {
    if (this.inFlight !== p) return;
    this.inFlight = null;
    p.timer = null;
    this.staleIds.add(p.id);
    if (this.staleIds.size > 1024) {
      // bounded: forget the oldest ids
      const it = this.staleIds.values();
      for (let i = 0; i < 512; i++) this.staleIds.delete(it.next().value!);
    }
    p.reject(new TransportError("timeout", `request 0x${p.id.toString(16)} timed out after ${p.timeoutMs} ms`));
    if (this.onTimeout === "reconnect") {
      const conn = this.conn;
      this.dropConnection();
      this.lastError = new TransportError("closed", `socket ${this.path} dropped after request timeout`);
      if (conn) this.afterDisconnect(this.lastError);
      return;
    }
    this.pump();
  }

  private allocId(): number {
    // 31-bit counter with the REQ0 flag; skip ids that may still be outstanding on the wire
    for (;;) {
      const id = ((this.nextId & 0x7fffffff) | REQ_ID_FLAG) >>> 0;
      this.nextId = (this.nextId % 0x7fffffff) + 1;
      if (!this.staleIds.has(id)) return id;
    }
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
    for (const p of q) p.reject(err);
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
