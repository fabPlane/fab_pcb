/**
 * The compile job without a KiCad binary: path matching, request checks and refusals, and the
 * state machine on a session that has no transport. The run against kicad-cli is
 * `packages/bridge/test/compile.kicad.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { checkRequest, createCompileJobs, matchCompileJobPath } from "../src/bridge-job";

const SOURCE = { kind: "netlist-json", files: { "circuit.netlist.json": "{}" }, entrypoint: "circuit.netlist.json" };

describe("matchCompileJobPath", () => {
  test("session and job ids, decoded", () => {
    expect(matchCompileJobPath("/sessions/abc/compile")).toEqual({ sessionId: "abc", jobId: undefined });
    expect(matchCompileJobPath("/sessions/a%20b/compile/j1")).toEqual({ sessionId: "a b", jobId: "j1" });
    expect(matchCompileJobPath("/sessions/abc/route")).toBeUndefined();
    expect(matchCompileJobPath("/sessions/abc/compile/j1/x")).toBeUndefined();
  });
});

describe("checkRequest", () => {
  const kinds = ["netlist-json"];
  test("accepts a well-formed request", () => {
    expect(checkRequest({ source: SOURCE, project: { path: "/p/x.kicad_pro" } }, kinds)).toMatchObject({ ok: true });
  });
  test("names what is wrong", () => {
    const err = (body: unknown) => (checkRequest(body, kinds) as { error: string }).error;
    expect(err({})).toContain("source is required");
    expect(err({ source: { files: {}, entrypoint: "x" } })).toContain("source.kind");
    expect(err({ source: { ...SOURCE, kind: "tsx" } })).toContain('unknown frontend "tsx"');
    expect(err({ source: { ...SOURCE, files: [] } })).toContain("source.files");
    expect(err({ source: { ...SOURCE, entrypoint: "" } })).toContain("source.entrypoint");
    expect(err({ source: SOURCE, project: { path: 3 } })).toContain("project.path");
  });
});

describe("compile jobs without KiCad", () => {
  test("handle(): bad body, bad request, session without a server, methods, listing", async () => {
    const jobs = createCompileJobs();
    const session = { id: "s1", transport: null };
    const post = (body: string) => jobs.handle(new Request("http://x/sessions/s1/compile", { method: "POST", body }), session);
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ source: { ...SOURCE, kind: "nope" } }))).status).toBe(400);
    expect((await post(JSON.stringify({ source: SOURCE }))).status).toBe(409);
    expect((await jobs.handle(new Request("http://x/sessions/s1/compile", { method: "PUT" }), session)).status).toBe(405);
    const list = await jobs.handle(new Request("http://x/sessions/s1/compile"), session);
    expect((await list.json()) as unknown).toEqual({ jobs: [], frontends: ["netlist-json"] });
    expect((await jobs.handle(new Request("http://x/sessions/s1/compile/zz"), session, "zz")).status).toBe(404);
    const pre = await jobs.handle(new Request("http://x/sessions/s1/compile", { method: "OPTIONS" }), session);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("a job on a session without a transport fails, streams state, and is listed per session", async () => {
    const jobs = createCompileJobs();
    const info = jobs.start({ id: "s1", transport: null }, { source: SOURCE });
    const done = await jobs.wait(info.id);
    expect(done.state).toBe("failed");
    expect(done.error).toContain("no KiCad transport");
    expect(done.result).toBeUndefined();
    expect(jobs.list("s1").map((j) => j.id)).toEqual([info.id]);
    expect(jobs.list("other")).toEqual([]);
    expect((await jobs.handle(new Request("http://x/sessions/s2/compile/" + info.id), { id: "s2", transport: null }, info.id)).status).toBe(
      404,
    );
    const sse = await jobs.handle(
      new Request(`http://x/sessions/s1/compile/${info.id}`, { headers: { accept: "text/event-stream" } }),
      { id: "s1", transport: null },
      info.id,
    );
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const text = await sse.text();
    expect(text).toMatch(/^event: state\ndata: /);
    expect(JSON.parse(text.split("\n")[1]!.slice("data: ".length))).toMatchObject({ id: info.id, state: "failed" });
    const del = await jobs.handle(
      new Request(`http://x/sessions/s1/compile/${info.id}`, { method: "DELETE" }),
      { id: "s1", transport: null },
      info.id,
    );
    expect(((await del.json()) as { job: { state: string } }).job.state).toBe("failed");
    expect(jobs.cancel("nope")).toBe(false);
  });
});
