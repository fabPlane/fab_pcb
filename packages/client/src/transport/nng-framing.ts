/**
 * nng "SP" wire format over ipc:// (unix domain socket), as spoken by `kicad-cli api-server`.
 *
 *   handshake   8 bytes each way:  00 'S' 'P' 00 <proto BE16> 00 00   (REQ0 = 0x30, REP0 = 0x31)
 *   message     9-byte header: byte 0 = 0x01 ("data"), bytes 1..8 = big-endian uint64 body length; then body
 *   REQ0 body   4-byte big-endian request id with the top bit set + payload; the reply echoes the id
 *
 * Verified against nng 1.12.2 `src/sp/transport/ipc/ipc.c` and `nngcat --req0` captures.
 * Pure functions plus a streaming parser so the transport and the unit tests share one codec.
 */

import { TransportError } from "./types";

export const SP_HANDSHAKE_LENGTH = 8;
export const SP_PROTO_REQ0 = 0x30;
export const SP_PROTO_REP0 = 0x31;
export const NNG_FRAME_HEADER_LENGTH = 9;
export const NNG_FRAME_TYPE_DATA = 0x01;
/** REQ0 request ids carry the top bit so they cannot collide with backtrace pipe ids. */
export const REQ_ID_FLAG = 0x80000000;

export interface SpHandshake {
  /** SP protocol number, e.g. `SP_PROTO_REQ0` / `SP_PROTO_REP0`. */
  proto: number;
}

export function encodeSpHandshake(proto: number): Uint8Array {
  return Uint8Array.from([0x00, 0x53, 0x50, 0x00, (proto >>> 8) & 0xff, proto & 0xff, 0x00, 0x00]);
}

/** Decode and validate an 8-byte SP handshake. Throws `TransportError('protocol')` if malformed. */
export function decodeSpHandshake(bytes: Uint8Array): SpHandshake {
  if (bytes.length < SP_HANDSHAKE_LENGTH) {
    throw new TransportError("protocol", `SP handshake too short (${bytes.length} bytes)`);
  }
  if (bytes[0] !== 0x00 || bytes[1] !== 0x53 || bytes[2] !== 0x50 || bytes[3] !== 0x00) {
    throw new TransportError("protocol", `bad SP handshake magic: ${hex(bytes.subarray(0, 8))}`);
  }
  if (bytes[6] !== 0x00 || bytes[7] !== 0x00) {
    throw new TransportError("protocol", `bad SP handshake trailer: ${hex(bytes.subarray(0, 8))}`);
  }
  return { proto: ((bytes[4]! << 8) | bytes[5]!) >>> 0 };
}

/** Wrap a body in the 9-byte nng IPC frame header. */
export function encodeNngFrame(body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(NNG_FRAME_HEADER_LENGTH + body.length);
  frame[0] = NNG_FRAME_TYPE_DATA;
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setBigUint64(1, BigInt(body.length));
  frame.set(body, NNG_FRAME_HEADER_LENGTH);
  return frame;
}

/** Prefix a payload with a 4-byte big-endian REQ0 request id. */
export function encodeReqBody(id: number, payload: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + payload.length);
  new DataView(body.buffer, body.byteOffset, body.byteLength).setUint32(0, id >>> 0);
  body.set(payload, 4);
  return body;
}

/** Split a REQ0/REP0 body into its request id and payload. */
export function splitReqBody(body: Uint8Array): { id: number; payload: Uint8Array } {
  if (body.length < 4) {
    throw new TransportError("protocol", `REQ0 body too short (${body.length} bytes)`);
  }
  const id = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  return { id, payload: body.subarray(4) };
}

export interface NngFrameParserOptions {
  /** Expected peer protocol; the handshake is rejected if it differs. Omit to accept any. */
  expectPeerProto?: number;
  /** Reject frames whose declared body length exceeds this (default 256 MiB). */
  maxFrameBytes?: number;
}

/**
 * Incremental parser: feed it socket chunks in any split; it emits the handshake once and then
 * whole message bodies. Throws `TransportError('protocol')` on malformed input; once it has thrown
 * the parser is poisoned and the connection must be dropped.
 */
export class NngFrameParser {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private handshake: SpHandshake | null = null;
  private readonly expectPeerProto: number | undefined;
  private readonly maxFrameBytes: number;

  constructor(opts: NngFrameParserOptions = {}) {
    this.expectPeerProto = opts.expectPeerProto;
    this.maxFrameBytes = opts.maxFrameBytes ?? 256 * 1024 * 1024;
  }

  /** True once the peer's SP handshake has been received and validated. */
  get handshaken(): boolean {
    return this.handshake !== null;
  }

  get peer(): SpHandshake | null {
    return this.handshake;
  }

  /** Bytes buffered but not yet consumed. */
  get pendingBytes(): number {
    return this.buffered;
  }

  /**
   * Feed one chunk. Returns the message bodies completed by this chunk (zero or more).
   * The handshake, when it completes, is exposed via `peer` and never returned as a body.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out: Uint8Array[] = [];
    if (!this.handshake) {
      if (this.buffered < SP_HANDSHAKE_LENGTH) return out;
      const hs = decodeSpHandshake(this.take(SP_HANDSHAKE_LENGTH));
      if (this.expectPeerProto !== undefined && hs.proto !== this.expectPeerProto) {
        throw new TransportError(
          "protocol",
          `peer speaks SP protocol 0x${hs.proto.toString(16)}, expected 0x${this.expectPeerProto.toString(16)}`,
        );
      }
      this.handshake = hs;
    }
    for (;;) {
      if (this.buffered < NNG_FRAME_HEADER_LENGTH) return out;
      const header = this.peek(NNG_FRAME_HEADER_LENGTH);
      if (header[0] !== NNG_FRAME_TYPE_DATA) {
        throw new TransportError("protocol", `unexpected nng IPC frame type 0x${header[0]!.toString(16)}`);
      }
      const len64 = new DataView(header.buffer, header.byteOffset, header.byteLength).getBigUint64(1);
      if (len64 > BigInt(this.maxFrameBytes)) {
        throw new TransportError("protocol", `nng frame of ${len64} bytes exceeds limit ${this.maxFrameBytes}`);
      }
      const len = Number(len64);
      if (this.buffered < NNG_FRAME_HEADER_LENGTH + len) return out;
      this.take(NNG_FRAME_HEADER_LENGTH);
      out.push(this.take(len));
    }
  }

  /** Copy the first `n` buffered bytes without consuming them. */
  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.length, n - o);
      out.set(c.subarray(0, take), o);
      o += take;
      if (o === n) break;
    }
    return out;
  }

  /** Consume and return the first `n` buffered bytes (caller guarantees availability). */
  private take(n: number): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const first = this.chunks[0]!;
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0]!;
      const take = Math.min(c.length, n - o);
      out.set(c.subarray(0, take), o);
      o += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.buffered -= n;
    return out;
  }
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
