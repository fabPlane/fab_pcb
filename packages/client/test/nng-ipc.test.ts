import { afterEach, describe, expect, test } from "bun:test";
import { NngIpcTransport, SP_PROTO_REQ0, TransportError } from "../src/transport";
import { startFakeRepServer, type FakeRepServer } from "./fake-rep-server";

const echo = (b: Uint8Array) => b;
let servers: FakeRepServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
});

describe("NngIpcTransport against a fake REP0 server", () => {
  test("handshake, echo, state transitions, close", async () => {
    const srv = await startFakeRepServer(({ payload }) => echo(payload));
    servers.push(srv);
    const states: string[] = [];
    const t = new NngIpcTransport({ path: `ipc://${srv.path}` });
    t.onStateChange((s) => states.push(s));
    expect(t.state).toBe("connecting");
    await t.ready();
    expect(t.state).toBe("open");
    const reply = await t.send(Uint8Array.from([1, 2, 3]));
    expect(Array.from(reply)).toEqual([1, 2, 3]);
    await t.close();
    expect(t.state).toBe("closed");
    expect(states).toEqual(["open", "closed"]);
    await expect(t.send(new Uint8Array(1))).rejects.toMatchObject({ code: "closed" });
  });

  test("FIFO queue: concurrent sends are serialised and answered in order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const srv = await startFakeRepServer(async ({ payload }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(2);
      inFlight--;
      return payload;
    });
    servers.push(srv);
    const t = await NngIpcTransport.connect(srv.path);
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => t.send(Uint8Array.from([i]))));
    expect(replies.map((r) => r[0])).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(maxInFlight).toBe(1);
    expect(srv.connections).toBe(1);
    await t.close();
  });

  test("large request and reply bodies survive framing", async () => {
    const srv = await startFakeRepServer(({ payload }) => payload);
    servers.push(srv);
    const t = await NngIpcTransport.connect(srv.path);
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4099) big[i] = i & 0xff;
    const reply = await t.send(big);
    expect(reply.length).toBe(big.length);
    expect(Buffer.from(reply).equals(Buffer.from(big))).toBe(true);
    await t.close();
  });

  test("timeout rejects, late reply is dropped, next request still works", async () => {
    const srv = await startFakeRepServer(async ({ payload }) => {
      if (payload[0] === 0xee) await Bun.sleep(150);
      return payload;
    });
    servers.push(srv);
    const logs: string[] = [];
    const t = await NngIpcTransport.connect({ path: srv.path, log: (m) => logs.push(m) });
    await expect(t.send(Uint8Array.from([0xee]), { timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
    const r = await t.send(Uint8Array.from([0x01]));
    expect(r[0]).toBe(1);
    await Bun.sleep(200);
    expect(logs.some((l) => l.includes("late reply"))).toBe(true);
    expect(t.state).toBe("open");
    await t.close();
  });

  test("peer close rejects in-flight and queued requests with 'closed' (no reconnect)", async () => {
    const srv = await startFakeRepServer(async () => {
      await Bun.sleep(20);
      srv.dropAll();
      return null;
    });
    servers.push(srv);
    const t = await NngIpcTransport.connect(srv.path);
    const a = t.send(new Uint8Array(1)).catch((e: unknown) => e);
    const b = t.send(new Uint8Array(1)).catch((e: unknown) => e);
    expect(await a).toMatchObject({ code: "closed" });
    expect(await b).toMatchObject({ code: "closed" });
    expect(t.state).toBe("closed");
  });

  test("reconnect with backoff: queued requests survive, in-flight is rejected", async () => {
    let calls = 0;
    const srv = await startFakeRepServer(async ({ payload }) => {
      calls++;
      if (calls === 1) {
        srv.dropAll();
        return null;
      }
      return payload;
    });
    servers.push(srv);
    const states: string[] = [];
    const t = await NngIpcTransport.connect({ path: srv.path, reconnect: { initialDelayMs: 10 } });
    t.onStateChange((s) => states.push(s));
    const a = t.send(Uint8Array.from([1])).catch((e: unknown) => e);
    const b = t.send(Uint8Array.from([2]));
    expect(await a).toMatchObject({ code: "closed" });
    expect(Array.from(await b)).toEqual([2]);
    expect(states).toEqual(["connecting", "open"]);
    expect(srv.connections).toBe(2);
    await t.close();
  });

  test("reconnect gives up after maxAttempts", async () => {
    const srv = await startFakeRepServer(() => null);
    servers.push(srv);
    const t = await NngIpcTransport.connect({ path: srv.path, reconnect: { initialDelayMs: 5, maxAttempts: 2 } });
    await srv.stop();
    servers = [];
    const start = Date.now();
    await expect(t.send(new Uint8Array(1), { timeoutMs: 0 })).rejects.toBeInstanceOf(TransportError);
    expect(t.state).toBe("closed");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("connect failure: missing socket", async () => {
    const t = new NngIpcTransport({ path: "/tmp/kicad/does-not-exist.sock" });
    await expect(t.ready()).rejects.toMatchObject({ code: "connect" });
    expect(t.state).toBe("closed");
  });

  test("protocol error: peer is not REP0", async () => {
    const srv = await startFakeRepServer(() => null, { handshakeProto: SP_PROTO_REQ0 });
    servers.push(srv);
    const t = new NngIpcTransport(srv.path);
    await expect(t.ready()).rejects.toMatchObject({ code: "protocol" });
    expect(t.state).toBe("closed");
  });

  test("onTimeout: 'reconnect' drops the socket and dials again", async () => {
    const srv = await startFakeRepServer(async ({ payload }) => {
      if (payload[0] === 0xee) await Bun.sleep(500);
      return payload;
    });
    servers.push(srv);
    const t = await NngIpcTransport.connect({ path: srv.path, reconnect: { initialDelayMs: 5 }, onTimeout: "reconnect" });
    await expect(t.send(Uint8Array.from([0xee]), { timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
    const r = await t.send(Uint8Array.from([7]));
    expect(r[0]).toBe(7);
    expect(srv.connections).toBe(2);
    await t.close();
  });
});
