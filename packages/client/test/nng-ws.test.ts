/**
 * Unit tests for the ws framing: `NngWsTransport` / `NngWsSubscriber` against the fake nng-over-
 * WebSocket servers in ./fake-ws-server, which reproduce what `kicad-cli api-server --socket
 * ws://...` was measured to put on the wire (subprotocol handshake, no length header, flagged REQ0
 * request id). No KiCad needed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  NngWsSubscriber,
  NngWsTransport,
  REQ_ID_FLAG,
  SP_PROTO_PUB0,
  SP_PROTO_REP0,
  SP_PROTO_REQ0,
  SP_WS_SUBPROTOCOL_PUB0,
  SP_WS_SUBPROTOCOL_REP0,
  spWsSubprotocol,
} from "../src/transport";
import { startFakeWsPubServer, startFakeWsRepServer, type FakeWsPubServer, type FakeWsRepServer } from "./fake-ws-server";

let servers: Array<FakeWsRepServer | FakeWsPubServer> = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
});

describe("SP WebSocket subprotocol names", () => {
  test("name the peer's protocol, not our own", () => {
    expect(spWsSubprotocol(SP_PROTO_REP0)).toBe("rep.sp.nanomsg.org");
    expect(spWsSubprotocol(SP_PROTO_PUB0)).toBe("pub.sp.nanomsg.org");
    expect(spWsSubprotocol(SP_PROTO_REQ0)).toBe("req.sp.nanomsg.org");
    expect(SP_WS_SUBPROTOCOL_REP0).toBe("rep.sp.nanomsg.org");
    expect(SP_WS_SUBPROTOCOL_PUB0).toBe("pub.sp.nanomsg.org");
    expect(() => spWsSubprotocol(0x99)).toThrow(/no SP protocol name/);
  });
});

describe("NngWsTransport against a fake REP0 WebSocket server", () => {
  test("upgrade, echo, state transitions, close", async () => {
    const srv = await startFakeWsRepServer(({ payload }) => payload);
    servers.push(srv);
    const states: string[] = [];
    const t = new NngWsTransport({ url: srv.url });
    t.onStateChange((s) => states.push(s));
    expect(t.state).toBe("connecting");
    await t.ready();
    expect(t.state).toBe("open");
    expect(t.subprotocol).toBe(SP_WS_SUBPROTOCOL_REP0);
    const reply = await t.send(Uint8Array.from([1, 2, 3]));
    expect(Array.from(reply)).toEqual([1, 2, 3]);
    await t.close();
    expect(t.state).toBe("closed");
    expect(states).toEqual(["open", "closed"]);
    await expect(t.send(new Uint8Array(1))).rejects.toMatchObject({ code: "closed" });
  });

  test("sends one binary frame per request: no SP handshake, no 9-byte length header, flagged REQ0 id", async () => {
    const frames: Uint8Array[] = [];
    const srv = await startFakeWsRepServer(({ id, payload }) => {
      frames.push(payload);
      expect((id & REQ_ID_FLAG) >>> 0).toBe(REQ_ID_FLAG);
      return payload;
    });
    servers.push(srv);
    const t = await NngWsTransport.connect(srv.url);
    const body = Uint8Array.from([9, 8, 7, 6, 5]);
    const reply = await t.send(body);
    // The server strips exactly 4 bytes of id and finds the payload — nothing else on the wire.
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!)).toEqual(Array.from(body));
    expect(Array.from(reply)).toEqual(Array.from(body));
    expect(srv.dropped).toBe(0);
    await t.close();
  });

  test("rejects a non-ws URL", () => {
    expect(() => new NngWsTransport({ url: "ipc:///tmp/kicad/api.sock" })).toThrow(/ws:\/\/ or wss:\/\//);
  });

  test("FIFO queue: concurrent sends are serialised on one socket and answered in order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const srv = await startFakeWsRepServer(async ({ payload }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(2);
      inFlight--;
      return payload;
    });
    servers.push(srv);
    const t = await NngWsTransport.connect(srv.url);
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => t.send(Uint8Array.from([i]))));
    expect(replies.map((r) => r[0])).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(maxInFlight).toBe(1);
    expect(srv.connections).toBe(1);
    await t.close();
  });

  test("request ids are unique per request and echoed back", async () => {
    const ids: number[] = [];
    const srv = await startFakeWsRepServer(({ id, payload }) => {
      ids.push(id);
      return payload;
    });
    servers.push(srv);
    const t = await NngWsTransport.connect(srv.url);
    await Promise.all(Array.from({ length: 5 }, (_, i) => t.send(Uint8Array.from([i]))));
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => (id & REQ_ID_FLAG) >>> 0 === REQ_ID_FLAG)).toBe(true);
    await t.close();
  });

  test("large request and reply bodies survive one WebSocket frame each", async () => {
    const srv = await startFakeWsRepServer(({ payload }) => payload);
    servers.push(srv);
    const t = await NngWsTransport.connect(srv.url);
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4099) big[i] = i & 0xff;
    const reply = await t.send(big);
    expect(reply.length).toBe(big.length);
    expect(Buffer.from(reply).equals(Buffer.from(big))).toBe(true);
    await t.close();
  });

  test("a timed-out request rejects and its late reply is dropped, not mis-delivered", async () => {
    let n = 0;
    const srv = await startFakeWsRepServer(async ({ payload }) => {
      if (n++ === 0) await Bun.sleep(120);
      return payload;
    });
    servers.push(srv);
    const t = await NngWsTransport.connect({ url: srv.url, defaultTimeoutMs: 0 });
    await expect(t.send(Uint8Array.from([1]), { timeoutMs: 20 })).rejects.toMatchObject({ name: "TransportError", code: "timeout" });
    const reply = await t.send(Uint8Array.from([2]), { timeoutMs: 2000 });
    expect(Array.from(reply)).toEqual([2]);
    expect(t.state).toBe("open");
    await t.close();
  });

  test("a dropped socket rejects the in-flight request and closes without reconnect", async () => {
    const srv = await startFakeWsRepServer(async () => {
      await Bun.sleep(1000);
      return null;
    });
    servers.push(srv);
    const t = await NngWsTransport.connect(srv.url);
    const pending = t.send(Uint8Array.from([1]), { timeoutMs: 5000 }).catch((e: unknown) => e);
    await Bun.sleep(30);
    srv.dropAll();
    expect(await pending).toMatchObject({ name: "TransportError", code: "closed" });
    await Bun.sleep(30);
    expect(t.state).toBe("closed");
  });

  test("with reconnect on, a dropped socket redials and queued requests survive", async () => {
    const srv = await startFakeWsRepServer(({ payload, conn }) => Uint8Array.from([conn, ...payload]));
    servers.push(srv);
    const t = await NngWsTransport.connect({ url: srv.url, reconnect: { initialDelayMs: 10, maxDelayMs: 20 } });
    expect(Array.from(await t.send(Uint8Array.from([1])))).toEqual([1, 1]);
    srv.dropAll();
    await Bun.sleep(20);
    const reply = await t.send(Uint8Array.from([2]), { timeoutMs: 3000 });
    expect(reply[0]).toBe(2); // second connection
    expect(t.state).toBe("open");
    await t.close();
  });

  test("a server that refuses the subprotocol never opens", async () => {
    const srv = await startFakeWsRepServer(({ payload }) => payload, { subprotocol: "something.else" });
    servers.push(srv);
    const t = new NngWsTransport({ url: srv.url, connectTimeoutMs: 2000 });
    await expect(t.ready()).rejects.toMatchObject({ name: "TransportError", code: "connect" });
    expect(t.state).toBe("closed");
  });

  test("connect timeout on a URL nothing answers", async () => {
    const t = new NngWsTransport({ url: "ws://127.0.0.1:1/kicad", connectTimeoutMs: 300 });
    await expect(t.ready()).rejects.toMatchObject({ name: "TransportError", code: "connect" });
  });
});

describe("NngWsSubscriber against a fake PUB0 WebSocket server", () => {
  test("receives one event per binary frame, unframed and byte-for-byte", async () => {
    const srv = await startFakeWsPubServer();
    servers.push(srv);
    const got: Uint8Array[] = [];
    const sub = await NngWsSubscriber.connect({ url: srv.url });
    sub.onMessage((b) => got.push(b));
    expect(sub.state).toBe("open");
    expect(sub.subprotocol).toBe(SP_WS_SUBPROTOCOL_PUB0);
    await Bun.sleep(10);
    srv.publish(Uint8Array.from([1, 2, 3]));
    srv.publish(Uint8Array.from([4, 5]));
    await Bun.sleep(50);
    expect(got.map((b) => Array.from(b))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    await sub.close();
    expect(sub.state).toBe("closed");
  });

  test("rejects a non-ws URL", () => {
    expect(() => new NngWsSubscriber({ url: "ipc:///tmp/kicad/api-events.sock" })).toThrow(/ws:\/\/ or wss:\/\//);
  });

  test("a dropped socket closes without reconnect, and redials with it", async () => {
    const srv = await startFakeWsPubServer();
    servers.push(srv);
    const plain = await NngWsSubscriber.connect({ url: srv.url });
    srv.dropAll();
    await Bun.sleep(50);
    expect(plain.state).toBe("closed");

    const states: string[] = [];
    const retry = await NngWsSubscriber.connect({ url: srv.url, reconnect: { initialDelayMs: 10, maxDelayMs: 20 } });
    retry.onStateChange((s) => states.push(s));
    const got: number[] = [];
    retry.onMessage((b) => got.push(b[0]!));
    srv.dropAll();
    await Bun.sleep(150);
    expect(retry.state).toBe("open");
    expect(states).toContain("connecting");
    srv.publish(Uint8Array.from([7]));
    await Bun.sleep(50);
    expect(got).toEqual([7]);
    await retry.close();
  });

  test("a server that refuses the subprotocol never opens", async () => {
    const srv = await startFakeWsPubServer({ subprotocol: "something.else" });
    servers.push(srv);
    const sub = new NngWsSubscriber({ url: srv.url, connectTimeoutMs: 2000 });
    await expect(sub.ready()).rejects.toMatchObject({ name: "TransportError" });
    expect(sub.state).toBe("closed");
  });
});
