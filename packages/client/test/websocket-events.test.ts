/** Event frames over WebSocketTransport with a fake WebSocket: onEvent, eventsState, KiCadEvents.fromTransport. */
import { describe, expect, test } from "bun:test";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { DocumentType, EventSchema } from "@kicad-web/proto";
import { KiCadEvents, TransportEventSubscriber } from "../src/events";
import {
  WS_EVENT_FRAME_ID,
  WebSocketTransport,
  decodeWsFrame,
  encodeControl,
  encodeEventFrame,
  encodeWsFrame,
  type WebSocketLike,
} from "../src/transport";

function eventBytes(sequence: bigint, kind: MessageInitShape<typeof EventSchema>["kind"]): Uint8Array {
  return toBinary(EventSchema, create(EventSchema, { sequence, kind }));
}

/** Scripted WebSocket: records what the transport sends, lets the test inject bridge frames. */
class FakeWebSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  readonly sent: Array<string | Uint8Array> = [];
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  addEventListener(type: string, cb: (ev: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb as (ev: unknown) => void);
    this.listeners.set(type, list);
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  text(msg: string): void {
    this.emit("message", { data: msg });
  }
  binary(frame: Uint8Array): void {
    // browsers hand over an ArrayBuffer with binaryType = 'arraybuffer'
    this.emit("message", { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }
}

async function connected(eventsState?: "connected" | "disconnected"): Promise<{ ws: FakeWebSocket; t: WebSocketTransport }> {
  let ws!: FakeWebSocket;
  const t = new WebSocketTransport("ws://fake/ws?session=s1", { keepaliveMs: 0, createWebSocket: () => (ws = new FakeWebSocket()) });
  expect(ws.binaryType).toBe("arraybuffer");
  ws.open();
  ws.text(
    encodeControl({
      type: "hello",
      protocolVersion: 2,
      sessionId: "s1",
      kicadToken: "tok",
      serverState: "running",
      ...(eventsState ? { eventsState } : {}),
    }),
  );
  await t.ready();
  return { ws, t };
}

describe("WebSocketTransport events", () => {
  test("event frames go to onEvent (as owned copies), never to pending requests", async () => {
    const { ws, t } = await connected("connected");
    expect(t.eventsState).toBe("connected");
    const got: Uint8Array[] = [];
    t.onEvent((b) => got.push(b));

    // a request is in flight; an event frame must not resolve it
    const reply = t.send(Uint8Array.from([1, 2, 3]));
    const req = decodeWsFrame(ws.sent[0] as Uint8Array);
    expect(req.id).not.toBe(WS_EVENT_FRAME_ID);

    const frame = encodeEventFrame(eventBytes(7n, { case: "documentChanged", value: { revision: 3n, message: "m" } }));
    ws.binary(frame);
    expect(got.length).toBe(1);
    expect(Array.from(got[0]!)).toEqual(Array.from(frame.subarray(4)));
    expect(t.inFlight).toBe(1);

    ws.binary(encodeWsFrame(req.id, Uint8Array.from([9])));
    expect(Array.from(await reply)).toEqual([9]);
    expect(got.length).toBe(1);
  });

  test("hello without eventsState (protocol 1 bridge) means disconnected; `events` control updates it", async () => {
    const { ws, t } = await connected();
    expect(t.eventsState).toBe("disconnected");
    const seen: string[] = [];
    t.onControl((m) => m.type === "events" && seen.push(m.state));
    ws.text(encodeControl({ type: "events", sessionId: "s1", state: "connected", message: "/tmp/x-events.sock" }));
    expect(t.eventsState).toBe("connected");
    ws.text(encodeControl({ type: "events", sessionId: "s1", state: "disconnected" }));
    expect(t.eventsState).toBe("disconnected");
    expect(seen).toEqual(["connected", "disconnected"]);
  });

  test("KiCadEvents.fromTransport decodes relayed events, tracks gaps and mirrors the bridge's subscription state", async () => {
    const { ws, t } = await connected("disconnected");
    const events = KiCadEvents.fromTransport(t);
    expect(events.subscriber).toBeInstanceOf(TransportEventSubscriber);
    expect(events.state).toBe("connecting");
    const states: string[] = [];
    events.onStateChange((s) => states.push(s));
    ws.text(encodeControl({ type: "events", sessionId: "s1", state: "connected" }));
    expect(events.state).toBe("open");

    const kinds: string[] = [];
    const revisions: bigint[] = [];
    const gaps: string[] = [];
    events.on("*", (_p, e) => kinds.push(e.kind.case ?? "?"));
    events.on("documentChanged", (d) => revisions.push(d.revision));
    events.onGap((g) => gaps.push(`${g.expected}->${g.received}`));
    const next = events.next("documentSaved", { timeoutMs: 1000 });
    ws.binary(encodeEventFrame(eventBytes(1n, { case: "documentOpened", value: { document: { type: DocumentType.DOCTYPE_PCB } } })));
    ws.binary(encodeEventFrame(eventBytes(2n, { case: "documentChanged", value: { revision: 5n, updated: [{ value: "a" }] } })));
    ws.binary(encodeEventFrame(eventBytes(4n, { case: "documentSaved", value: { path: "/b.kicad_pcb", revision: 6n } })));
    expect((await next).path).toBe("/b.kicad_pcb");
    expect(kinds).toEqual(["documentOpened", "documentChanged", "documentSaved"]);
    expect(revisions).toEqual([5n]);
    expect(gaps).toEqual(["2->4"]);
    expect(events.lastSequence).toBe(4n);

    ws.text(encodeControl({ type: "events", sessionId: "s1", state: "disconnected", message: "kicad restarted" }));
    expect(events.state).toBe("connecting");
    ws.close(1001, "session closed");
    expect(events.state).toBe("closed");
    expect(states).toEqual(["open", "connecting", "closed"]);
  });

  test("closing KiCadEvents detaches from the transport without closing the WebSocket", async () => {
    const { ws, t } = await connected("connected");
    const events = KiCadEvents.fromTransport(t);
    let n = 0;
    events.on("*", () => n++);
    ws.binary(encodeEventFrame(eventBytes(1n, { case: "serverShutdown", value: {} })));
    expect(n).toBe(1);
    await events.close();
    ws.binary(encodeEventFrame(eventBytes(2n, { case: "serverShutdown", value: {} })));
    expect(n).toBe(1);
    expect(events.state).toBe("closed");
    expect(t.state).toBe("open");
    expect(ws.readyState).toBe(1);
  });
});
