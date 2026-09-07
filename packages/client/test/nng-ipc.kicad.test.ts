/**
 * Integration: a real `kicad-cli api-server` with the kitchen-sink board, Ping through
 * NngIpcTransport. Skipped (with a message) when the kicad-cli binary is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NngIpcTransport } from "../src/transport";
import { KICAD_CLI, KITCHEN_SINK_PCB, PING_REQUEST, decodeApiResponse, haveKicad, startKicadServer, type KicadServer } from "./kicad-fixtures";

if (!haveKicad()) {
  console.log(`[skip] kicad-cli not found at ${KICAD_CLI} (set KICAD_CLI to run the integration tests)`);
}

describe.skipIf(!haveKicad())("NngIpcTransport against kicad-cli api-server", () => {
  let server: KicadServer;
  let transport: NngIpcTransport;

  beforeAll(async () => {
    server = await startKicadServer(KITCHEN_SINK_PCB, "client-it");
    transport = await NngIpcTransport.connect({ path: server.socketPath, defaultTimeoutMs: 10_000 });
  }, 60_000);

  afterAll(async () => {
    await transport?.close();
    await server?.stop();
  });

  test("Ping answers AS_NOT_READY while the board loads, then AS_OK with a kicad token", async () => {
    const seen: string[] = [];
    let r = decodeApiResponse(await transport.send(PING_REQUEST));
    const deadline = Date.now() + 30_000;
    while (r.status !== 1 && Date.now() < deadline) {
      seen.push(r.statusName);
      expect(r.statusName).toBe("AS_NOT_READY");
      await Bun.sleep(25);
      r = decodeApiResponse(await transport.send(PING_REQUEST));
    }
    expect(r.statusName).toBe("AS_OK");
    expect(r.token).toMatch(/^[0-9a-f-]{36}$/);
    console.log(`  ready after ${seen.length} AS_NOT_READY replies; token ${r.token}`);
  }, 40_000);

  test("200 sequential Pings (timed)", async () => {
    const t0 = performance.now();
    let token = "";
    for (let i = 0; i < 200; i++) {
      const r = decodeApiResponse(await transport.send(PING_REQUEST));
      expect(r.status).toBe(1);
      token = r.token;
    }
    const ms = performance.now() - t0;
    console.log(`  [timing] NngIpcTransport: 200 sequential Pings in ${ms.toFixed(1)} ms (${(ms / 200).toFixed(2)} ms/req), token ${token}`);
  }, 30_000);

  test("200 queued Pings share one socket and all succeed", async () => {
    const t0 = performance.now();
    const replies = await Promise.all(Array.from({ length: 200 }, () => transport.send(PING_REQUEST)));
    const ms = performance.now() - t0;
    expect(replies.every((b) => decodeApiResponse(b).status === 1)).toBe(true);
    console.log(`  [timing] NngIpcTransport: 200 queued Pings in ${ms.toFixed(1)} ms`);
  }, 30_000);

  test("garbage request gets AS_BAD_REQUEST, transport stays open", async () => {
    const r = decodeApiResponse(await transport.send(Uint8Array.from([0x7a, 0x02, 0xff, 0xff])));
    expect(r.statusName).toBe("AS_BAD_REQUEST");
    expect(transport.state).toBe("open");
  });

  test("server killed mid-request: in-flight rejects with 'closed' and state becomes closed", async () => {
    const states: string[] = [];
    transport.onStateChange((s) => states.push(s));
    // The server answers a Ping in ~50 µs since the wake-up patch, so a request sent before the
    // kill could complete first; freeze the process so the request is genuinely in flight. Signals
    // go through the OS `kill` command: Bun's `proc.kill("SIGSTOP")` returned without stopping the
    // process on macOS (state stayed R), which is what made this test race in the first place.
    const signal = (sig: string) => Bun.spawnSync(["kill", `-${sig}`, String(server.proc.pid)]);
    signal("STOP");
    await new Promise((r) => setTimeout(r, 50));
    const pending = transport.send(PING_REQUEST, { timeoutMs: 5000 }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    signal("KILL");
    const err = await pending;
    expect(err).toMatchObject({ name: "TransportError", code: "closed" });
    expect(transport.state).toBe("closed");
    expect(states).toEqual(["closed"]);
  }, 10_000);
});
