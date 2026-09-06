/** A tiny nng PUB0-speaking unix-socket server for exercising NngIpcSubscriber without KiCad. */
import { rm } from "node:fs/promises";
import { NngFrameParser, SP_PROTO_PUB0, SP_PROTO_SUB0, encodeNngFrame, encodeSpHandshake } from "../src/transport";

export interface FakePubServer {
  path: string;
  readonly subscribers: number;
  publish(body: Uint8Array): void;
  dropAll(): void;
  stop(): Promise<void>;
}

export async function startFakePubServer(opts: { handshakeProto?: number; path?: string } = {}): Promise<FakePubServer> {
  const path = opts.path ?? `/tmp/kicad/fakepub-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  await rm(path, { force: true });
  type Sock = Parameters<NonNullable<Parameters<typeof Bun.listen>[0]["socket"]["open"]>>[0];
  const socks = new Set<Sock>();
  const parsers = new WeakMap<object, NngFrameParser>();
  const server = Bun.listen({
    unix: path,
    socket: {
      open(s) {
        socks.add(s);
        parsers.set(s, new NngFrameParser({ expectPeerProto: SP_PROTO_SUB0 }));
        s.write(encodeSpHandshake(opts.handshakeProto ?? SP_PROTO_PUB0));
      },
      data(s, chunk) {
        try {
          parsers.get(s)!.push(new Uint8Array(chunk)); // only the handshake is expected
        } catch {
          s.end();
        }
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
    get subscribers() {
      return socks.size;
    },
    publish(body) {
      const frame = encodeNngFrame(body);
      for (const s of socks) s.write(frame);
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
