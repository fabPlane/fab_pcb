/**
 * `NngIpcSubscriber` — Bun-only subscriber for KiCad's events socket (nng pub0 over `ipc://`).
 * The server publishes one serialized `kiapi.common.events.Event` per frame; there is no request
 * id and nothing is ever written after the SP handshake. Decoding lives in `../events`.
 *
 * Events are fire-and-forget on the KiCad side, so a subscriber that connects late or drops the
 * socket simply misses events; with `reconnect` on, the subscriber redials with backoff and the
 * caller re-reads state through the request socket.
 */
import { TransportError } from "./types";
import { NngFrameParser, SP_PROTO_PUB0, SP_PROTO_SUB0, encodeSpHandshake } from "./nng-framing";

export type SubscriberState = "connecting" | "open" | "closed";

/** What `events.ts` needs from a subscription: raw frames plus lifecycle. */
export interface Subscriber {
  readonly state: SubscriberState;
  onMessage(cb: (body: Uint8Array) => void): () => void;
  onStateChange(cb: (state: SubscriberState, error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface NngIpcSubscriberOptions {
  /** Unix socket path or `ipc://` URL of the events socket (from `GetServerInfo.events_socket_url`). */
  path: string;
  /** Time allowed for dial + SP handshake. Default 5000 ms. */
  connectTimeoutMs?: number;
  /** Redial with backoff when the socket drops (KiCad restarted). Default: off. */
  reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  maxFrameBytes?: number;
  log?: (message: string) => void;
}

type BunSocket = Awaited<ReturnType<typeof Bun.connect>>;

export class NngIpcSubscriber implements Subscriber {
  readonly path: string;
  private _state: SubscriberState = "connecting";
  private sock: BunSocket | null = null;
  private parser: NngFrameParser | null = null;
  private closedByUser = false;
  private lastError: TransportError | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageListeners = new Set<(body: Uint8Array) => void>();
  private readonly stateListeners = new Set<(s: SubscriberState, error?: Error) => void>();
  private readonly connectTimeoutMs: number;
  private readonly reconnect: { initialDelayMs: number; maxDelayMs: number; maxAttempts: number } | null;
  private readonly maxFrameBytes: number | undefined;
  private readonly log: (m: string) => void;

  /** Dials and resolves once the SP handshake completes (`state === 'open'`). */
  static async connect(opts: NngIpcSubscriberOptions): Promise<NngIpcSubscriber> {
    const sub = new NngIpcSubscriber(opts);
    await sub.ready();
    return sub;
  }

  constructor(opts: NngIpcSubscriberOptions) {
    this.path = opts.path.replace(/^ipc:\/\//, "");
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.reconnect = opts.reconnect
      ? { initialDelayMs: 100, maxDelayMs: 5000, maxAttempts: Infinity, ...(typeof opts.reconnect === "object" ? opts.reconnect : {}) }
      : null;
    this.maxFrameBytes = opts.maxFrameBytes;
    this.log = opts.log ?? (() => {});
    void this.dial();
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
      return Promise.reject(this.lastError ?? new TransportError("closed", `subscriber to ${this.path} is closed`));
    return new Promise((resolve, reject) => {
      const off = this.onStateChange((s, err) => {
        if (s === "open") (off(), resolve());
        else if (s === "closed") (off(), reject(err ?? new TransportError("closed", `subscriber to ${this.path} closed`)));
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
    for (const cb of this.stateListeners) cb(s, error);
  }

  private drop(): void {
    const sock = this.sock;
    this.sock = null;
    this.parser = null;
    try {
      sock?.end();
    } catch {
      /* ignore */
    }
  }

  private async dial(): Promise<void> {
    if (this.closedByUser) return;
    this.setState("connecting");
    const parser = new NngFrameParser({ expectPeerProto: SP_PROTO_PUB0, maxFrameBytes: this.maxFrameBytes });
    this.parser = parser;
    const connectTimer = setTimeout(() => {
      if (this.parser === parser && this._state !== "open")
        this.fail(parser, new TransportError("connect", `connect to ${this.path} timed out`));
    }, this.connectTimeoutMs);
    try {
      const sock = await Bun.connect({
        unix: this.path,
        socket: {
          open: (s) => {
            s.write(encodeSpHandshake(SP_PROTO_SUB0));
          },
          data: (_s, chunk) => {
            if (this.parser !== parser) return;
            let bodies: Uint8Array[];
            try {
              bodies = parser.push(new Uint8Array(chunk));
            } catch (e) {
              this.fail(parser, e instanceof TransportError ? e : new TransportError("protocol", String(e), { cause: e }));
              return;
            }
            if (this._state === "connecting" && parser.handshaken) {
              clearTimeout(connectTimer);
              this.attempt = 0;
              this.setState("open");
            }
            for (const b of bodies) for (const cb of this.messageListeners) cb(b);
          },
          close: () => this.fail(parser, new TransportError("closed", `events socket ${this.path} closed by peer`)),
          error: (_s, e) => this.fail(parser, new TransportError("closed", `events socket ${this.path} error: ${String(e)}`, { cause: e })),
          connectError: (_s, e) =>
            this.fail(parser, new TransportError("connect", `connect to ${this.path} failed: ${String(e)}`, { cause: e })),
          end: () => this.fail(parser, new TransportError("closed", `events socket ${this.path} ended`)),
        },
      });
      if (this.parser !== parser || this.closedByUser) {
        clearTimeout(connectTimer);
        sock.end();
        return;
      }
      this.sock = sock;
    } catch (e) {
      clearTimeout(connectTimer);
      this.fail(
        parser,
        e instanceof TransportError ? e : new TransportError("connect", `connect to ${this.path} failed: ${String(e)}`, { cause: e }),
      );
    }
  }

  private fail(parser: NngFrameParser, err: TransportError): void {
    if (this.parser !== parser) return;
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
        void this.dial();
      }, delay);
      return;
    }
    this.setState("closed", err);
  }
}
