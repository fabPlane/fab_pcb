/**
 * `StdioTransport` / `StdioSubscriber` against `stdio-fake-host.ts`, which speaks the same framing
 * as `kicad-api-host-native` and answers with the request payload reversed.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { StdioFrameParser, StdioSubscriber, StdioTransport, encodeStdioFrame } from "../src/transport";
import { TransportError } from "../src/transport/types";
import { KiCadEvents } from "../src/events";

const HOST = join(import.meta.dir, "stdio-fake-host.ts");
const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s);
const text = (b: Uint8Array) => dec.decode(b);

function host(...args: string[]): StdioTransport {
  return new StdioTransport({ command: process.execPath, args: [HOST, ...args], defaultTimeoutMs: 5000 });
}

describe("stdio framing", () => {
  test("encodes a 4-byte big-endian length prefix", () => {
    const f = encodeStdioFrame(bytes("hi"));
    expect(Array.from(f)).toEqual([0, 0, 0, 2, 104, 105]);
  });

  test("parses frames split across chunk boundaries", () => {
    const p = new StdioFrameParser();
    const a = encodeStdioFrame(bytes("first"));
    const b = encodeStdioFrame(bytes("second"));
    const all = new Uint8Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    expect(p.push(all.subarray(0, 2))).toEqual([]);
    expect(p.push(all.subarray(2, 7)).map(text)).toEqual([]);
    const rest = p.push(all.subarray(7));
    expect(rest.map(text)).toEqual(["first", "second"]);
    expect(p.pending).toBe(0);
  });

  test("rejects a frame larger than the limit", () => {
    const p = new StdioFrameParser(8);
    expect(() => p.push(encodeStdioFrame(bytes("more than eight bytes")))).toThrow(/exceeds the 8 byte limit/);
  });
});

describe("StdioTransport", () => {
  test("round-trips a request and keeps concurrent sends in order", async () => {
    const t = await StdioTransport.connect({ command: process.execPath, args: [HOST], defaultTimeoutMs: 5000 });
    try {
      expect(t.state).toBe("open");
      expect(text(await t.send(bytes("abc")))).toBe("cba");
      const replies = await Promise.all([t.send(bytes("one")), t.send(bytes("two")), t.send(bytes("three"))]);
      expect(replies.map(text)).toEqual(["eno", "owt", "eerht"]);
      expect(t.queued).toBe(0);
    } finally {
      await t.close();
    }
  });

  test("delivers events from fd 3 through StdioSubscriber and KiCadEvents", async () => {
    const t = host("--events", "3");
    const sub = new StdioSubscriber(t);
    const seen: string[] = [];
    sub.onMessage((b) => seen.push(text(b)));
    try {
      // a request round trip is enough of a barrier for the startup events to have been read
      await t.send(bytes("ping"));
      for (let i = 0; i < 50 && seen.length < 3; i++) await Bun.sleep(10);
      expect(seen).toEqual(["event-0", "event-1", "event-2"]);
      expect(sub.state).toBe("open");
      // KiCadEvents accepts the subscriber like any other (the frames here are not real events)
      const events = new KiCadEvents(sub);
      const errors: string[] = [];
      events.onError((e) => errors.push(e.message));
      expect(events.state).toBe("open");
      await sub.close();
      expect(sub.state).toBe("closed");
    } finally {
      await t.close();
    }
  });

  test("events emitted per reply arrive after that reply", async () => {
    const t = host("--event-per-reply");
    const sub = new StdioSubscriber(t);
    const seen: string[] = [];
    sub.onMessage((b) => seen.push(text(b)));
    try {
      expect(text(await t.send(bytes("aa")))).toBe("aa");
      for (let i = 0; i < 50 && seen.length < 1; i++) await Bun.sleep(10);
      expect(seen).toEqual(["event-for-aa"]);
    } finally {
      await t.close();
    }
  });

  test("times out a slow request and drops its late reply", async () => {
    const t = host("--delay", "300");
    try {
      const err = await t.send(bytes("slow"), { timeoutMs: 50 }).catch((e: unknown) => e);
      expect(TransportError.is(err, "timeout")).toBe(true);
      // The host still answers the timed-out request; the next caller must not receive that frame.
      expect(text(await t.send(bytes("next"), { timeoutMs: 5000 }))).toBe("txen");
    } finally {
      await t.close();
    }
  });

  test("goes to closed when the host exits, rejecting pending requests", async () => {
    const t = host("--exit-after", "1");
    const states: string[] = [];
    t.onStateChange((s) => states.push(s));
    expect(text(await t.send(bytes("only")))).toBe("ylno");
    const err = await t.send(bytes("late"), { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(TransportError.is(err, "closed")).toBe(true);
    expect(t.state).toBe("closed");
    expect(states).toEqual(["closed"]);
    expect(t.exitCode).toBe(7);
  });

  test("close() is idempotent and rejects later sends", async () => {
    const t = host();
    await t.send(bytes("x"));
    await t.close();
    await t.close();
    expect(t.state).toBe("closed");
    const err = await t.send(bytes("y")).catch((e: unknown) => e);
    expect(TransportError.is(err, "closed")).toBe(true);
  });

  test("connect() rejects when the executable does not exist", async () => {
    const err = await StdioTransport.connect({ command: "/nonexistent/kicad-api-host-native" }).catch((e: unknown) => e);
    expect(TransportError.is(err, "connect")).toBe(true);
    expect((err as Error).message).toContain("/nonexistent/kicad-api-host-native");
  });
});
