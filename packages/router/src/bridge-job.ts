/**
 * A routing job the bridge can mount: `POST /sessions/:id/route` starts a run on the session's
 * KiCad, `GET /sessions/:id/route/:job` polls it (or streams progress over SSE with
 * `Accept: text/event-stream`), `DELETE` cancels. Nothing here imports the bridge — the bridge
 * imports this and calls `mountRouteJobs(sessions)` from its `fetch` handler:
 *
 *   const jobs = createRouteJobs();
 *   // in fetch(): if (path starts with /sessions/<id>/route)
 *   const res = await jobs.handle(req, { id, transport: session.transport });
 *
 * The HTTP contract (JSON unless noted):
 *
 *   POST   /sessions/:id/route            body RouteJobRequest        -> 202 { job: RouteJobInfo }
 *   GET    /sessions/:id/route            -> { jobs: RouteJobInfo[] }
 *   GET    /sessions/:id/route/:job       -> { job: RouteJobInfo }   (SSE: `event: progress`, `event: done`, `event: error`)
 *   DELETE /sessions/:id/route/:job       -> { ok, job }             (cancels; Freerouting gets SIGTERM)
 *
 * The job runs `extractRouteInput` -> router.route -> `applyRouteResult` against the session's
 * open board, so the browser only has to refresh (a `DocumentChanged` event arrives as usual).
 */
import { KiCad, KiCadClient, type Transport } from "@kicad-web/client";
import { applyRouteResult } from "./apply";
import { extractRouteInput } from "./extract";
import { FreeroutingRouter, alreadyApplied, type FreeroutingOptions } from "./freerouting";
import { JsRouter } from "./js-router";
import type { Autorouter, RouteOptions, RouteProgress, RouteResult } from "./types";

export type RouteJobState = "queued" | "extracting" | "routing" | "applying" | "done" | "failed" | "cancelled";

export interface RouteJobRequest {
  /** `"js"` or `"freerouting"`. */
  router: "js" | "freerouting";
  options?: RouteOptions;
  /** Freerouting only. */
  freerouting?: Pick<FreeroutingOptions, "mode" | "passes" | "jvmArgs" | "extraArgs">;
  /** Commit message. */
  message?: string;
}

export interface RouteJobInfo {
  id: string;
  sessionId: string;
  router: string;
  state: RouteJobState;
  startedAt: string;
  finishedAt?: string;
  progress?: RouteProgress;
  /** Set when `state` is `done`. */
  summary?: {
    tracks: number;
    vias: number;
    routed: number;
    total: number;
    elapsedMs: number;
    timedOut: boolean;
    log: string[];
  };
  error?: string;
}

export interface RouteJobSession {
  id: string;
  /** The session's transport to KiCad (the bridge's `Session.transport`). */
  transport: Transport | null;
  clientName?: string;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

interface Job {
  info: RouteJobInfo;
  listeners: Set<(ev: string, data: unknown) => void>;
  cancel: () => void;
}

export interface RouteJobs {
  /** Routes a request whose path is `/sessions/:id/route[/:job]`. */
  handle(req: Request, session: RouteJobSession, jobId?: string): Promise<Response>;
  /** Starts a job outside HTTP (tests, CLI). */
  start(session: RouteJobSession, request: RouteJobRequest): RouteJobInfo;
  get(id: string): RouteJobInfo | undefined;
  list(sessionId?: string): RouteJobInfo[];
  cancel(id: string): boolean;
}

export function createRouteJobs(
  deps: { routers?: (req: RouteJobRequest, kicad: KiCad, board: Awaited<ReturnType<KiCad["currentBoard"]>>) => Autorouter } = {},
): RouteJobs {
  const jobs = new Map<string, Job>();

  const emit = (job: Job, ev: string, data: unknown) => {
    for (const l of job.listeners) l(ev, data);
  };

  const start = (session: RouteJobSession, request: RouteJobRequest): RouteJobInfo => {
    const id = crypto.randomUUID().slice(0, 8);
    const info: RouteJobInfo = { id, sessionId: session.id, router: request.router, state: "queued", startedAt: new Date().toISOString() };
    let cancelled = false;
    const job: Job = { info, listeners: new Set(), cancel: () => (cancelled = true) };
    jobs.set(id, job);

    void (async () => {
      try {
        if (!session.transport) throw new Error("session has no KiCad transport");
        const client = new KiCadClient(session.transport, { clientName: session.clientName ?? `kicad-web/router-job-${id}` });
        const kicad = new KiCad(client);
        const board = await kicad.currentBoard();
        if (!board) throw new Error("no board open in this session");
        info.state = "extracting";
        emit(job, "progress", { state: info.state });
        const input = await extractRouteInput(board, { nets: request.options?.nets });
        if (cancelled) throw new Error("cancelled");
        const router: Autorouter =
          deps.routers?.(request, kicad, board) ??
          (request.router === "freerouting" ? new FreeroutingRouter({ board }, { ...request.freerouting }) : new JsRouter());
        info.router = router.name;
        info.state = "routing";
        const result: RouteResult = await router.route(input, request.options ?? {}, (p) => {
          info.progress = p;
          emit(job, "progress", { state: info.state, progress: p });
        });
        if (cancelled) throw new Error("cancelled");
        info.state = "applying";
        emit(job, "progress", { state: info.state });
        if (!alreadyApplied(result) && (result.tracks.length || result.vias.length))
          await applyRouteResult(board, result, { message: request.message });
        info.state = "done";
        info.finishedAt = new Date().toISOString();
        info.summary = {
          tracks: result.tracks.length,
          vias: result.vias.length,
          routed: result.totalConnections - result.unrouted.length,
          total: result.totalConnections,
          elapsedMs: result.elapsedMs,
          timedOut: result.timedOut,
          log: result.log,
        };
        emit(job, "done", info);
      } catch (e) {
        info.state = cancelled ? "cancelled" : "failed";
        info.finishedAt = new Date().toISOString();
        info.error = e instanceof Error ? e.message : String(e);
        emit(job, "error", info);
      }
    })();
    return info;
  };

  const stream = (job: Job): Response => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (ev: string, data: unknown) => controller.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
        send("state", job.info);
        if (job.info.state === "done" || job.info.state === "failed" || job.info.state === "cancelled") {
          controller.close();
          return;
        }
        const listener = (ev: string, data: unknown) => {
          send(ev, data);
          if (ev === "done" || ev === "error") {
            job.listeners.delete(listener);
            controller.close();
          }
        };
        job.listeners.add(listener);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS } });
  };

  return {
    start,
    get: (id) => jobs.get(id)?.info,
    list: (sessionId) => [...jobs.values()].map((j) => j.info).filter((i) => !sessionId || i.sessionId === sessionId),
    cancel: (id) => {
      const j = jobs.get(id);
      if (!j) return false;
      j.cancel();
      return true;
    },
    async handle(req, session, jobId) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (!jobId) {
        if (req.method === "GET") return json({ jobs: this.list(session.id) });
        if (req.method === "POST") {
          let body: RouteJobRequest;
          try {
            body = (await req.json()) as RouteJobRequest;
          } catch {
            return json({ error: "body must be JSON" }, 400);
          }
          if (body.router !== "js" && body.router !== "freerouting") return json({ error: 'router must be "js" or "freerouting"' }, 400);
          return json({ job: start(session, body) }, 202);
        }
        return json({ error: "method not allowed" }, 405);
      }
      const job = jobs.get(jobId);
      if (!job || job.info.sessionId !== session.id) return json({ error: `unknown job "${jobId}"` }, 404);
      if (req.method === "GET") return req.headers.get("accept")?.includes("text/event-stream") ? stream(job) : json({ job: job.info });
      if (req.method === "DELETE") {
        job.cancel();
        return json({ ok: true, job: job.info });
      }
      return json({ error: "method not allowed" }, 405);
    },
  };
}

/** Parses `/sessions/:id/route[/:job]`; undefined when the path is something else. */
export function matchRouteJobPath(pathname: string): { sessionId: string; jobId?: string } | undefined {
  const m = /^\/sessions\/([^/]+)\/route(?:\/([^/]+))?$/.exec(pathname);
  if (!m) return undefined;
  return { sessionId: decodeURIComponent(m[1]!), jobId: m[2] ? decodeURIComponent(m[2]) : undefined };
}
