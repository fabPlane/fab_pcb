/**
 * `NngWsTransport` — dials `kicad-cli api-server`'s nng REQ/REP socket directly over nng's
 * WebSocket transport (`--socket ws://host:port/path`). Works in the browser and in Bun; both use
 * the global `WebSocket`. No bridge sits in the request path.
 *
 * ## What nng's ws transport actually puts on the wire
 *
 * Measured against `kicad-cli api-server --socket ws://127.0.0.1:5599/kicad` (KiCad fork
 * a99a1a803e, nng 1.12.2, 2026-09-07) with a raw WebSocket and a raw HTTP upgrade, *not* assumed
 * from the ipc framing:
 *
 * - **The 8-byte SP handshake is not sent as data.** It is replaced by the WebSocket subprotocol
 *   negotiation. The dialer must offer `Sec-WebSocket-Protocol: <peer>.sp.nanomsg.org`, naming the
 *   *peer's* protocol: `rep.sp.nanomsg.org` for KiCad's request socket, `pub.sp.nanomsg.org` for
 *   its events socket. The listener echoes the same value in the 101 response. Offering
 *   `req.sp.nanomsg.org` (our own protocol) gets `HTTP/1.1 400 Bad Request` — no upgrade at all.
 * - **The 9-byte nng frame header (`0x01` + big-endian uint64 length) is not present.** WebSocket
 *   frame boundaries delimit SP messages: one binary frame carries exactly one message. Sending an
 *   ipc-style framed message is silently dropped by the server (no reply, connection stays open).
 * - **The 4-byte big-endian REQ0 request id is present, exactly as over ipc**, and it must have the
 *   top bit set (`REQ_ID_FLAG`): rep0 walks the message header looking for the backtrace terminator,
 *   so an id without the flag, or a frame with no id at all, is dropped without a reply. The reply
 *   frame is `<echoed id><ApiResponse bytes>`.
 * - Several requests may be in flight on one socket (nng queues them and answers in order), but we
 *   keep one in flight and a FIFO queue, matching `NngIpcTransport` and REQ/REP semantics.
 *
 * So the wire format is `NngIpcTransport` minus the handshake frame and minus the length header:
 * send `encodeReqBody(id, request)` as one binary frame, read `splitReqBody(frame)` back.
 *
 * Behaviour otherwise matches `NngIpcTransport`: per-request timeout with a stale-id set so a late
 * reply is dropped rather than mis-delivered, optional reconnect with exponential backoff, queued
 * requests surviving a reconnect, and `TransportError('timeout'|'closed'|'protocol'|'connect')`.
 */

import { TransportError, type SendOptions, type Transport, type TransportState } from "./types";
import { REQ_ID_FLAG, SP_WS_SUBPROTOCOL_REP0, encodeReqBody, splitReqBody } from "./nng-framing";
import type { ReconnectOptions } from "./nng-ipc";

/** The subset of the WHATWG WebSocket API this transport needs (so tests can inject a fake). */
export interface NngWebSocketLike {
  binaryType: string;
  readonly protocol?: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: (ev: unknown) => void): void;
  addEventListener(type: "close", cb: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}

export interface NngWsOptions {
  /** `ws://host:port/path` or `wss://...` — the value passed to `kicad-cli api-server --socket`. */
  url: string;
  /** Time allowed for the WebSocket upgrade. Default 5000 ms. */
  connectTimeoutMs?: number;
  /** Default per-request timeout when `send()` gets no `timeoutMs`. `0` disables. Default 30 000 ms. */
  defaultTimeoutMs?: number;
  /** Reconnect with backoff when the socket drops. `true` uses the defaults. Default: off. */
  reconnect?: boolean | ReconnectOptions;
  /**
   * What to do with the connection after a request times out. `'keep'` (default) keeps the socket
   * and drops the late reply; `'reconnect'` tears it down so the server abandons the pipe too.
   */
  onTimeout?: "keep" | "reconnect";
  /** Reject reply frames larger than this. Default 256 MiB. */
  maxFrameBytes?: number;
  /** Factory for the socket; defaults to the global `WebSocket`. */
  createWebSocket?: (url: string, protocols: string[]) => NngWebSocketLike;
  /** Diagnostic logger. */
  log?: (message: string) => void;
}

interface Pending {
  id: number;
  payload: Uint8Array;
  timeoutMs: number;
  resolve: (reply: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Connection {
  ws: NngWebSocketLike;
  closed: boolean;
}

const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  maxAttempts: Number.POSITIVE_INFINITY,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  factor: 2,
};

/** Default socket factory: the global `WebSocket`, present in browsers and in Bun. */
export function defaultCreateWebSocket(url: string, protocols: string[]): NngWebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new TransportError("connect", "no global WebSocket in this runtime");
  }
  return new WebSocket(url, protocols) as unknown as NngWebSocketLike;
}

export class NngWsTransport implements Transport {
  readonly url: string;
  readonly subprotocol: string;
  private readonly connectTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly reconnectOpts: Required<ReconnectOptions> | null;
  private readonly onTimeout: "keep" | "reconnect";
  private readonly maxFrameBytes: number;
  private readonly createWebSocket: (url: string, protocols: string[]) => NngWebSocketLike;
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

  /** Dial and resolve once the WebSocket upgrade has completed. */
  static async connect(opts: string | NngWsOptions): Promise<NngWsTransport> {
    const t = new NngWsTransport(opts);
    await t.ready();
    return t;
  }

  /** Starts dialing immediately; `state` is `'connecting'` until the upgrade completes. */
  constructor(opts: string | NngWsOptions) {
    const o: NngWsOptions = typeof opts === "string" ? { url: opts } : opts;
    this.url = o.url;
    if (!/^wss?:\/\//i.test(this.url)) {
      throw new TransportError("connect", `NngWsTransport needs a ws:// or wss:// URL, got '${this.url}'`);
    }
    this.subprotocol = SP_WS_SUBPROTOCOL_REP0;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 5000;
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? 30_000;
    this.reconnectOpts = o.reconnect ? { ...DEFAULT_RECONNECT, ...(o.reconnect === true ? {} : o.reconnect) } : null;
    this.onTimeout = o.onTimeout ?? "keep";
    this.maxFrameBytes = o.maxFrameBytes ?? 256 * 1024 * 1024;
    this.createWebSocket = o.createWebSocket ?? defaultCreateWebSocket;
    this.log = o.log ?? (() => {});
    this.dial();
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
    if (this._state === "closed") return Promise.reject(this.closedError());
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s) => {
        if (s === "open") {
          off();
          resolve();
        } else if (s === "closed") {
          off();
          reject(this.closedError());
        }
      });
    });
  }

  /** Number of requests waiting behind the one in flight. */
  get queued(): number {
    return this.queue.length;
  }

  send(request: Uint8Array, opts: SendOptions = {}): Promise<Uint8Array> {
    if (this.closedByUser || this._state === "closed") return Promise.reject(this.closedError());
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
    this.lastError = new TransportError("closed", `transport to ${this.url} closed`);
    this.failAll(this.lastError);
    this.dropConnection(1000, "client closed");
    this.setState("closed");
  }

  // ---------------------------------------------------------------- connection lifecycle

  private dial(): void {
    if (this.closedByUser) return;
    this.setState("connecting");
    let ws: NngWebSocketLike;
    try {
      ws = this.createWebSocket(this.url, [this.subprotocol]);
    } catch (e) {
      this.onConnectFailure(null, e);
      return;
    }
    const conn: Connection = { ws, closed: false };
    this.conn = conn;
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* some fakes are read-only here */
    }

    const connectTimer = setTimeout(() => {
      if (this.conn === conn && this._state !== "open") {
        this.onConnectFailure(conn, new TransportError("connect", `connect to ${this.url} timed out after ${this.connectTimeoutMs} ms`));
      }
    }, this.connectTimeoutMs);
    const clear = () => clearTimeout(connectTimer);

    ws.addEventListener("open", () => {
      if (this.conn !== conn || conn.closed) return;
      clear();
      // nng's ws transport sends no SP handshake: a completed upgrade with the right subprotocol
      // is the handshake. Verify what the server selected when the runtime exposes it.
      const negotiated = conn.ws.protocol;
      if (negotiated !== undefined && negotiated !== "" && negotiated !== this.subprotocol) {
        this.onProtocolError(
          conn,
          new TransportError("protocol", `${this.url} negotiated subprotocol '${negotiated}', expected '${this.subprotocol}'`),
        );
        return;
      }
      this.everOpened = true;
      this.attempt = 0;
      this.setState("open");
      this.pump();
    });
    ws.addEventListener("message", (ev) => this.onFrame(conn, ev.data));
    ws.addEventListener("error", (ev) => {
      if (this.conn !== conn || conn.closed) return;
      const msg = (ev as { message?: string })?.message ?? "WebSocket error";
      this.lastError = new TransportError(this._state === "open" ? "closed" : "connect", `${this.url}: ${msg}`);
      this.log(this.lastError.message);
      // 'close' follows and drives the state machine.
    });
    ws.addEventListener("close", (ev) => {
      clear();
      if (this.conn !== conn || conn.closed) return;
      const detail = ev?.code ? ` (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : "";
      const err = this.everOpened
        ? new TransportError("closed", `WebSocket ${this.url} closed by peer${detail}`)
        : new TransportError("connect", `WebSocket ${this.url} closed before it opened${detail}`);
      this.onDisconnected(conn, err);
    });
  }

  private onConnectFailure(conn: Connection | null, cause: unknown): void {
    if (conn && (this.conn !== conn || conn.closed)) return;
    const err =
      cause instanceof TransportError
        ? cause
        : new TransportError("connect", `connect to ${this.url} failed: ${errorMessage(cause)}`, { cause });
    this.onDisconnected(conn, err);
  }

  private onProtocolError(conn: Connection, err: TransportError): void {
    this.onDisconnected(conn, err, 4001, "protocol error");
  }

  /** Single exit point for "this connection is gone": rejects the in-flight request, then decides. */
  private onDisconnected(conn: Connection | null, err: Error, code = 1000, reason = ""): void {
    if (conn) {
      conn.closed = true;
      if (this.conn === conn) this.conn = null;
      try {
        conn.ws.close(code, reason);
      } catch {
        /* already closing */
      }
    }
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
    if (this.reconnectOpts && this.attempt < this.reconnectOpts.maxAttempts) {
      const delay = Math.min(
        this.reconnectOpts.maxDelayMs,
        this.reconnectOpts.initialDelayMs * Math.pow(this.reconnectOpts.factor, this.attempt),
      );
      this.attempt += 1;
      this.setState("connecting");
      this.log(`reconnect attempt ${this.attempt} in ${delay} ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.dial();
      }, delay);
      return;
    }
    this.failAll(err);
    this.setState("closed");
  }

  private dropConnection(code = 1000, reason = ""): void {
    const conn = this.conn;
    if (!conn) return;
    conn.closed = true;
    this.conn = null;
    try {
      conn.ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- data path

  private onFrame(conn: Connection, data: unknown): void {
    if (this.conn !== conn || conn.closed) return;
    if (typeof data === "string") {
      this.log(`dropping unexpected text frame (${data.length} chars)`);
      return;
    }
    let frame: Uint8Array;
    try {
      frame = toBytes(data);
    } catch (e) {
      this.log(`dropping unreadable frame: ${errorMessage(e)}`);
      return;
    }
    if (frame.length > this.maxFrameBytes) {
      this.onProtocolError(
        conn,
        new TransportError("protocol", `reply frame of ${frame.length} bytes exceeds limit ${this.maxFrameBytes}`),
      );
      return;
    }
    let id: number;
    let payload: Uint8Array;
    try {
      ({ id, payload } = splitReqBody(frame));
    } catch (e) {
      this.log(`dropping malformed reply: ${errorMessage(e)}`);
      return;
    }
    const p = this.inFlight;
    if (p && p.id === id) {
      this.inFlight = null;
      if (p.timer) clearTimeout(p.timer);
      // Copy so the caller owns a standalone buffer independent of the frame.
      p.resolve(payload.slice());
      this.pump();
      return;
    }
    if (this.staleIds.delete(id)) {
      this.log(`dropping late reply for timed-out request 0x${id.toString(16)}`);
      return;
    }
    this.log(`dropping reply with unknown request id 0x${id.toString(16)}`);
  }

  private pump(): void {
    if (this._state !== "open" || this.inFlight || this.queue.length === 0) return;
    const conn = this.conn;
    if (!conn || conn.closed) return;
    const p = this.queue.shift()!;
    p.id = this.allocId();
    this.inFlight = p;
    if (p.timeoutMs > 0 && Number.isFinite(p.timeoutMs)) {
      p.timer = setTimeout(() => this.onRequestTimeout(p), p.timeoutMs);
    }
    try {
      conn.ws.send(encodeReqBody(p.id, p.payload));
    } catch (e) {
      const err = new TransportError("closed", `send on ${this.url} failed: ${errorMessage(e)}`, { cause: e });
      this.onDisconnected(conn, err);
    }
  }

  private onRequestTimeout(p: Pending): void {
    if (this.inFlight !== p) return;
    this.inFlight = null;
    p.timer = null;
    this.staleIds.add(p.id);
    if (this.staleIds.size > 1024) {
      const it = this.staleIds.values();
      for (let i = 0; i < 512; i++) this.staleIds.delete(it.next().value!);
    }
    p.reject(new TransportError("timeout", `request 0x${p.id.toString(16)} timed out after ${p.timeoutMs} ms`));
    if (this.onTimeout === "reconnect") {
      const conn = this.conn;
      if (conn) this.onDisconnected(conn, new TransportError("closed", `WebSocket ${this.url} dropped after request timeout`));
      return;
    }
    this.pump();
  }

  private allocId(): number {
    // 31-bit counter with the REQ0 flag; rep0 needs the flag or it drops the message.
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

  private closedError(): Error {
    return this.lastError ?? new TransportError("closed", `transport to ${this.url} is closed`);
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

/** Normalise a WebSocket binary payload (ArrayBuffer / TypedArray / Buffer) to a `Uint8Array` view. */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TransportError("protocol", `expected a binary WebSocket frame, got ${typeof data}`);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
