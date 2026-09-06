/**
 * Framing shared by `WebSocketTransport` (browser/Bun) and `@kicad-web/bridge` (Bun).
 *
 * Binary frame (both directions): 4-byte big-endian correlation id + raw ApiRequest/ApiResponse
 * bytes. Several requests may be in flight on one WebSocket; the bridge serialises them onto
 * KiCad's REQ/REP socket and routes replies back by id.
 *
 * Text frame: one JSON control message, see `BridgeControlMessage`.
 */

import { TransportError, type TransportErrorCode } from "./types";

export const WS_BRIDGE_PROTOCOL_VERSION = 1;
export const WS_FRAME_ID_LENGTH = 4;

/** Lifecycle of the `kicad-cli api-server` process behind a session. */
export type KiCadServerState = "starting" | "running" | "exited" | "failed";

export type BridgeErrorCode = TransportErrorCode | "bad-request" | "no-session" | "internal";

/** Sent by the bridge right after the WebSocket opens. */
export interface BridgeHello {
  type: "hello";
  protocolVersion: number;
  sessionId: string;
  /** `kicad_token` learnt from the bridge's own Ping; null while the server is still starting. */
  kicadToken: string | null;
  serverState: KiCadServerState;
}

/** A request (identified by `id`) failed inside the bridge; `id` is null for connection-level errors. */
export interface BridgeError {
  type: "error";
  id: number | null;
  code: BridgeErrorCode;
  message: string;
}

/** Pushed whenever the KiCad process changes state (start, ready, exit, crash). */
export interface BridgeServerState {
  type: "server-state";
  sessionId: string;
  state: KiCadServerState;
  kicadToken?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
}

/** Keepalive; either side may send `ping`, the other answers `pong`. */
export interface BridgePing {
  type: "ping" | "pong";
  t?: number;
}

export type BridgeControlMessage = BridgeHello | BridgeError | BridgeServerState | BridgePing;

export function encodeWsFrame(id: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(WS_FRAME_ID_LENGTH + payload.length);
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(0, id >>> 0);
  frame.set(payload, WS_FRAME_ID_LENGTH);
  return frame;
}

export function decodeWsFrame(data: ArrayBufferLike | ArrayBufferView): { id: number; payload: Uint8Array } {
  const bytes = toUint8Array(data);
  if (bytes.length < WS_FRAME_ID_LENGTH) {
    throw new TransportError("protocol", `WebSocket frame too short (${bytes.length} bytes)`);
  }
  const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return { id, payload: bytes.subarray(WS_FRAME_ID_LENGTH) };
}

export function toUint8Array(data: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export function encodeControl(msg: BridgeControlMessage): string {
  return JSON.stringify(msg);
}

const CONTROL_TYPES = new Set(["hello", "error", "server-state", "ping", "pong"]);
const SERVER_STATES = new Set<string>(["starting", "running", "exited", "failed"]);

export function isControlMessage(x: unknown): x is BridgeControlMessage {
  return typeof x === "object" && x !== null && CONTROL_TYPES.has((x as { type?: unknown }).type as string);
}

/** Parse and validate a text frame. Throws `TransportError('protocol')` on anything unexpected. */
export function parseControl(text: string): BridgeControlMessage {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch (e) {
    throw new TransportError("protocol", `control frame is not JSON: ${text.slice(0, 80)}`, { cause: e });
  }
  if (!isControlMessage(x)) {
    throw new TransportError("protocol", `unknown control frame: ${text.slice(0, 80)}`);
  }
  const m = x as unknown as Record<string, unknown>;
  switch (m.type) {
    case "hello":
      if (typeof m.sessionId !== "string" || typeof m.protocolVersion !== "number") bad(text);
      if (m.kicadToken !== null && typeof m.kicadToken !== "string") bad(text);
      if (!SERVER_STATES.has(m.serverState as string)) bad(text);
      break;
    case "error":
      if (typeof m.code !== "string" || typeof m.message !== "string") bad(text);
      if (m.id !== null && typeof m.id !== "number") bad(text);
      break;
    case "server-state":
      if (typeof m.sessionId !== "string" || !SERVER_STATES.has(m.state as string)) bad(text);
      break;
    case "ping":
    case "pong":
      break;
  }
  return x;
}

function bad(text: string): never {
  throw new TransportError("protocol", `malformed control frame: ${text.slice(0, 120)}`);
}

/** Build the bridge WebSocket URL for a session from an http(s)/ws(s) base URL. */
export function bridgeWsUrl(base: string | URL, sessionId: string): string {
  const u = new URL(typeof base === "string" ? base : base.href);
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  u.searchParams.set("session", sessionId);
  u.hash = "";
  return u.toString();
}
