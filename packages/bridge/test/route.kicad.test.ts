/**
 * Integration: the autorouting job against a real `kicad-cli api-server` spawned by the bridge —
 * the JS router on the unrouted ecc83 fixture through `POST /sessions/:id/route`, progress over
 * SSE, the result on the board (GetUnroutedCount drops to 0, one undo entry), and a Freerouting
 * job cancelled mid-run (java killed, board untouched) when the jar and Java are present.
 * Skipped with a message when kicad-cli is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KiCad } from "@kicad-web/client";
import { WebSocketTransport, bridgeWsUrl } from "@kicad-web/client/transport";
import type { RouteJobInfo } from "@kicad-web/router/bridge-job";
import { configFromEnv, startBridge, type BridgeServer } from "../src/index";

const cfg = configFromEnv(process.env, { port: 0, log: () => {} });
const haveKicad = existsSync(cfg.kicadCli);
const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "e2e", "fixtures", "boards", "ecc83");

if (!haveKicad) console.log(`[skip] kicad-cli not found at ${cfg.kicadCli} (set KICAD_CLI to run the route job integration test)`);

describe.skipIf(!haveKicad)("route jobs + kicad-cli api-server", () => {
  let bridge: BridgeServer;
  let workspace: string;
  let sessionId: string;
  let kicad: KiCad;
  let ws: WebSocketTransport;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "kicad-web-route-kicad-"));
    cpSync(FIXTURE, join(workspace, "ecc83"), { recursive: true });
    bridge = await startBridge({ ...cfg, workspaceRoot: workspace });
    const res = await fetch(`${bridge.url}/sessions`, {
      method: "POST",
      body: JSON.stringify({ path: join(workspace, "ecc83", "ecc83-pp.unrouted.kicad_pcb") }),
    });
    expect(res.status).toBe(201);
    sessionId = ((await res.json()) as { session: { id: string } }).session.id;
    ws = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, sessionId));
    kicad = await KiCad.connect(ws, { clientName: "kicad-web/route-test" });
  }, 90_000);

  afterAll(async () => {
    await ws?.close();
    await bridge?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  const api = (path: string, init?: RequestInit) => fetch(`${bridge.url}${path}`, init);

  /** Reads the SSE stream of a job until its terminal event. */
  async function follow(jobId: string, onEvent?: (ev: string, data: RouteJobInfo & { state: string }) => void): Promise<RouteJobInfo> {
    const res = await api(`/sessions/${sessionId}/route/${jobId}`, { headers: { accept: "text/event-stream" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    let last: RouteJobInfo | undefined;
    for (const block of text.split("\n\n")) {
      const ev = /^event: (\S+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const parsed = JSON.parse(data) as RouteJobInfo & { state: string };
      onEvent?.(ev, parsed);
      if (ev === "done" || ev === "error" || ev === "state") last = parsed;
    }
    if (!last) throw new Error(`no terminal event in:\n${text}`);
    return last;
  }

  test("JS router routes ecc83 through the job and the board shows it", async () => {
    const board = (await kicad.currentBoard())!;
    // 20 airlines on the raw file; the job's RefillZones brings the pour-connected pads down to 14
    expect((await board.unroutedCount()).unroutedCount).toBe(20);
    const res = await api(`/sessions/${sessionId}/route`, {
      method: "POST",
      body: JSON.stringify({ router: "js", options: { maxTimeMs: 60_000 } }),
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: RouteJobInfo };
    const states: string[] = [];
    const done = await follow(job.id, (ev, d) => states.push(`${ev}:${d.state}`));
    expect(done.state).toBe("done");
    expect(done.summary).toMatchObject({ routed: 14, total: 14, timedOut: false, unrouted: [] });
    expect(done.summary!.tracks).toBeGreaterThan(0);
    expect(done.summary!.trackLengthNm).toBeGreaterThan(0);
    expect(done.summary!.message).toBe("Autoroute (js): 14 connections");
    expect(states.some((s) => s.startsWith("progress:routing"))).toBe(true);
    const after = await board.unroutedCount();
    expect(after.unroutedCount).toBe(0);
    const polled = (await (await api(`/sessions/${sessionId}/route/${job.id}`)).json()) as { job: RouteJobInfo };
    expect(polled.job.state).toBe("done");
    const list = (await (await api(`/sessions/${sessionId}/route`)).json()) as { jobs: RouteJobInfo[] };
    expect(list.jobs.map((j) => j.id)).toContain(job.id);
    // one undo entry for the whole pass
    const stack = await board.undoStack();
    expect(stack.undo[stack.undo.length - 1]?.description).toBe("Autoroute (js): 14 connections");
    await board.undo();
    expect((await board.unroutedCount()).unroutedCount).toBe(14);
  }, 180_000);

  test.skipIf(!cfg.freerouting.ok)(
    "a Freerouting job can be cancelled: java is killed and nothing is applied",
    async () => {
      const board = (await kicad.currentBoard())!;
      const before = await board.unroutedCount();
      const res = await api(`/sessions/${sessionId}/route`, {
        method: "POST",
        body: JSON.stringify({ router: "freerouting", freerouting: { passes: 100 } }),
      });
      expect(res.status).toBe(202);
      const { job } = (await res.json()) as { job: RouteJobInfo };
      // cancel as soon as the router is running (the JVM takes a second or two to start)
      const deadline = Date.now() + 60_000;
      for (;;) {
        const j = ((await (await api(`/sessions/${sessionId}/route/${job.id}`)).json()) as { job: RouteJobInfo }).job;
        if (j.state === "routing" || j.state === "done" || j.state === "failed") break;
        if (Date.now() > deadline) throw new Error(`job stuck in ${j.state}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const del = await api(`/sessions/${sessionId}/route/${job.id}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      const t0 = Date.now();
      const done = await bridge.routeJobs.wait(job.id);
      expect(done.state).toBe("cancelled");
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect((await board.unroutedCount()).unroutedCount).toBe(before.unroutedCount);
      // no stray java for our DSN
      const ps = Bun.spawnSync(["pgrep", "-f", "kicad-web-freerouting-"]);
      expect(ps.stdout.toString().trim()).toBe("");
    },
    120_000,
  );
});

describe.skipIf(!haveKicad || !cfg.freerouting.ok)("Freerouting job (kicad-dsn mode) + kicad-cli api-server", () => {
  let bridge: BridgeServer;
  let workspace: string;
  let sessionId: string;
  let kicad: KiCad;
  let ws: WebSocketTransport;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "kicad-web-route-fr-"));
    cpSync(FIXTURE, join(workspace, "ecc83"), { recursive: true });
    bridge = await startBridge({ ...cfg, workspaceRoot: workspace });
    const res = await fetch(`${bridge.url}/sessions`, {
      method: "POST",
      body: JSON.stringify({ path: join(workspace, "ecc83", "ecc83-pp.unrouted.kicad_pcb") }),
    });
    sessionId = ((await res.json()) as { session: { id: string } }).session.id;
    ws = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, sessionId));
    kicad = await KiCad.connect(ws, { clientName: "kicad-web/route-test-fr" });
  }, 90_000);

  afterAll(async () => {
    await ws?.close();
    await bridge?.stop();
    await rm(workspace, { recursive: true, force: true });
  });

  test("routes ecc83 with KiCad's DSN and our own commit message", async () => {
    const board = (await kicad.currentBoard())!;
    const res = await fetch(`${bridge.url}/sessions/${sessionId}/route`, {
      method: "POST",
      body: JSON.stringify({ router: "freerouting", freerouting: { passes: 10 } }),
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: RouteJobInfo };
    const done = await bridge.routeJobs.wait(job.id);
    expect(done.state).toBe("done");
    expect(done.router).toBe("freerouting-kicad-dsn");
    expect(done.summary!.total).toBe(14);
    expect(done.summary!.routed).toBeGreaterThanOrEqual(12);
    expect(done.summary!.tracks).toBeGreaterThan(0);
    expect(done.summary!.message).toBe(`Autoroute (freerouting): ${done.summary!.routed} connections`);
    expect((await board.unroutedCount()).unroutedCount).toBe(14 - done.summary!.routed);
    const stack = await board.undoStack();
    expect(stack.undo[stack.undo.length - 1]?.description).toBe(done.summary!.message);
    await board.undo();
    expect((await board.unroutedCount()).unroutedCount).toBe(14);
  }, 180_000);
});
