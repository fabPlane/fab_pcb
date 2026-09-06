/**
 * Events (`kiapi.common.events.Event`) pushed by KiCad on its pub/sub socket (KiCad >= web-api
 * e8cd61a2f2; `GetServerInfo.events_socket_url` tells you where). `KiCadEvents` decodes frames from
 * any `Subscriber` (Bun: `NngIpcSubscriber`; browser: the bridge relays the same bytes), fans them
 * out to typed listeners, and reports sequence gaps so a client knows when to re-read state.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
  EventSchema,
  type DocumentChanged,
  type DocumentClosed,
  type DocumentOpened,
  type DocumentSaved,
  type Event,
  type JobProgress,
  type ServerShutdown,
} from "@kicad-web/proto";
import type { Subscriber, SubscriberState } from "./transport/nng-ipc-sub";

export type EventKind = Exclude<Event["kind"]["case"], undefined>;

export interface EventPayloads {
  documentChanged: DocumentChanged;
  documentOpened: DocumentOpened;
  documentClosed: DocumentClosed;
  documentSaved: DocumentSaved;
  jobProgress: JobProgress;
  serverShutdown: ServerShutdown;
}

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
  next<K extends EventKind>(kind: K, opts: { timeoutMs?: number; filter?: (payload: EventPayloads[K]) => boolean } = {}): Promise<EventPayloads[K]> {
    return new Promise((resolve, reject) => {
      const timer = opts.timeoutMs ? setTimeout(() => (off(), reject(new Error(`timed out waiting for ${kind} event`))), opts.timeoutMs) : undefined;
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
