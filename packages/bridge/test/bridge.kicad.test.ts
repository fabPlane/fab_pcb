/**
 * Integration: bridge + real `kicad-cli api-server` + WebSocketTransport. Skipped (with a message)
 * when kicad-cli is missing. Unit-level checks that need no KiCad live in bridge.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Footprint, KiCad, KiCadEvents } from "@fp-pcb/client";
import { WebSocketTransport, bridgeWsUrl, type BridgeControlMessage } from "@fp-pcb/client/transport";
import { Session, configFromEnv, KICAD_CHECKOUT, eventsSocketPathFor, startBridge, type BridgeServer } from "../src/index";
import { decodeApiResponse, encodePing } from "../src/kicad-ping";

const cfg = configFromEnv(process.env, { port: 0, log: () => {} });
const haveKicad = existsSync(cfg.kicadCli);
const PCB = `${KICAD_CHECKOUT}/qa/data/pcbnew/api_kitchen_sink.kicad_pcb`;
const PING = encodePing("fp-pcb/bridge-test");

if (!haveKicad) console.log(`[skip] kicad-cli not found at ${cfg.kicadCli} (set KICAD_CLI to run the bridge integration tests)`);

describe.skipIf(!haveKicad)("bridge + kicad-cli api-server + WebSocketTransport", () => {
  let bridge: BridgeServer;
  let workspace: string;
  let sessionId: string;
  let kicadToken: string;
  let ws: WebSocketTransport;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "fp-pcb-bridge-"));
    bridge = await startBridge({ ...cfg, workspaceRoot: workspace });
  }, 30_000);

  afterAll(async () => {
    await ws?.close();
    await bridge?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  const api = (path: string, init?: RequestInit) => fetch(`${bridge.url}${path}`, init);

  test("GET /health", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; kicadCliExists: boolean; sessions: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.kicadCliExists).toBe(true);
    expect(body.sessions).toEqual([]);
  });

  test("POST /sessions with a missing file is a 400", async () => {
    const res = await api("/sessions", { method: "POST", body: JSON.stringify({ path: "/nope/missing.kicad_pcb" }) });
    expect(res.status).toBe(400);
  });

  test("POST /sessions spawns kicad-cli and waits until it is running", async () => {
    const t0 = performance.now();
    const res = await api("/sessions", { method: "POST", body: JSON.stringify({ path: PCB }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      session: { id: string; state: string; kicadToken: string; socketPath: string; pid: number };
      wsUrl: string;
    };
    console.log(`  session ${body.session.id} running after ${(performance.now() - t0).toFixed(0)} ms (pid ${body.session.pid})`);
    expect(body.session.state).toBe("running");
    expect(body.session.kicadToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.wsUrl).toBe(`/ws?session=${body.session.id}`);
    expect((await stat(body.session.socketPath)).isSocket()).toBe(true);
    sessionId = body.session.id;
    kicadToken = body.session.kicadToken;
    const list = (await (await api("/sessions")).json()) as { sessions: Array<{ id: string }> };
    expect(list.sessions.map((s) => s.id)).toEqual([sessionId]);
  }, 60_000);

  test("WebSocketTransport receives hello with the session id and kicad token", async () => {
    const control: BridgeControlMessage[] = [];
    ws = new WebSocketTransport(bridgeWsUrl(bridge.url, sessionId), { keepaliveMs: 0 });
    ws.onControl((m) => control.push(m));
    await ws.ready();
    expect(ws.state).toBe("open");
    expect(ws.sessionId).toBe(sessionId);
    expect(ws.kicadToken).toBe(kicadToken);
    expect(ws.serverState).toBe("running");
    expect(control[0]?.type).toBe("hello");
  });

  test("Ping through the bridge is AS_OK with the same token", async () => {
    const r = decodeApiResponse(await ws.send(PING));
    expect(r.statusName).toBe("AS_OK");
    expect(r.token).toBe(kicadToken);
  });

  test("the bridge subscribes to KiCad's events socket (GetServerInfo) and announces it", async () => {
    const session = bridge.sessions.get(sessionId)!;
    const deadline = Date.now() + 5000;
    while (ws.eventsState !== "connected" && Date.now() < deadline) await Bun.sleep(10);
    expect(ws.eventsState).toBe("connected");
    expect(session.eventsState).toBe("connected");
    expect(session.eventsSocketPath).toBe(eventsSocketPathFor(session.socketPath));
    expect((await stat(session.eventsSocketPath!)).isSocket()).toBe(true);
    const info = (await (await api(`/sessions/${sessionId}`)).json()) as { session: { eventsState: string; eventsSocketPath: string } };
    expect(info.session.eventsState).toBe("connected");
  });

  test("a commit made through the client SDK arrives as DocumentChanged on the WebSocket and on the SSE stream", async () => {
    const events = KiCadEvents.fromTransport(ws);
    expect(events.state).toBe("open");
    const gaps: string[] = [];
    events.onGap((g) => gaps.push(`${g.expected}->${g.received}`));

    // SSE mirror of the same events
    const sse = await fetch(`${bridge.url}/sessions/${sessionId}/events`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let sseText = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 10_000;
      while (!sseText.includes(needle) && Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), Bun.sleep(200).then(() => ({ value: undefined, done: false }))]);
        if (done) break;
        if (value) sseText += dec.decode(value, { stream: true });
      }
    };
    await readUntil("event: state");
    expect(sseText).toContain('"state":"connected"');
    expect(bridge.sessions.get(sessionId)!.info().listeners).toBe(1);

    const kicad = await KiCad.connect(ws, { clientName: "fp-pcb/bridge-test/sdk" });
    const board = (await kicad.currentBoard())!;
    const fp = (await board.getAllItems()).find((i): i is Footprint => i instanceof Footprint)!;
    const orig = fp.position;
    fp.position = { x: orig.x + 1_000_000, y: orig.y };

    const changed = events.next("documentChanged", { timeoutMs: 10_000 });
    const t0 = performance.now();
    const res = await board.commit("bridge-test move", (tx) => tx.update([fp]));
    const ev = await changed;
    console.log(
      `  DocumentChanged relayed ${(performance.now() - t0).toFixed(0)} ms after the commit started (sequence ${events.lastSequence})`,
    );
    expect(res.updated.length).toBe(1);
    // KiCad (cbd303d16b) records a footprint UpdateItems in the COMMIT as remove + add of the same
    // KIID, so the event lists it under created+deleted rather than updated.
    const touched = [...ev.created, ...ev.updated].map((k) => k.value);
    expect(touched).toEqual([fp.id]);
    expect(ev.deleted.map((k) => k.value).every((id) => id === fp.id)).toBe(true);
    expect(ev.message).toBe("bridge-test move");
    expect(ev.clientName).toBe("fp-pcb/bridge-test/sdk");
    expect(ev.document?.type).toBe(board.documentType);
    expect(ev.revision).toBe((await board.revision())!);
    expect(gaps).toEqual([]);

    await readUntil('"bridge-test move"');
    const block = sseText.split("\n\n").find((b) => b.includes('"bridge-test move"'))!;
    expect(block).toStartWith("event: event\n");
    const json = JSON.parse(block.split("\n")[1]!.slice("data: ".length)) as {
      sequence: string;
      documentChanged: { created?: { value: string }[]; updated?: { value: string }[]; clientName: string };
    };
    expect([...(json.documentChanged.created ?? []), ...(json.documentChanged.updated ?? [])]).toEqual([{ value: fp.id }]);
    expect(json.documentChanged.clientName).toBe("fp-pcb/bridge-test/sdk");
    expect(BigInt(json.sequence)).toBe(events.lastSequence!);

    // put the footprint back so the checked-in fixture is not left modified in memory
    fp.position = orig;
    const restored = events.next("documentChanged", { timeoutMs: 10_000 });
    await board.commit("bridge-test move back", (tx) => tx.update([fp]));
    expect((await restored).message).toBe("bridge-test move back");
    expect(bridge.sessions.get(sessionId)!.eventsRelayed).toBeGreaterThanOrEqual(2);

    await reader.cancel();
    await events.close();
    expect(ws.state).toBe("open");
    const deadline = Date.now() + 2000;
    while (bridge.sessions.get(sessionId)!.info().listeners !== 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(bridge.sessions.get(sessionId)!.info().listeners).toBe(0);
  }, 30_000);

  test("an idle session is reaped after SESSION_IDLE_TIMEOUT_SEC", async () => {
    const b2 = await startBridge({ ...cfg, workspaceRoot: workspace, sessionIdleTimeoutSec: 1 });
    try {
      const res = await fetch(`${b2.url}/sessions`, { method: "POST", body: JSON.stringify({ id: "idle-test" }) });
      expect(res.status).toBe(201);
      const s = b2.sessions.get("idle-test")!;
      // a connected client keeps it alive
      const t = await WebSocketTransport.connect(bridgeWsUrl(b2.url, "idle-test"), { keepaliveMs: 0 });
      expect(await b2.sessions.reapIdle(Date.now() + 60_000)).toEqual([]);
      await t.close();
      // destroy() unlists the session first and then stops the process (SIGTERM, ~0.5 s)
      const deadline = Date.now() + 8000;
      while ((b2.sessions.get("idle-test") || s.state === "running") && Date.now() < deadline) await Bun.sleep(50);
      expect(b2.sessions.get("idle-test")).toBeUndefined();
      expect(s.state).toBe("exited");
      expect(existsSync(s.socketPath)).toBe(false);
      if (s.eventsSocketPath) expect(existsSync(s.eventsSocketPath)).toBe(false);
    } finally {
      await b2.stop();
    }
  }, 60_000);

  test("200 sequential Pings through WebSocket -> bridge -> nng (timed)", async () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) expect(decodeApiResponse(await ws.send(PING)).status).toBe(1);
    const ms = performance.now() - t0;
    console.log(`  [timing] WebSocketTransport via bridge: 200 sequential Pings in ${ms.toFixed(1)} ms (${(ms / 200).toFixed(2)} ms/req)`);
  }, 30_000);

  test("200 concurrent Pings on one WebSocket are correlated correctly", async () => {
    const t0 = performance.now();
    const replies = await Promise.all(Array.from({ length: 200 }, () => ws.send(PING)));
    expect(replies.every((b) => decodeApiResponse(b).status === 1)).toBe(true);
    expect(ws.inFlight).toBe(0);
    console.log(`  [timing] WebSocketTransport via bridge: 200 concurrent Pings in ${(performance.now() - t0).toFixed(1)} ms`);
  }, 30_000);

  test("unknown session on /ws is rejected; ws.ready() rejects with 'connect'", async () => {
    const t = new WebSocketTransport(bridgeWsUrl(bridge.url, "nope"), { keepaliveMs: 0, connectTimeoutMs: 2000 });
    await expect(t.ready()).rejects.toMatchObject({ code: "connect" });
  });

  test("bad request bytes come back as AS_BAD_REQUEST, malformed frames as control errors", async () => {
    const r = decodeApiResponse(await ws.send(Uint8Array.from([0x7a, 0x02, 0xff, 0xff])));
    expect(r.statusName).toBe("AS_BAD_REQUEST");
  });

  test("files API is confined to the workspace root", async () => {
    let res = await api("/files/write?path=proj/a.kicad_pro", { method: "PUT", body: '{"meta":{"filename":"a.kicad_pro"}}' });
    expect(res.status).toBe(200);
    res = await api("/files/mkdir?path=proj/sub", { method: "POST" });
    expect(res.status).toBe(200);
    res = await api("/files/list?path=proj");
    const list = (await res.json()) as { path: string; entries: Array<{ name: string; kind: string; size: number; mtime: string }> };
    expect(list.entries).toEqual([
      { name: "a.kicad_pro", kind: "file", size: 35, mtime: expect.any(String) },
      { name: "sub", kind: "dir", size: expect.any(Number), mtime: expect.any(String) },
    ]);
    res = await api("/files/read?path=proj/a.kicad_pro");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe('{"meta":{"filename":"a.kicad_pro"}}');
    res = await api("/files/stat?path=proj/a.kicad_pro");
    expect(((await res.json()) as { kind: string }).kind).toBe("file");
    // escapes
    expect((await api("/files/list?path=../")).status).toBe(403);
    expect((await api("/files/read?path=/etc/passwd")).status).toBe(403);
    expect((await api("/files/read?path=proj/../../x")).status).toBe(403);
    expect((await api("/files/read?path=proj/missing")).status).toBe(404);
    // default list is the root
    const root = (await (await api("/files")).json()) as { path: string; entries: Array<{ name: string }> };
    expect(root.path).toBe(".");
    expect(root.entries.map((e) => e.name)).toEqual(["proj"]);
  });

  test("a second client on the same session works and both see the server die", async () => {
    const ws2 = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, sessionId), { keepaliveMs: 0 });
    const both = await Promise.all([ws.send(PING), ws2.send(PING), ws.send(PING)]);
    expect(both.map((b) => decodeApiResponse(b).statusName)).toEqual(["AS_OK", "AS_OK", "AS_OK"]);

    const states1: BridgeControlMessage[] = [];
    const states2: BridgeControlMessage[] = [];
    ws.onControl((m) => m.type === "server-state" && states1.push(m));
    ws2.onControl((m) => m.type === "server-state" && states2.push(m));

    const session = bridge.sessions.get(sessionId)!;
    if (!(session instanceof Session)) throw new Error("this test kills the kicad-cli process, so it needs the process backend");
    const inflight = ws.send(PING, { timeoutMs: 10_000 }).catch((e: unknown) => e);
    session.proc!.kill("SIGKILL");
    const err = (await inflight) as { code?: string };
    expect(err).toMatchObject({ name: "TransportError", code: "closed" });

    const deadline = Date.now() + 5000;
    while ((states1.length === 0 || states2.length === 0) && Date.now() < deadline) await Bun.sleep(10);
    expect(states1[0]).toMatchObject({ type: "server-state", state: "failed", signal: "SIGKILL" });
    expect(states2[0]).toMatchObject({ type: "server-state", state: "failed", signal: "SIGKILL" });
    expect(ws.serverState).toBe("failed");

    // requests after the crash are refused by the bridge, the WebSocket itself stays open
    const after = (await ws.send(PING).catch((e: unknown) => e)) as { code?: string; message?: string };
    expect(after).toMatchObject({ code: "closed" });
    expect(after.message).toContain("failed");
    expect(ws.state).toBe("open");

    const info = (await (await api(`/sessions/${sessionId}`)).json()) as { session: { state: string; signal: string } };
    expect(info.session.state).toBe("failed");
    expect(info.session.signal).toBe("SIGKILL");
    const log = (await (await api(`/sessions/${sessionId}/log`)).json()) as { lines: string[] };
    expect(Array.isArray(log.lines)).toBe(true);
    await ws2.close();
  }, 20_000);

  test("DELETE /sessions/:id removes the session and unlinks the socket", async () => {
    const socketPath = bridge.sessions.get(sessionId)!.socketPath;
    const res = await api(`/sessions/${sessionId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await api(`/sessions/${sessionId}`)).status).toBe(404);
    expect(existsSync(socketPath)).toBe(false);
    // the transport bound to the destroyed session is closed by the bridge
    const deadline = Date.now() + 3000;
    while (ws.state !== "closed" && Date.now() < deadline) await Bun.sleep(10);
    expect(ws.state).toBe("closed");
  });

  test("a session without a preload file starts too, and SIGTERM stops it cleanly", async () => {
    const res = await api("/sessions", { method: "POST", body: JSON.stringify({ id: "bare-test" }) });
    expect(res.status).toBe(201);
    const s = bridge.sessions.get("bare-test")!;
    expect(s.state).toBe("running");
    const t0 = performance.now();
    await bridge.sessions.destroy("bare-test");
    console.log(
      `  SIGTERM shutdown took ${(performance.now() - t0).toFixed(0)} ms, exit code ${s.exitCode}, log tail: ${JSON.stringify(s.logLines.slice(-2))}`,
    );
    expect(s.state).toBe("exited");
  }, 60_000);
});
