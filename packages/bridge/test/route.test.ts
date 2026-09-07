/**
 * The autorouting job routes (`/sessions/:id/route`) without a KiCad binary: path matching, the
 * refusals (unknown session, bad router, Freerouting missing, session without a server), the
 * Freerouting env resolution reported in `/health`, and the job state machine on a session that
 * has no transport. The full run against kicad-cli is route.kicad.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouteJobs, matchRouteJobPath } from "@fp-pcb/router/bridge-job";
import { configFromEnv, startBridge, type BridgeServer } from "../src/index";

describe("matchRouteJobPath", () => {
  test("session and job ids, decoded", () => {
    expect(matchRouteJobPath("/sessions/abc/route")).toEqual({ sessionId: "abc", jobId: undefined });
    expect(matchRouteJobPath("/sessions/a%20b/route/j1")).toEqual({ sessionId: "a b", jobId: "j1" });
    expect(matchRouteJobPath("/sessions/abc")).toBeUndefined();
    expect(matchRouteJobPath("/sessions/abc/events")).toBeUndefined();
    expect(matchRouteJobPath("/sessions/abc/route/j1/x")).toBeUndefined();
  });
});

describe("configFromEnv: Freerouting paths", () => {
  test("FREEROUTING_JAR and FP_PCB_JAVA are honoured and a missing jar carries the fix", () => {
    const c = configFromEnv({ FREEROUTING_JAR: "/nonexistent/fr.jar", FP_PCB_JAVA: "/nonexistent/java" });
    expect(c.freerouting.ok).toBe(false);
    expect(c.freerouting.jar).toBe("/nonexistent/fr.jar");
    expect(c.freerouting.reason).toMatch(/fetch-freerouting\.ts --jdk|FREEROUTING_JAR/);
  });
});

describe("route jobs without KiCad", () => {
  let bridge: BridgeServer;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fp-pcb-route-"));
    bridge = await startBridge(
      configFromEnv(
        { FREEROUTING_JAR: "/nonexistent/fr.jar" },
        { port: 0, kicadCli: "/nonexistent/kicad-cli", workspaceRoot: dir, log: () => {} },
      ),
    );
  });
  afterAll(async () => {
    await bridge?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("/health reports the Freerouting paths", async () => {
    const h = (await (await fetch(`${bridge.url}/health`)).json()) as { freerouting: { ok: boolean; jar: string; reason?: string } };
    expect(h.freerouting.ok).toBe(false);
    expect(h.freerouting.jar).toBe("/nonexistent/fr.jar");
    expect(h.freerouting.reason).toContain("fetch-freerouting");
  });

  test("unknown session is a 404, on every method", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await fetch(`${bridge.url}/sessions/nope/route`, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${bridge.url}/sessions/nope/route/j1`)).status).toBe(404);
  });

  test("CORS preflight on the route path", async () => {
    const res = await fetch(`${bridge.url}/sessions/nope/route`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("handle(): bad body, bad router, Freerouting missing, session without a server", async () => {
    const jobs = createRouteJobs({ freerouting: { jar: "/nonexistent/fr.jar", java: undefined, ok: false, reason: "no jar" } });
    const session = { id: "s1", transport: null };
    const post = (body: string) => jobs.handle(new Request("http://x/sessions/s1/route", { method: "POST", body }), session);
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ router: "magic" }))).status).toBe(400);
    const fr = await post(JSON.stringify({ router: "freerouting" }));
    expect(fr.status).toBe(400);
    expect(((await fr.json()) as { error: string }).error).toContain("no jar");
    expect((await post(JSON.stringify({ router: "js" }))).status).toBe(409);
    expect((await jobs.handle(new Request("http://x/sessions/s1/route", { method: "PUT" }), session)).status).toBe(405);
    const list = await jobs.handle(new Request("http://x/sessions/s1/route"), session);
    expect((await list.json()) as unknown).toMatchObject({ jobs: [], freerouting: { ok: false } });
    expect((await jobs.handle(new Request("http://x/sessions/s1/route/zz"), session, "zz")).status).toBe(404);
  });

  test("a job on a session without a transport fails, streams state + error, and is listed per session", async () => {
    const jobs = createRouteJobs({ freerouting: { jar: "/nonexistent/fr.jar", java: undefined, ok: false, reason: "no jar" } });
    const info = jobs.start({ id: "s1", transport: null }, { router: "js" });
    const done = await jobs.wait(info.id);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("no KiCad transport");
    expect(jobs.list("s1").map((j) => j.id)).toEqual([info.id]);
    expect(jobs.list("other")).toEqual([]);
    // a job of another session is not reachable through that session
    const res = await jobs.handle(new Request("http://x/sessions/s2/route/" + info.id), { id: "s2", transport: null }, info.id);
    expect(res.status).toBe(404);
    // the SSE stream of a finished job: one `state` event, then it closes
    const sse = await jobs.handle(
      new Request(`http://x/sessions/s1/route/${info.id}`, { headers: { accept: "text/event-stream" } }),
      { id: "s1", transport: null },
      info.id,
    );
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const text = await sse.text();
    expect(text).toMatch(/^event: state\ndata: /);
    expect(JSON.parse(text.split("\n")[1]!.slice("data: ".length))).toMatchObject({ id: info.id, state: "failed" });
    // cancelling a finished job is a no-op that still answers
    const del = await jobs.handle(
      new Request(`http://x/sessions/s1/route/${info.id}`, { method: "DELETE" }),
      { id: "s1", transport: null },
      info.id,
    );
    expect(((await del.json()) as { job: { state: string } }).job.state).toBe("failed");
    expect(jobs.cancel("nope")).toBe(false);
  });
});
