/**
 * Events (`kiapi.common.events.Event`) pushed by KiCad on its pub/sub socket (KiCad >= web-api
 * e8cd61a2f2; `GetServerInfo.events_socket_url` tells you where). `KiCadEvents` decodes frames from
 * any `Subscriber` (Bun: `NngIpcSubscriber`; browser: the bridge relays the same bytes), fans them
 * out to typed listeners, and reports sequence gaps so a client knows when to re-read state.
 */
import { fromBinary, toJson } from "@bufbuild/protobuf";
import {
  EventSchema,
  type DocumentChanged,
  type DocumentClosed,
  type DocumentOpened,
  type DocumentSaved,
  type Event,
  type EventJson,
  type JobProgress,
  type ProjectChangeKind,
  type ProjectChanged,
  type ServerShutdown,
} from "@fp-pcb/proto";
import type { Subscriber, SubscriberState } from "./transport/nng-ipc-sub";
import type { WebSocketTransport } from "./transport/websocket";

export type EventKind = Exclude<Event["kind"]["case"], undefined>;

/**
 * Payload type for each event kind, derived from the generated oneof so a new event kind in the
 * proto is picked up here without an edit (KiCad keeps adding them).
 */
export type EventPayloads = {
  [K in EventKind]: Extract<Event["kind"], { case: K }>["value"];
};

export interface EventGap {
  /** Last sequence number seen before the gap. */
  expected: bigint;
  /** Sequence number of the event that revealed it. */
  received: bigint;
}

/** Decodes one events-socket frame. */
export function decodeEvent(bytes: Uint8Array): Event {
  return fromBinary(EventSchema, bytes);
}

/** Proto3 JSON of an event (bigints as strings, enums by name) — for logs, SSE and CLIs. */
export function eventToJson(event: Event): EventJson {
  return toJson(EventSchema, event);
}

/**
 * `Subscriber` over a `WebSocketTransport`: the bridge relays KiCad's event frames and tells us
 * (`events` control message) whether it is subscribed on the KiCad side. `open` while the
 * bridge is subscribed, `connecting` while it is not (it redials on its own; events are missed
 * meanwhile, so re-read state), `closed` once the WebSocket is gone or `close()` was called.
 * Closing the subscriber detaches from the transport; it never closes the WebSocket.
 */
export class TransportEventSubscriber implements Subscriber {
  private readonly messageListeners = new Set<(body: Uint8Array) => void>();
  private readonly stateListeners = new Set<(s: SubscriberState, error?: Error) => void>();
  private _state: SubscriberState;
  private detach: (() => void) | undefined;

  constructor(readonly transport: WebSocketTransport) {
    this._state = TransportEventSubscriber.stateOf(transport);
    const offEvent = transport.onEvent((b) => {
      for (const cb of this.messageListeners) cb(b);
    });
    const offControl = transport.onControl((m) => {
      if (m.type === "hello" || m.type === "events") this.setState(TransportEventSubscriber.stateOf(transport));
    });
    const offState = transport.onStateChange((s) => {
      if (s === "closed") this.setState("closed");
    });
    this.detach = () => {
      offEvent();
      offControl();
      offState();
    };
  }

  private static stateOf(t: WebSocketTransport): SubscriberState {
    if (t.state === "closed") return "closed";
    return t.eventsState === "connected" ? "open" : "connecting";
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

  async close(): Promise<void> {
    this.detach?.();
    this.detach = undefined;
    this.setState("closed");
  }

  private setState(s: SubscriberState): void {
    if (this._state === s) return;
    this._state = s;
    for (const cb of this.stateListeners) cb(s);
  }
}

/** Typed listener registry over a subscriber. Frames that fail to decode are reported, not thrown. */
export class KiCadEvents {
  private readonly listeners = new Map<EventKind | "*", Set<(payload: unknown, event: Event) => void>>();
  private readonly gapListeners = new Set<(gap: EventGap) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private last: bigint | undefined;
  private off: (() => void) | undefined;
  private count = 0;

  constructor(readonly subscriber?: Subscriber) {
    if (subscriber) this.off = subscriber.onMessage((b) => this.push(b));
  }

  /** Events relayed by `@fp-pcb/bridge` over a `WebSocketTransport` (browser or Bun). */
  static fromTransport(transport: WebSocketTransport): KiCadEvents {
    return new KiCadEvents(new TransportEventSubscriber(transport));
  }

  /** Subscriber lifecycle (`open` = events flow; `connecting` = temporarily none, re-read state). */
  onStateChange(cb: (state: SubscriberState, error?: Error) => void): () => void {
    return this.subscriber?.onStateChange(cb) ?? (() => {});
  }

  get state(): SubscriberState {
    return this.subscriber?.state ?? "open";
  }

  /** Highest sequence number seen so far. */
  get lastSequence(): bigint | undefined {
    return this.last;
  }

  get received(): number {
    return this.count;
  }

  /** Feeds one raw frame (for transports other than `NngIpcSubscriber`, e.g. the bridge). */
  push(bytes: Uint8Array): Event | undefined {
    let ev: Event;
    try {
      ev = decodeEvent(bytes);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      for (const cb of this.errorListeners) cb(err);
      return undefined;
    }
    this.count++;
    if (this.last !== undefined && ev.sequence > this.last + 1n) {
      for (const cb of this.gapListeners) cb({ expected: this.last, received: ev.sequence });
    }
    if (this.last === undefined || ev.sequence > this.last) this.last = ev.sequence;
    const kind = ev.kind.case;
    if (kind) for (const cb of this.listeners.get(kind) ?? []) cb(ev.kind.value, ev);
    for (const cb of this.listeners.get("*") ?? []) cb(ev.kind.value, ev);
    return ev;
  }

  on<K extends EventKind>(kind: K, cb: (payload: EventPayloads[K], event: Event) => void): () => void;
  on(kind: "*", cb: (payload: unknown, event: Event) => void): () => void;
  on(kind: EventKind | "*", cb: (payload: never, event: Event) => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) this.listeners.set(kind, (set = new Set()));
    const fn = cb as (payload: unknown, event: Event) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  // --- convenience helpers ------------------------------------------------------------------------
  // `EventPayloads` is derived from the generated oneof, so `on(kind, cb)` already covers every
  // event KiCad defines; these are just named shorthands for the ones clients subscribe to most.

  /** A document changed (an API commit, an edit outside a commit, or a revert). */
  onDocumentChanged(cb: (e: DocumentChanged, event: Event) => void): () => void {
    return this.on("documentChanged", cb);
  }

  onDocumentOpened(cb: (e: DocumentOpened, event: Event) => void): () => void {
    return this.on("documentOpened", cb);
  }

  onDocumentClosed(cb: (e: DocumentClosed, event: Event) => void): () => void {
    return this.on("documentClosed", cb);
  }

  onDocumentSaved(cb: (e: DocumentSaved, event: Event) => void): () => void {
    return this.on("documentSaved", cb);
  }

  onJobProgress(cb: (e: JobProgress, event: Event) => void): () => void {
    return this.on("jobProgress", cb);
  }

  /**
   * Project-level state changed through the API (`ProjectChanged`, KiCad >= 11.0): net classes,
   * text variables, variants, project settings or the library tables. `kind` says which
   * (`PCK_NET_CLASSES`, `PCK_LIBRARY_TABLES`, ...); pass `kinds` to filter. The event carries no
   * payload beyond that, so re-read the state you care about.
   */
  onProjectChanged(cb: (e: ProjectChanged, event: Event) => void, kinds?: readonly ProjectChangeKind[]): () => void {
    return this.on("projectChanged", (payload, event) => {
      if (kinds && !kinds.includes(payload.kind)) return;
      cb(payload, event);
    });
  }

  /** The API server is stopping; both sockets are about to go away. */
  onServerShutdown(cb: (e: ServerShutdown, event: Event) => void): () => void {
    return this.on("serverShutdown", cb);
  }

  /** Fired when a sequence number jumps (events were missed); re-read state through the request socket. */
  onGap(cb: (gap: EventGap) => void): () => void {
    this.gapListeners.add(cb);
    return () => this.gapListeners.delete(cb);
  }

  onError(cb: (error: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  /** Resolves with the next event of `kind` (optionally filtered), or rejects after `timeoutMs`. */
  next<K extends EventKind>(
    kind: K,
    opts: { timeoutMs?: number; filter?: (payload: EventPayloads[K]) => boolean } = {},
  ): Promise<EventPayloads[K]> {
    return new Promise((resolve, reject) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => (off(), reject(new Error(`timed out waiting for ${kind} event`))), opts.timeoutMs)
        : undefined;
      const off = this.on(kind, (payload) => {
        if (opts.filter && !opts.filter(payload)) return;
        if (timer) clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }

  async close(): Promise<void> {
    this.off?.();
    this.off = undefined;
    await this.subscriber?.close();
  }
}
