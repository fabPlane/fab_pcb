/**
 * Integration: the browser-shaped path with no bridge — `NngWsTransport` straight onto
 * `kicad-cli api-server --socket ws://127.0.0.1:<port>/kicad` (KiCad >= 8eafd9cf01), plus
 * `NngWsSubscriber` on the events URL KiCad derives from it. Skipped (with a message) when the
 * kicad-cli binary is missing.
 *
 * These tests are the empirical source for the wire-format note in `src/transport/nng-ws.ts`:
 * the subprotocol replaces the SP handshake, WebSocket frames replace the 9-byte length header,
 * and the flagged REQ0 request id stays.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KiCadEvents } from "../src/events";
import { KiCad } from "../src/model";
import { NngIpcTransport, NngWsSubscriber, NngWsTransport, SP_WS_SUBPROTOCOL_PUB0, SP_WS_SUBPROTOCOL_REP0 } from "../src/transport";
import { KiCadObjectType } from "@fp-pcb/proto";
import {
  KICAD_CLI,
  PING_REQUEST,
  decodeApiResponse,
  haveKicad,
  startKicadServer,
  startKicadWsServer,
  tempKitchenSinkBoard,
  type KicadServer,
  type KicadWsServer,
  type TempBoard,
} from "./kicad-fixtures";

if (!haveKicad()) {
  console.log(`[skip] kicad-cli not found at ${KICAD_CLI} (set KICAD_CLI to run the integration tests)`);
}

describe.skipIf(!haveKicad())("NngWsTransport against kicad-cli api-server --socket ws://", () => {
  let board: TempBoard;
  let server: KicadWsServer;
  let transport: NngWsTransport;
  let kicad: KiCad;

  beforeAll(async () => {
    board = await tempKitchenSinkBoard("fp-pcb-ws-it-");
    server = await startKicadWsServer(board.pcb, { token: "fp-pcb-ws-it" });
    transport = await NngWsTransport.connect({ url: server.url, defaultTimeoutMs: 60_000 });
    kicad = await KiCad.connect(transport, { clientName: "fp-pcb/ws-it", readyTimeoutMs: 60_000 });
  }, 90_000);

  afterAll(async () => {
    await transport?.close().catch(() => {});
    await server?.stop();
    await board?.cleanup();
  });

  test("the upgrade negotiates rep.sp.nanomsg.org and there is no SP handshake frame", async () => {
    expect(transport.subprotocol).toBe(SP_WS_SUBPROTOCOL_REP0);
    expect(transport.state).toBe("open");
    // A raw socket confirms the server echoes the subprotocol and sends nothing before we do.
    const raw = new WebSocket(server.url, [SP_WS_SUBPROTOCOL_REP0]);
    raw.binaryType = "arraybuffer";
    const unsolicited: unknown[] = [];
    raw.addEventListener("message", (ev) => unsolicited.push(ev.data));
    await new Promise<void>((res, rej) => {
      raw.addEventListener("open", () => res());
      raw.addEventListener("error", () => rej(new Error("upgrade failed")));
    });
    expect(raw.protocol).toBe(SP_WS_SUBPROTOCOL_REP0);
    await Bun.sleep(200);
    expect(unsolicited).toEqual([]);
    raw.close();
  }, 15_000);

  test("a request without the REQ0 flag, and one with the ipc length header, get no reply", async () => {
    const raw = new WebSocket(server.url, [SP_WS_SUBPROTOCOL_REP0]);
    raw.binaryType = "arraybuffer";
    const replies: unknown[] = [];
    raw.addEventListener("message", (ev) => replies.push(ev.data));
    await new Promise<void>((res, rej) => {
      raw.addEventListener("open", () => res());
      raw.addEventListener("error", () => rej(new Error("upgrade failed")));
    });
    const withId = (id: number) => {
      const f = new Uint8Array(4 + PING_REQUEST.length);
      new DataView(f.buffer).setUint32(0, id >>> 0);
      f.set(PING_REQUEST, 4);
      return f;
    };
    raw.send(withId(0x00000007)); // no REQ0 flag: rep0 never finds the backtrace terminator
    raw.send(PING_REQUEST); // no request id at all
    const body = withId(0x80000009);
    const ipcFramed = new Uint8Array(9 + body.length); // the ipc 9-byte header, which ws does not use
    ipcFramed[0] = 0x01;
    new DataView(ipcFramed.buffer).setBigUint64(1, BigInt(body.length));
    ipcFramed.set(body, 9);
    raw.send(ipcFramed);
    await Bun.sleep(500);
    expect(replies).toEqual([]);
    // A properly flagged request on the same socket still works: the server did not hang up.
    raw.send(withId(0x80000011));
    const reply = await new Promise<Uint8Array>((res, rej) => {
      const t = setTimeout(() => rej(new Error("no reply")), 5000);
      raw.addEventListener("message", (ev) => {
        clearTimeout(t);
        res(new Uint8Array(ev.data as ArrayBuffer));
      });
    });
    expect(new DataView(reply.buffer).getUint32(0)).toBe(0x80000011);
    expect(decodeApiResponse(reply.subarray(4)).statusName).toBe("AS_OK");
    raw.close();
  }, 20_000);

  test("Ping and GetVersion round-trip", async () => {
    const r = decodeApiResponse(await transport.send(PING_REQUEST));
    expect(r.statusName).toBe("AS_OK");
    expect(r.token).toBe(server.token);
    const version = await kicad.versionString();
    expect(version).toMatch(/^\d+\.\d+/);
    console.log(`  direct ws: KiCad ${version}, token ${r.token}`);
  }, 30_000);

  test("GetItems returns the kitchen-sink board's footprints", async () => {
    const board = await kicad.currentBoard();
    expect(board).toBeDefined();
    const footprints = await board!.getItems(KiCadObjectType.KOT_PCB_FOOTPRINT);
    expect(footprints.length).toBeGreaterThan(0);
    console.log(`  direct ws: ${footprints.length} footprints`);
  }, 60_000);

  test("a commit round-trips: move a footprint, read it back, undo", async () => {
    const board = (await kicad.currentBoard())!;
    const footprints = await board.getFootprints();
    const target = footprints[0]!;
    const before = { ...target.position };
    const moved = await board.commit("direct-ws move", (tx) => {
      target.position = { x: before.x + 1_000_000, y: before.y };
      return tx.update([target]);
    });
    expect(moved.commitId).toBeTruthy();
    const after = (await board.getItems(KiCadObjectType.KOT_PCB_FOOTPRINT)).find((i) => i.id === target.id)!;
    expect((after as typeof target).position.x).toBe(before.x + 1_000_000);
    const undone = await board.undo(1);
    expect(undone.applied).toBeGreaterThan(0);
    const restored = (await board.getItems(KiCadObjectType.KOT_PCB_FOOTPRINT)).find((i) => i.id === target.id)!;
    expect((restored as typeof target).position.x).toBe(before.x);
  }, 90_000);

  test("GetServerInfo reports the ws request and events URLs", async () => {
    const info = await kicad.serverInfo();
    expect(info?.socketUrl).toBe(server.url);
    expect(info?.eventsSocketUrl).toBe(server.eventsUrl);
    expect(info?.kicadToken).toBe(server.token);
  }, 15_000);

  test("NngWsSubscriber receives KiCad events over ws with no bridge", async () => {
    const info = await kicad.serverInfo();
    const sub = await NngWsSubscriber.connect({ url: info!.eventsSocketUrl, connectTimeoutMs: 10_000 });
    expect(sub.subprotocol).toBe(SP_WS_SUBPROTOCOL_PUB0);
    const events = new KiCadEvents(sub);
    const seen: string[] = [];
    events.on("documentChanged", () => seen.push("documentChanged"));
    await Bun.sleep(200);
    const board = (await kicad.currentBoard())!;
    const fp = (await board.getFootprints())[0]!;
    await board.commit("direct-ws event", (tx) => {
      fp.position = { x: fp.position.x + 500_000, y: fp.position.y };
      return tx.update([fp]);
    });
    const deadline = Date.now() + 10_000;
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(50);
    await board.undo(1).catch(() => undefined);
    await sub.close();
    expect(seen.length).toBeGreaterThan(0);
    console.log(`  direct ws: ${seen.length} event(s) over ws://.../events`);
  }, 60_000);

  test("200 sequential Pings, timed against the same server over ipc", async () => {
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) expect(decodeApiResponse(await transport.send(PING_REQUEST)).status).toBe(1);
    const wsMs = performance.now() - t0;
    console.log(`  [timing] NngWsTransport (direct ws): ${N} sequential Pings in ${wsMs.toFixed(1)} ms (${(wsMs / N).toFixed(2)} ms/req)`);

    // Same board, a second server on ipc, for a like-for-like comparison in the same run. Its own
    // copy: two servers on one project directory would fight over the project lock file.
    let ipcBoard: TempBoard | undefined;
    let ipc: KicadServer | undefined;
    let ipcTransport: NngIpcTransport | undefined;
    try {
      ipcBoard = await tempKitchenSinkBoard("fp-pcb-ws-it-ipc-");
      ipc = await startKicadServer(ipcBoard.pcb, "ws-it-ipc");
      ipcTransport = await NngIpcTransport.connect({ path: ipc.socketPath, defaultTimeoutMs: 60_000 });
      const deadline = Date.now() + 40_000;
      while (decodeApiResponse(await ipcTransport.send(PING_REQUEST)).status !== 1 && Date.now() < deadline) await Bun.sleep(25);
      const t1 = performance.now();
      for (let i = 0; i < N; i++) expect(decodeApiResponse(await ipcTransport.send(PING_REQUEST)).status).toBe(1);
      const ipcMs = performance.now() - t1;
      console.log(
        `  [timing] NngIpcTransport (unix socket): ${N} sequential Pings in ${ipcMs.toFixed(1)} ms (${(ipcMs / N).toFixed(2)} ms/req)`,
      );
    } finally {
      await ipcTransport?.close().catch(() => {});
      await ipc?.stop();
      await ipcBoard?.cleanup();
    }
  }, 180_000);

  test("the server survives a dropped socket and a redial", async () => {
    const t2 = await NngWsTransport.connect({ url: server.url, defaultTimeoutMs: 20_000 });
    expect(decodeApiResponse(await t2.send(PING_REQUEST)).status).toBe(1);
    await t2.close();
    const t3 = await NngWsTransport.connect({ url: server.url, defaultTimeoutMs: 20_000 });
    expect(decodeApiResponse(await t3.send(PING_REQUEST)).status).toBe(1);
    await t3.close();
    expect(decodeApiResponse(await transport.send(PING_REQUEST)).status).toBe(1);
  }, 30_000);
});
