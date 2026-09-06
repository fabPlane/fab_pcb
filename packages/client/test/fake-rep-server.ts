/** A tiny nng REP0-speaking unix-socket server for exercising NngIpcTransport without KiCad. */
import { rm } from "node:fs/promises";
import {
  NngFrameParser,
  SP_PROTO_REP0,
  SP_PROTO_REQ0,
  encodeNngFrame,
  encodeReqBody,
  encodeSpHandshake,
  splitReqBody,
} from "../src/transport";

export type FakeHandler = (req: { id: number; payload: Uint8Array; conn: number }) => Promise<Uint8Array | null> | Uint8Array | null;

export interface FakeRepServer {
  path: string;
  connections: number;
  /** Close every client socket (simulates the server dying). */
  dropAll(): void;
  stop(): Promise<void>;
}

export async function startFakeRepServer(
  handler: FakeHandler,
  opts: { handshakeProto?: number; path?: string } = {},
): Promise<FakeRepServer> {
  const path = opts.path ?? `/tmp/kicad/fake-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  await rm(path, { force: true });
  type Sock = Parameters<NonNullable<Parameters<typeof Bun.listen>[0]["socket"]["open"]>>[0];
  const socks = new Set<Sock>();
  let connCounter = 0;
  const parsers = new WeakMap<object, NngFrameParser>();
  const backlog = new WeakMap<object, Uint8Array[]>();
  const writeAll = (s: Sock, bytes: Uint8Array) => {
    const q = backlog.get(s) ?? [];
    if (q.length) {
      q.push(bytes);
      backlog.set(s, q);
      return;
    }
    const n = s.write(bytes);
    if (n < bytes.length) backlog.set(s, [bytes.subarray(Math.max(n, 0))]);
  };
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) {
        socks.add(s);
        connCounter++;
        parsers.set(s, new NngFrameParser({ expectPeerProto: SP_PROTO_REQ0 }));
        s.write(encodeSpHandshake(opts.handshakeProto ?? SP_PROTO_REP0));
      },
      async data(s, chunk) {
        const parser = parsers.get(s)!;
        let bodies: Uint8Array[];
        try {
          bodies = parser.push(new Uint8Array(chunk));
        } catch {
          s.end();
          return;
        }
        const conn = connCounter;
        for (const body of bodies) {
          const { id, payload } = splitReqBody(body);
          const reply = await handler({ id, payload, conn });
          if (reply && socks.has(s)) writeAll(s, encodeNngFrame(encodeReqBody(id, reply)));
        }
      },
      drain(s) {
        const q = backlog.get(s);
        if (!q || q.length === 0) return;
        backlog.set(s, []);
        for (const b of q) writeAll(s, b);
      },
      close(s) {
        socks.delete(s);
      },
      error(s) {
        socks.delete(s);
      },
    },
  });
  return {
    path,
    get connections() {
      return connCounter;
    },
    dropAll() {
      for (const s of socks) s.end();
      socks.clear();
    },
    async stop() {
      for (const s of socks) s.end();
      socks.clear();
      server.stop(true);
      await rm(path, { force: true });
    },
  };
}
