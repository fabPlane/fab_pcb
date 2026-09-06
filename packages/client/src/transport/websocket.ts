/**
 * `WebSocketTransport` — talks to `@kicad-web/bridge` from a browser or from Bun.
 *
 * Every request gets a 4-byte correlation id; many may be in flight at once on the WebSocket
 * (the bridge serialises them onto KiCad's single REQ/REP socket). Control messages from the
 * bridge (`hello`, `server-state`, `error`) are surfaced via `onControl()` and the
 * `sessionId` / `kicadToken` / `serverState` getters.
 */

import { TransportError, type SendOptions, type Transport, type TransportErrorCode, type TransportState } from "./types";
import {
  type BridgeControlMessage,
  type KiCadServerState,
  decodeWsFrame,
  encodeControl,
  encodeWsFrame,
  parseControl,
  toUint8Array,
} from "./ws-bridge-protocol";

/** The subset of the WHATWG WebSocket API we use (so tests and non-standard runtimes can inject one). */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: (ev: unknown) => void): void;
  addEventListener(type: "close", cb: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}

export interface WebSocketTransportOptions {
  /** Default per-request timeout when `send()` gets no `timeoutMs`. `0` disables. Default 60 000 ms. */
  defaultTimeoutMs?: number;
  /** Time allowed for the socket to open and the bridge `hello` to arrive. Default 10 000 ms. */
  connectTimeoutMs?: number;
  /** Send a `ping` control frame this often to keep proxies and the bridge's idle timeout happy. `0` disables. Default 30 000 ms. */
  keepaliveMs?: number;
  /** Factory for the underlying socket; defaults to the global `WebSocket`. */
  createWebSocket?: (url: string) => WebSocketLike;
  log?: (message: string) => void;
}

interface Pending {
  resolve: (reply: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WebSocketTransport implements Transport {
  readonly url: string;
  private readonly ws: WebSocketLike;
  private readonly defaultTimeoutMs: number;
  private readonly log: (message: string) => void;

  private _state: TransportState = "connecting";
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private readonly controlListeners = new Set<(m: BridgeControlMessage) => void>();

  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private lastError: Error | null = null;
  private closedByUser = false;
  private socketOpen = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private _sessionId: string | null = null;
  private _kicadToken: string | null = null;
  private _serverState: KiCadServerState | null = null;

  static async connect(url: string | URL, opts?: WebSocketTransportOptions): Promise<WebSocketTransport> {
    const t = new WebSocketTransport(url, opts);
    await t.ready();
    return t;
  }

  constructor(url: string | URL, opts: WebSocketTransportOptions = {}) {
    this.url = typeof url === "string" ? url : url.toString();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.log = opts.log ?? (() => {});
    const create = opts.createWebSocket ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    this.ws = create(this.url);
    this.ws.binaryType = "arraybuffer";

    const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    const connectTimer = setTimeout(() => {
      if (this._state === "connecting") {
        this.lastError = new TransportError("connect", `connect to ${this.url} timed out after ${connectTimeoutMs} ms`);
        this.ws.close(4000, "connect timeout");
        this.finish();
      }
    }, connectTimeoutMs);

    this.ws.addEventListener("open", () => {
      this.socketOpen = true;
      // 'open' state waits for the bridge hello so sessionId/kicadToken are known to callers
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    this.ws.addEventListener("error", (ev) => {
      const msg = (ev as { message?: string })?.message ?? "WebSocket error";
      this.lastError = new TransportError(this._state === "connecting" ? "connect" : "closed", `${this.url}: ${msg}`);
      this.log(this.lastError.message);
    });
    this.ws.addEventListener("close", (ev) => {
      clearTimeout(connectTimer);
      if (!this.lastError || this._state === "open") {
        const detail = ev.code ? ` (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : "";
        this.lastError = new TransportError(
          this._state === "connecting" ? "connect" : "closed",
          `WebSocket ${this.url} closed${detail}`,
        );
      }
      this.finish();
    });
    const off = this.onStateChange((s) => {
      if (s !== "connecting") {
        clearTimeout(connectTimer);
        off();
      }
    });
    if ((opts.keepaliveMs ?? 30_000) > 0) {
      this.keepaliveTimer = setInterval(() => {
        if (this._state === "open") {
          try {
            this.ws.send(encodeControl({ type: "ping", t: Date.now() }));
          } catch {
            /* ignore */
          }
        }
      }, opts.keepaliveMs ?? 30_000);
    }
  }

  get state(): TransportState {
    return this._state;
  }

  /** Session id announced by the bridge in `hello`. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /** KiCad token announced by the bridge (`hello` / `server-state`), null until the server is running. */
  get kicadToken(): string | null {
    return this._kicadToken;
  }

  /** Last known state of the KiCad process behind the session. */
  get serverState(): KiCadServerState | null {
    return this._serverState;
  }

  /** Number of requests awaiting a reply. */
  get inFlight(): number {
    return this.pending.size;
  }

  onStateChange(cb: (state: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Subscribe to bridge control messages (`hello`, `server-state`, `error`, `pong`). */
  onControl(cb: (m: BridgeControlMessage) => void): () => void {
    this.controlListeners.add(cb);
    return () => {
      this.controlListeners.delete(cb);
    };
  }

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

  async send(request: Uint8Array, opts: SendOptions = {}): Promise<Uint8Array> {
    if (this._state === "connecting") await this.ready();
    if (this._state !== "open") throw this.closedError();
    const id = this.allocId();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<Uint8Array>((resolve, reject) => {
      const p: Pending = { resolve, reject, timer: null };
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        p.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new TransportError("timeout", `request ${id} timed out after ${timeoutMs} ms`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, p);
      try {
        this.ws.send(encodeWsFrame(id, request));
      } catch (e) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new TransportError("closed", `send on ${this.url} failed: ${errorMessage(e)}`, { cause: e }));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    this.lastError = new TransportError("closed", `transport to ${this.url} closed`);
    try {
      this.ws.close(1000, "client closed");
    } catch {
      /* ignore */
    }
    this.finish();
  }

  // ---------------------------------------------------------------- internals

  private onMessage(data: unknown): void {
    if (typeof data === "string") {
      let m: BridgeControlMessage;
      try {
        m = parseControl(data);
      } catch (e) {
        this.log(`ignoring bad control frame: ${errorMessage(e)}`);
        return;
      }
      this.onControlMessage(m);
      return;
    }
    let id: number;
    let payload: Uint8Array;
    try {
      ({ id, payload } = decodeWsFrame(data as ArrayBufferLike | ArrayBufferView));
    } catch (e) {
      this.log(`ignoring bad binary frame: ${errorMessage(e)}`);
      return;
    }
    const p = this.pending.get(id);
    if (!p) {
      this.log(`dropping reply with unknown correlation id ${id}`);
      return;
    }
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    // Copy out of the frame so the caller owns a standalone buffer.
    p.resolve(payload.slice());
  }

  private onControlMessage(m: BridgeControlMessage): void {
    switch (m.type) {
      case "hello":
        this._sessionId = m.sessionId;
        this._kicadToken = m.kicadToken;
        this._serverState = m.serverState;
        if (this._state === "connecting" && this.socketOpen) this.setState("open");
        break;
      case "server-state":
        this._serverState = m.state;
        if (m.kicadToken !== undefined) this._kicadToken = m.kicadToken;
        break;
      case "error": {
        if (m.id !== null) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            if (p.timer) clearTimeout(p.timer);
            p.reject(new TransportError(mapErrorCode(m.code), `bridge: ${m.message}`));
          }
        } else {
          this.log(`bridge error: ${m.code}: ${m.message}`);
        }
        break;
      }
      case "ping":
        try {
          this.ws.send(encodeControl({ type: "pong", t: m.t }));
        } catch {
          /* ignore */
        }
        break;
      case "pong":
        break;
    }
    for (const cb of Array.from(this.controlListeners)) {
      try {
        cb(m);
      } catch (e) {
        this.log(`control listener threw: ${errorMessage(e)}`);
      }
    }
  }

  private finish(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    const err = this.closedError();
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.setState("closed");
  }

  private closedError(): Error {
    return this.lastError ?? new TransportError("closed", `transport to ${this.url} is closed`);
  }

  private allocId(): number {
    for (;;) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
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

function mapErrorCode(code: string): TransportErrorCode {
  switch (code) {
    case "timeout":
    case "closed":
    case "connect":
    case "protocol":
      return code;
    default:
      return "protocol";
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
