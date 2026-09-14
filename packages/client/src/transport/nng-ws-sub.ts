/**
 * `NngWsSubscriber` — KiCad's events socket (nng PUB0) over nng's WebSocket transport. Browser and
 * Bun both use the global `WebSocket`.
 *
 * When `--socket` is a `ws://` URL, KiCad publishes at `<socket>/events`
 * (`KICAD_API_SERVER::EventsUrlFor`), and `GetServerInfo.events_socket_url` reports that URL, so a
 * client can discover it the same way it does over ipc. Confirmed against the running server:
 *
 *     GetServerInfo -> { socket_url: "ws://127.0.0.1:5599/kicad",
 *                        events_socket_url: "ws://127.0.0.1:5599/kicad/events" }
 *
 * Wire format, measured (see `nng-ws.ts` for the full note): no 8-byte SP handshake and no 9-byte
 * length header — the subprotocol is `pub.sp.nanomsg.org` and each binary WebSocket frame is one
 * serialized `kiapi.common.events.Event`, byte for byte what KiCad published. Unlike the ipc
 * subscriber there is nothing to send after connecting: sub0's filtering is subscriber-side, so the
 * publisher fans out every message to every attached pipe.
 *
 * Events are fire-and-forget on KiCad's side: a subscriber that connects late or drops the socket
 * misses events. With `reconnect` on, the subscriber redials with backoff and the caller re-reads
 * state through the request socket.
 */
import { TransportError } from "./types";
import { SP_WS_SUBPROTOCOL_PUB0 } from "./nng-framing";
import { defaultCreateWebSocket, toBytes, type NngWebSocketLike } from "./nng-ws";
import type { Subscriber, SubscriberState } from "./nng-ipc-sub";

export interface NngWsSubscriberOptions {
  /** `ws://host:port/path/events` — from `GetServerInfo.events_socket_url`. */
  url: string;
  /** Time allowed for the WebSocket upgrade. Default 5000 ms. */
  connectTimeoutMs?: number;
  /** Redial with backoff when the socket drops (KiCad restarted). Default: off. */
  reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  /** Drop frames larger than this. Default 256 MiB. */
  maxFrameBytes?: number;
  /** Factory for the socket; defaults to the global `WebSocket`. */
  createWebSocket?: (url: string, protocols: string[]) => NngWebSocketLike;
  log?: (message: string) => void;
}

export class NngWsSubscriber implements Subscriber {
  readonly url: string;
  readonly subprotocol = SP_WS_SUBPROTOCOL_PUB0;
  private _state: SubscriberState = "connecting";
  private ws: NngWebSocketLike | null = null;
  /** Identity of the current dial; a stale socket's callbacks are ignored. */
  private generation = 0;
  private closedByUser = false;
  private lastError: TransportError | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageListeners = new Set<(body: Uint8Array) => void>();
  private readonly stateListeners = new Set<(s: SubscriberState, error?: Error) => void>();
  private readonly connectTimeoutMs: number;
  private readonly reconnect: { initialDelayMs: number; maxDelayMs: number; maxAttempts: number } | null;
  private readonly maxFrameBytes: number;
  private readonly createWebSocket: (url: string, protocols: string[]) => NngWebSocketLike;
  private readonly log: (m: string) => void;

  /** Dials and resolves once the WebSocket is open (`state === 'open'`). */
  static async connect(opts: string | NngWsSubscriberOptions): Promise<NngWsSubscriber> {
    const sub = new NngWsSubscriber(opts);
    await sub.ready();
    return sub;
  }

  constructor(opts: string | NngWsSubscriberOptions) {
    const o: NngWsSubscriberOptions = typeof opts === "string" ? { url: opts } : opts;
    this.url = o.url;
    if (!/^wss?:\/\//i.test(this.url)) {
      throw new TransportError("connect", `NngWsSubscriber needs a ws:// or wss:// URL, got '${this.url}'`);
    }
    this.connectTimeoutMs = o.connectTimeoutMs ?? 5000;
    this.reconnect = o.reconnect
      ? { initialDelayMs: 100, maxDelayMs: 5000, maxAttempts: Infinity, ...(typeof o.reconnect === "object" ? o.reconnect : {}) }
      : null;
    this.maxFrameBytes = o.maxFrameBytes ?? 256 * 1024 * 1024;
    this.createWebSocket = o.createWebSocket ?? defaultCreateWebSocket;
    this.log = o.log ?? (() => {});
    this.dial();
  }

  get state(): SubscriberState {
    return this._state;
  }

  onMessage(cb: (body: Uint8Array) => void): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onStateChange(cb: (state: SubscriberState, error?: Error) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Resolves when the subscriber is open; rejects if it closes first. */
  ready(): Promise<void> {
    if (this._state === "open") return Promise.resolve();
    if (this._state === "closed")
      return Promise.reject(this.lastError ?? new TransportError("closed", `subscriber to ${this.url} is closed`));
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s, err) => {
        if (s === "open") (off(), resolve());
        else if (s === "closed") (off(), reject(err ?? new TransportError("closed", `subscriber to ${this.url} closed`)));
      });
    });
  }

  async close(): Promise<void> {
    if (this.closedByUser) return;
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    this.setState("closed");
  }

  private setState(s: SubscriberState, error?: Error): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of Array.from(this.stateListeners)) cb(s, error);
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    try {
      ws?.close(1000, "");
    } catch {
      /* ignore */
    }
  }

  private dial(): void {
    if (this.closedByUser) return;
    this.setState("connecting");
    const gen = ++this.generation;
    let ws: NngWebSocketLike;
    try {
      ws = this.createWebSocket(this.url, [this.subprotocol]);
    } catch (e) {
      this.fail(gen, new TransportError("connect", `connect to ${this.url} failed: ${errorMessage(e)}`, { cause: e }));
      return;
    }
    this.ws = ws;
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* read-only in some fakes */
    }
    const connectTimer = setTimeout(() => {
      if (this.generation === gen && this._state !== "open") {
        this.fail(gen, new TransportError("connect", `connect to ${this.url} timed out after ${this.connectTimeoutMs} ms`));
      }
    }, this.connectTimeoutMs);

    ws.addEventListener("open", () => {
      if (this.generation !== gen) return;
      clearTimeout(connectTimer);
      const negotiated = ws.protocol;
      if (negotiated !== undefined && negotiated !== "" && negotiated !== this.subprotocol) {
        this.fail(
          gen,
          new TransportError("protocol", `${this.url} negotiated subprotocol '${negotiated}', expected '${this.subprotocol}'`),
        );
        return;
      }
      this.attempt = 0;
      this.setState("open");
    });
    ws.addEventListener("message", (ev) => {
      if (this.generation !== gen) return;
      if (typeof ev.data === "string") {
        this.log(`dropping unexpected text frame on ${this.url}`);
        return;
      }
      let body: Uint8Array;
      try {
        body = toBytes(ev.data);
      } catch (e) {
        this.log(`dropping unreadable event frame: ${errorMessage(e)}`);
        return;
      }
      if (body.length > this.maxFrameBytes) {
        this.fail(gen, new TransportError("protocol", `event frame of ${body.length} bytes exceeds limit ${this.maxFrameBytes}`));
        return;
      }
      const copy = body.slice();
      for (const cb of Array.from(this.messageListeners)) {
        try {
          cb(copy);
        } catch (e) {
          this.log(`event listener threw: ${errorMessage(e)}`);
        }
      }
    });
    ws.addEventListener("error", (ev) => {
      if (this.generation !== gen) return;
      this.log(`${this.url}: ${(ev as { message?: string })?.message ?? "WebSocket error"}`);
      // 'close' follows and drives the state machine.
    });
    ws.addEventListener("close", (ev) => {
      if (this.generation !== gen) return;
      clearTimeout(connectTimer);
      const detail = ev?.code ? ` (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : "";
      this.fail(
        gen,
        this._state === "open"
          ? new TransportError("closed", `events socket ${this.url} closed by peer${detail}`)
          : new TransportError("connect", `events socket ${this.url} closed before it opened${detail}`),
      );
    });
  }

  private fail(gen: number, err: TransportError): void {
    if (this.generation !== gen) return;
    this.lastError = err;
    this.log(err.message);
    this.drop();
    if (this.closedByUser) return;
    if (this.reconnect && this.attempt < this.reconnect.maxAttempts) {
      const delay = Math.min(this.reconnect.maxDelayMs, this.reconnect.initialDelayMs * 2 ** this.attempt);
      this.attempt++;
      this.setState("connecting", err);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.dial();
      }, delay);
      return;
    }
    this.setState("closed", err);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
