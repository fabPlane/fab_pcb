/**
 * `WasmTransport` / `WasmSubscriber` over `FakeWasmInstance` — ordering, the "never dispatch inside
 * the caller's stack frame" rule, event buffering around a dispatch, and close semantics.
 */
import { describe, expect, test } from "bun:test";
import { WasmSubscriber, WasmTransport } from "../src/transport";
import { TransportError } from "../src/transport/types";
import { FakeWasmInstance } from "./fake-wasm-instance";

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);
const text = (b: Uint8Array) => dec.decode(b);

describe("WasmTransport", () => {
  test("dispatches one request at a time, in order, off the caller's stack", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    const p = t.send(bytes("abc"));
    // the module must not have run yet: send() only queues
    expect(inst.requests.length).toBe(0);
    expect(text(await p)).toBe("cba");

    const replies = await Promise.all([t.send(bytes("one")), t.send(bytes("two")), t.send(bytes("three"))]);
    expect(replies.map(text)).toEqual(["eno", "owt", "eerht"]);
    expect(inst.requests.map(text)).toEqual(["abc", "one", "two", "three"]);
    expect(inst.reentered).toBe(false);
    expect(t.queued).toBe(0);
    await t.close();
  });

  test("re-entrant send() from a listener is queued, not nested", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    const order: string[] = [];
    const outer = t.send(bytes("outer")).then((r) => {
      order.push(`reply:${text(r)}`);
      return t.send(bytes("inner")).then((r2) => order.push(`reply:${text(r2)}`));
    });
    await outer;
    expect(order).toEqual(["reply:retuo", "reply:renni"]);
    expect(inst.reentered).toBe(false);
    await t.close();
  });

  test("events published during a dispatch are delivered after that reply resolves", async () => {
    const inst = new FakeWasmInstance();
    inst.eventsPerDispatch = (req) => [bytes(`event-for-${text(req)}`)];
    const t = new WasmTransport(inst);
    const order: string[] = [];
    t.onEvent((b) => order.push(`event:${text(b)}`));
    const r = await t.send(bytes("aa")).then((b) => {
      order.push(`reply:${text(b)}`);
      return b;
    });
    expect(text(r)).toBe("aa");
    // flushing happens one microtask after the reply; give the queue a turn
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["reply:aa", "event:event-for-aa"]);
    expect(t.bufferedEvents).toBe(0);
    await t.close();
  });

  test("events published outside a dispatch are delivered immediately", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    const seen: string[] = [];
    t.onEvent((b) => seen.push(text(b)));
    inst.publish(bytes("idle-event"));
    expect(seen).toEqual(["idle-event"]);
    await t.close();
  });

  test("copies event frames out of the module heap", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    let received: Uint8Array | undefined;
    t.onEvent((b) => {
      received = b;
    });
    const heap = bytes("heap-event");
    inst.publish(heap);
    heap.fill(0); // the module reuses/frees its buffer right after the callback
    expect(text(received!)).toBe("heap-event");
    await t.close();
  });

  test("WasmSubscriber forwards frames and closes with the transport", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    const sub = new WasmSubscriber(t);
    const seen: string[] = [];
    sub.onMessage((b) => seen.push(text(b)));
    const states: string[] = [];
    sub.onStateChange((s) => states.push(s));
    expect(sub.state).toBe("open");
    inst.publish(bytes("e1"));
    expect(seen).toEqual(["e1"]);
    await t.close();
    expect(sub.state).toBe("closed");
    expect(states).toEqual(["closed"]);
  });

  test("a dispatch that throws rejects only that request", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    inst.throwNext = new Error("kiapi_dispatch returned null: out of memory");
    const err = await t.send(bytes("boom")).catch((e: unknown) => e);
    expect(TransportError.is(err, "protocol")).toBe(true);
    expect((err as Error).message).toContain("out of memory");
    expect(text(await t.send(bytes("ok")))).toBe("ko");
    await t.close();
  });

  test("a long synchronous dispatch is not interrupted by the request timeout", async () => {
    const inst = new FakeWasmInstance();
    inst.blockMs = 40;
    const t = new WasmTransport(inst, { defaultTimeoutMs: 5 });
    expect(text(await t.send(bytes("slow")))).toBe("wols");
    await t.close();
  });

  test("close() rejects queued requests, shuts the module down and refuses new sends", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst);
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    const queued = t.send(bytes("never")).catch((e: unknown) => e);
    await t.close();
    expect(TransportError.is(await queued, "closed")).toBe(true);
    expect(t.state).toBe("closed");
    expect(states).toEqual(["closed"]);
    expect(inst.shutdowns).toBe(1);
    expect(inst.requests.length).toBe(0);
    const err = await t.send(bytes("after")).catch((e: unknown) => e);
    expect(TransportError.is(err, "closed")).toBe(true);
    await t.close(); // idempotent
    expect(inst.shutdowns).toBe(1);
  });

  test("ownsInstance:false leaves the module alive and detaches the event listener", async () => {
    const inst = new FakeWasmInstance();
    const t = new WasmTransport(inst, { ownsInstance: false });
    expect(inst.eventListeners).toBe(1);
    await t.close();
    expect(inst.shutdowns).toBe(0);
    expect(inst.eventListeners).toBe(0);
  });
});
