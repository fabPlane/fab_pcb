import { describe, expect, test } from "bun:test";
import {
  NngFrameParser,
  SP_PROTO_REP0,
  SP_PROTO_REQ0,
  TransportError,
  decodeSpHandshake,
  encodeNngFrame,
  encodeReqBody,
  encodeSpHandshake,
  splitReqBody,
} from "../src/transport";

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("SP handshake", () => {
  test("encodes REQ0 as what nngcat --req0 sends", () => {
    expect(hex(encodeSpHandshake(SP_PROTO_REQ0))).toBe("0053500000300000");
    expect(hex(encodeSpHandshake(SP_PROTO_REP0))).toBe("0053500000310000");
  });
  test("decodes and validates", () => {
    expect(decodeSpHandshake(encodeSpHandshake(SP_PROTO_REP0)).proto).toBe(0x31);
    expect(() => decodeSpHandshake(new Uint8Array(7))).toThrow(TransportError);
    expect(() => decodeSpHandshake(Uint8Array.from([1, 0x53, 0x50, 0, 0, 0x31, 0, 0]))).toThrow(/magic/);
    expect(() => decodeSpHandshake(Uint8Array.from([0, 0x53, 0x50, 0, 0, 0x31, 1, 0]))).toThrow(/trailer/);
  });
});

describe("nng frame header", () => {
  test("9-byte header: type 0x01 + BE uint64 length", () => {
    const f = encodeNngFrame(Uint8Array.from([0xaa, 0xbb, 0xcc]));
    expect(hex(f)).toBe("01" + "0000000000000003" + "aabbcc");
  });
  test("large lengths use all 8 bytes", () => {
    const body = new Uint8Array(70000);
    const f = encodeNngFrame(body);
    expect(hex(f.subarray(0, 9))).toBe("010000000000011170");
    expect(f.length).toBe(9 + 70000);
  });
  test("REQ0 body carries a 4-byte id", () => {
    const b = encodeReqBody(0x80000001, Uint8Array.from([1, 2]));
    expect(hex(b)).toBe("800000010102");
    const { id, payload } = splitReqBody(b);
    expect(id).toBe(0x80000001);
    expect(hex(payload)).toBe("0102");
    expect(() => splitReqBody(new Uint8Array(3))).toThrow(TransportError);
  });
});

describe("NngFrameParser", () => {
  const hs = encodeSpHandshake(SP_PROTO_REP0);
  const m1 = encodeReqBody(0x80000001, Uint8Array.from([0x0a, 0x01, 0x01]));
  const m2 = encodeReqBody(0x80000002, new Uint8Array(1000).fill(0x42));
  const stream = concat(hs, encodeNngFrame(m1), encodeNngFrame(m2));

  test("coalesced: handshake + two messages in one chunk", () => {
    const p = new NngFrameParser({ expectPeerProto: SP_PROTO_REP0 });
    const out = p.push(stream);
    expect(p.handshaken).toBe(true);
    expect(p.peer?.proto).toBe(SP_PROTO_REP0);
    expect(out.length).toBe(2);
    expect(hex(out[0]!)).toBe(hex(m1));
    expect(hex(out[1]!)).toBe(hex(m2));
    expect(p.pendingBytes).toBe(0);
  });

  test("split: one byte at a time", () => {
    const p = new NngFrameParser({ expectPeerProto: SP_PROTO_REP0 });
    const out: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i++) out.push(...p.push(stream.subarray(i, i + 1)));
    expect(out.length).toBe(2);
    expect(hex(out[0]!)).toBe(hex(m1));
    expect(hex(out[1]!)).toBe(hex(m2));
  });

  test("split at every possible boundary yields the same messages", () => {
    for (let cut = 1; cut < stream.length; cut += 7) {
      const p = new NngFrameParser();
      const out = [...p.push(stream.subarray(0, cut)), ...p.push(stream.subarray(cut))];
      expect(out.length).toBe(2);
      expect(hex(out[1]!)).toBe(hex(m2));
    }
  });

  test("header split across chunks, body across three chunks", () => {
    const p = new NngFrameParser();
    p.push(hs);
    const f = encodeNngFrame(m2);
    expect(p.push(f.subarray(0, 4))).toEqual([]);
    expect(p.push(f.subarray(4, 9))).toEqual([]);
    expect(p.push(f.subarray(9, 300))).toEqual([]);
    expect(p.push(f.subarray(300, 700))).toEqual([]);
    const out = p.push(f.subarray(700));
    expect(out.length).toBe(1);
    expect(hex(out[0]!)).toBe(hex(m2));
  });

  test("empty chunks and zero-length bodies", () => {
    const p = new NngFrameParser();
    expect(p.push(new Uint8Array(0))).toEqual([]);
    p.push(hs);
    const out = p.push(encodeNngFrame(new Uint8Array(0)));
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBe(0);
  });

  test("rejects the wrong peer protocol", () => {
    const p = new NngFrameParser({ expectPeerProto: SP_PROTO_REP0 });
    expect(() => p.push(encodeSpHandshake(SP_PROTO_REQ0))).toThrow(/expected 0x31/);
  });

  test("rejects unknown frame types and oversized frames", () => {
    const p = new NngFrameParser();
    p.push(hs);
    expect(() => p.push(Uint8Array.from([0x02, 0, 0, 0, 0, 0, 0, 0, 1, 0]))).toThrow(/frame type 0x2/);
    const q = new NngFrameParser({ maxFrameBytes: 16 });
    q.push(hs);
    expect(() => q.push(encodeNngFrame(new Uint8Array(17)))).toThrow(/exceeds limit/);
  });
});
