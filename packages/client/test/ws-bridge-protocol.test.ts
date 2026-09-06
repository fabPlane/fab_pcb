import { describe, expect, test } from "bun:test";
import {
  TransportError,
  WS_BRIDGE_PROTOCOL_VERSION,
  WS_EVENT_FRAME_ID,
  WS_MAX_REQUEST_ID,
  bridgeWsUrl,
  decodeWsFrame,
  encodeControl,
  encodeEventFrame,
  encodeWsFrame,
  isControlMessage,
  isEventFrame,
  parseControl,
} from "../src/transport";

describe("ws frames", () => {
  test("4-byte BE id + payload round trip", () => {
    const f = encodeWsFrame(0x01020304, Uint8Array.from([9, 8]));
    expect(Array.from(f)).toEqual([1, 2, 3, 4, 9, 8]);
    const { id, payload } = decodeWsFrame(f);
    expect(id).toBe(0x01020304);
    expect(Array.from(payload)).toEqual([9, 8]);
    // ArrayBuffer input (what browsers hand us with binaryType='arraybuffer')
    const ab = f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
    expect(decodeWsFrame(ab).id).toBe(0x01020304);
    expect(() => decodeWsFrame(new Uint8Array(3))).toThrow(TransportError);
  });
  test("ids above 2^31 survive", () => {
    expect(decodeWsFrame(encodeWsFrame(0xffffffff, new Uint8Array(0))).id).toBe(0xffffffff);
  });
  test("event frames use the reserved id 0xffffffff", () => {
    expect(WS_BRIDGE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);
    expect(WS_EVENT_FRAME_ID).toBe(0xffffffff);
    expect(WS_MAX_REQUEST_ID).toBe(0xfffffffe);
    const f = encodeEventFrame(Uint8Array.from([0x08, 0x01]));
    expect(Array.from(f)).toEqual([0xff, 0xff, 0xff, 0xff, 0x08, 0x01]);
    const d = decodeWsFrame(f);
    expect(isEventFrame(d)).toBe(true);
    expect(Array.from(d.payload)).toEqual([0x08, 0x01]);
    expect(isEventFrame(decodeWsFrame(encodeWsFrame(WS_MAX_REQUEST_ID, new Uint8Array(0))))).toBe(false);
    expect(isEventFrame(decodeWsFrame(encodeWsFrame(1, new Uint8Array(0))))).toBe(false);
  });
});

describe("control messages", () => {
  test("hello / error / server-state / events round trip", () => {
    const hello = parseControl(
      encodeControl({ type: "hello", protocolVersion: 1, sessionId: "abc", kicadToken: null, serverState: "starting" }),
    );
    expect(hello.type).toBe("hello");
    const hello2 = parseControl(
      encodeControl({
        type: "hello",
        protocolVersion: 2,
        sessionId: "abc",
        kicadToken: "t",
        serverState: "running",
        eventsState: "connected",
      }),
    );
    expect(hello2).toMatchObject({ type: "hello", eventsState: "connected" });
    const ev = parseControl(encodeControl({ type: "events", sessionId: "abc", state: "disconnected", message: "gone" }));
    expect(ev).toEqual({ type: "events", sessionId: "abc", state: "disconnected", message: "gone" });
    expect(() => parseControl('{"type":"events","sessionId":"a","state":"maybe"}')).toThrow(/malformed/);
    expect(() =>
      parseControl('{"type":"hello","protocolVersion":2,"sessionId":"a","kicadToken":null,"serverState":"running","eventsState":"x"}'),
    ).toThrow(/malformed/);
    const err = parseControl(encodeControl({ type: "error", id: 7, code: "timeout", message: "x" }));
    expect(err).toEqual({ type: "error", id: 7, code: "timeout", message: "x" });
    const st = parseControl(encodeControl({ type: "server-state", sessionId: "abc", state: "exited", exitCode: 1 }));
    expect(st.type).toBe("server-state");
    expect(isControlMessage({ type: "pong" })).toBe(true);
    expect(isControlMessage({ type: "nope" })).toBe(false);
  });
  test("rejects malformed frames", () => {
    expect(() => parseControl("not json")).toThrow(TransportError);
    expect(() => parseControl('{"type":"bogus"}')).toThrow(/unknown control frame/);
    expect(() => parseControl('{"type":"hello","sessionId":1}')).toThrow(/malformed/);
    expect(() => parseControl('{"type":"server-state","sessionId":"a","state":"weird"}')).toThrow(/malformed/);
    expect(() => parseControl('{"type":"error","id":"x","code":"timeout","message":"m"}')).toThrow(/malformed/);
  });
});

describe("bridgeWsUrl", () => {
  test("maps http(s) to ws(s) and sets the session", () => {
    expect(bridgeWsUrl("http://localhost:4020", "s1")).toBe("ws://localhost:4020/ws?session=s1");
    expect(bridgeWsUrl("https://example.com/app/?x=1#h", "s 2")).toBe("wss://example.com/ws?session=s+2");
    expect(bridgeWsUrl(new URL("ws://h:1/ws"), "z")).toBe("ws://h:1/ws?session=z");
  });
});
