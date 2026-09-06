/**
 * Fake nng-over-WebSocket servers for exercising `NngWsTransport` / `NngWsSubscriber` without
 * KiCad. They reproduce exactly what `kicad-cli api-server --socket ws://...` was measured to do
 * (see the module header of `src/transport/nng-ws.ts`):
 *
 * - refuse the upgrade with `400` unless the client offers the right `<peer>.sp.nanomsg.org`
 *   subprotocol, and echo it back on success;
 * - no SP handshake frame and no 9-byte length header — one binary frame per SP message;
 * - REP: `<4-byte request id, top bit set><payload>`, id echoed on the reply; a frame with the flag
 *   missing (or shorter than 4 bytes) is dropped without an answer, like nng's rep0.
 */
import { REQ_ID_FLAG, SP_WS_SUBPROTOCOL_PUB0, SP_WS_SUBPROTOCOL_REP0, encodeReqBody, splitReqBody } from "../src/transport";

export type FakeWsHandler = (req: { id: number; payload: Uint8Array; conn: number }) => Promise<Uint8Array | null> | Uint8Array | null;

export interface FakeWsRepServer {
  url: string;
  port: number;
  /** Number of upgrades accepted so far. */
  readonly connections: number;
  /** Frames the server ignored because the REQ0 id was missing or unflagged. */
  readonly dropped: number;
  /** Close every client socket (simulates the server dying). */
  dropAll(): void;
  stop(): Promise<void>;
}

export async function startFakeWsRepServer(
  handler: FakeWsHandler,
  opts: { subprotocol?: string; path?: string; port?: number } = {},
): Promise<FakeWsRepServer> {
  const subprotocol = opts.subprotocol ?? SP_WS_SUBPROTOCOL_REP0;
  const path = opts.path ?? "/kicad";
  const socks = new Set<{ close(code?: number, reason?: string): void }>();
  /** Which upgrade a socket came from, so handlers can tell reconnects apart. */
  const connOf = new WeakMap<object, number>();
  let connCounter = 0;
  let dropped = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
      if (!offered.includes(subprotocol)) return new Response("bad request", { status: 400 });
      const ok = srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": subprotocol } });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) {
        socks.add(ws);
        connOf.set(ws, ++connCounter);
      },
      async message(ws, message) {
        if (typeof message === "string") return;
        const frame = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        if (frame.length < 4 || (new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0) & REQ_ID_FLAG) === 0) {
          dropped++;
          return;
        }
        const { id, payload } = splitReqBody(frame);
        const reply = await handler({ id, payload: payload.slice(), conn: connOf.get(ws) ?? 0 });
        if (reply && socks.has(ws)) ws.send(encodeReqBody(id, reply));
      },
      close(ws) {
        socks.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port!}${path}`,
    port: server.port!,
    get connections() {
      return connCounter;
    },
    get dropped() {
      return dropped;
    },
    dropAll() {
      for (const s of socks) s.close(1006, "server dropped");
      socks.clear();
    },
    async stop() {
      for (const s of socks) s.close(1000, "stopping");
      socks.clear();
      await server.stop(true);
    },
  };
}

export interface FakeWsPubServer {
  url: string;
  port: number;
  readonly subscribers: number;
  publish(body: Uint8Array): void;
  dropAll(): void;
  stop(): Promise<void>;
}

export async function startFakeWsPubServer(opts: { subprotocol?: string; path?: string; port?: number } = {}): Promise<FakeWsPubServer> {
  const subprotocol = opts.subprotocol ?? SP_WS_SUBPROTOCOL_PUB0;
  const path = opts.path ?? "/kicad/events";
  const socks = new Set<{ send(data: Uint8Array): unknown; close(code?: number, reason?: string): void }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
      if (!offered.includes(subprotocol)) return new Response("bad request", { status: 400 });
      const ok = srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": subprotocol } });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws) {
        socks.add(ws);
      },
      message() {
        /* nng publishers never read: sub0 filtering is subscriber-side */
      },
      close(ws) {
        socks.delete(ws);
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port!}${path}`,
    port: server.port!,
    get subscribers() {
      return socks.size;
    },
    publish(body) {
      for (const s of socks) s.send(body);
    },
    dropAll() {
      for (const s of socks) s.close(1006, "server dropped");
      socks.clear();
    },
    async stop() {
      for (const s of socks) s.close(1000, "stopping");
      socks.clear();
      await server.stop(true);
    },
  };
}
