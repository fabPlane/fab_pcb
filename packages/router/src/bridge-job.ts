/**
 * A routing job the bridge can mount: `POST /sessions/:id/route` starts a run on the session's
 * KiCad, `GET /sessions/:id/route/:job` polls it (or streams progress over SSE with
 * `Accept: text/event-stream`), `DELETE` cancels. Nothing here imports the bridge — the bridge
 * imports this and calls `jobs.handle(...)` from its `fetch` handler:
 *
 *   const jobs = createRouteJobs({ freerouting: resolveFreerouting(process.env) });
 *   // in fetch(): const m = matchRouteJobPath(path); if (m) return jobs.handle(req, { id, transport }, m.jobId);
 *
 * The HTTP contract (JSON unless noted):
 *
 *   POST   /sessions/:id/route            body RouteJobRequest        -> 202 { job: RouteJobInfo }  (400 when the requested router is missing)
 *                                          the capacity router currently refuses prefab free-via boards
 *   GET    /sessions/:id/route            -> { jobs: RouteJobInfo[], capacityRouter, jsAutorouter, freerouting }
 *   GET    /sessions/:id/route/:job       -> { job: RouteJobInfo }   (SSE: `event: state`, `progress`, `done`, `error`, `: keepalive` every 15 s)
 *   DELETE /sessions/:id/route/:job       -> { ok, job }             (fab_router: cooperative signal; Freerouting: kills java)
 *
 * The job refills the zones (unless `refillZones: false`), saves the board (`SaveDocument`, so
 * KiCad's exporter reads the current state), runs `extractRouteInput` -> router.route ->
 * `applyRouteResult` (one commit, message "Autoroute (<router>): <n> connections"), then saves
 * again so the routed board is durable on disk. The browser only has to pick up the
 * `DocumentChanged` event as usual. Cancelling before the apply leaves the board untouched; a
 * failed router run (a fab_router error, a Freerouting crash) applies nothing and reports the
 * error. A failure of the final save reports the job as failed but leaves the applied route in
 * KiCad memory, where the caller can retry saving it.
 */
import { Arc, KiCad, KiCadClient, Track, Via, type Transport } from "@fp-pcb/client";
import { DrcErrorType } from "@fp-pcb/proto";
import { applyRouteResult } from "./apply";
import { extractRouteInput } from "./extract";
import { FreeroutingRouter, alreadyApplied, resolveFreerouting, type FreeroutingOptions, type FreeroutingPaths } from "./freerouting";
import { FabRouter } from "./fab-router";
import { JsAutorouter } from "./js-autorouter";
import { RouteCancelled, type Autorouter, type RouteConnection, type RouteOptions, type RouteProgress, type RouteResult } from "./types";

export type RouteJobState = "queued" | "saving" | "filling" | "extracting" | "routing" | "applying" | "done" | "failed" | "cancelled";

export interface RouteJobRequest {
  /** `"js"` or `"freerouting"`. */
  router: "js" | "freerouting";
  options?: Omit<RouteOptions, "signal">;
  /** Freerouting only. Default mode: `kicad-dsn` (KiCad's exporter, our own commit). */
  freerouting?: Pick<FreeroutingOptions, "mode" | "passes" | "jvmArgs" | "extraArgs">;
  /** Commit message; default `Autoroute (<router>): <routed> connections`. */
  message?: string;
  /**
   * `RefillZones` before extracting (default true), so pads a copper pour already connects are not
   * in the ratsnest the router gets. Not repeated after the apply: that would be a second undo
   * entry, and DRC wants the fill anyway (the app's "Refill + DRC" button does both).
   */
  refillZones?: boolean;
}

/** An unrouted connection as reported to the browser (positions in nm). */
export interface RouteJobUnrouted {
  net: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface RouteJobSummary {
  tracks: number;
  /** Vias the router added. */
  vias: number;
  /** Free vias (on no net before the run) the routing claimed; see `RouteOptions.preset`. */
  claimedVias: number;
  /** Solver preset the JS router used (`default` or `laser-prefab`). */
  preset?: string;
  /**
   * Connections routed as KiCad sees it after the apply: `total` minus the airlines `GetRatsnest`
   * still reports (the router's own count, `routerRouted`, calls a net routed as soon as it got a
   * wire, which overstates on multi-pad nets).
   */
  routed: number;
  routerRouted: number;
  total: number;
  /** Sum of the created tracks' lengths, nm (0 when KiCad's importer created them). */
  trackLengthNm: number;
  elapsedMs: number;
  /** Whole job, saving and applying included. */
  wallMs: number;
  timedOut: boolean;
  /** The commit message used (empty when nothing was applied). */
  message: string;
  /** The airlines left after the apply (`GetRatsnest`, filtered to the requested nets). */
  unrouted: RouteJobUnrouted[];
  /** Copper added or claimed by this run, in nm, for clients such as Route Cinema. */
  geometry: RouteJobGeometry[];
  log: string[];
}

export interface RouteJobGeometry {
  kind: "trace" | "via";
  /** KiCad KIID; stable across progress consumers and later board queries. */
  id: string;
  /** KiCad BoardLayer enum. Through vias use -1. */
  layer: number;
  net: number;
  /** Trace centreline points, or a via bounding box. */
  points: number[];
  /** Trace width in nm. */
  width?: number;
}

export interface RouteJobInfo {
  id: string;
  sessionId: string;
  router: string;
  state: RouteJobState;
  startedAt: string;
  finishedAt?: string;
  progress?: RouteProgress;
  /** Tail of the router's output (last `LOG_TAIL` lines) while it runs. */
  log: string[];
  /** Set when `state` is `done`. */
  summary?: RouteJobSummary;
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

const LOG_TAIL = 40;
const MAX_UNROUTED = 2000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

interface Job {
  info: RouteJobInfo;
  listeners: Set<(ev: string, data: unknown) => void>;
  abort: AbortController;
}

export interface RouteJobs {
  /** Routes a request whose path is `/sessions/:id/route[/:job]`. */
  handle(req: Request, session: RouteJobSession, jobId?: string): Promise<Response>;
  /** Starts a job outside HTTP (tests, CLI). */
  start(session: RouteJobSession, request: RouteJobRequest): RouteJobInfo;
  get(id: string): RouteJobInfo | undefined;
  list(sessionId?: string): RouteJobInfo[];
  cancel(id: string): boolean;
  /** Resolves when the job has finished (done, failed or cancelled). */
  wait(id: string): Promise<RouteJobInfo>;
  /** Jar / Java the Freerouting jobs will use. */
  readonly freerouting: FreeroutingPaths;
  /** Legacy readiness alias retained for older bridge clients. */
  jsAutorouter(): Promise<{ ok: boolean; reason?: string }>;
  /** The selected implementation behind the stable `router: "js"` capacity slot. */
  capacityRouter(): Promise<{ name: string; ok: boolean; reason?: string }>;
}

export interface RouteJobDeps {
  /** Replaces the router choice (tests). */
  routers?: (req: RouteJobRequest, kicad: KiCad, board: Awaited<ReturnType<KiCad["currentBoard"]>>) => Autorouter;
  /** Jar and Java for Freerouting; default `resolveFreerouting(process.env)`. */
  freerouting?: FreeroutingPaths;
  /** Legacy dependency injection retained for existing tests and embedded hosts. */
  jsAutorouter?: JsAutorouter;
  /** Replaces the selected capacity router (tests and embedded hosts). */
  capacityRouter?: Autorouter;
  log?: (message: string) => void;
}

export function unroutedOf(result: Pick<RouteResult, "unrouted">): RouteJobUnrouted[] {
  return result.unrouted.slice(0, MAX_UNROUTED).map((c: RouteConnection) => ({
    net: c.net,
    from: { x: c.from.position.x, y: c.from.position.y },
    to: { x: c.to.position.x, y: c.to.position.y },
  }));
}

export function trackLength(result: Pick<RouteResult, "tracks">): number {
  let sum = 0;
  for (const t of result.tracks) sum += Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
  return Math.round(sum);
}

/** Remove created tracks/vias named by a DRC marker after undoing their tentative commit. */
export function withoutRejectedCreatedCopper(
  result: RouteResult,
  created: readonly (Track | Arc | Via)[],
  rejectedIds: ReadonlySet<string>,
): RouteResult {
  let createdIndex = 0;
  const tracks = result.tracks.filter((track) => {
    if (Math.round(track.start.x) === Math.round(track.end.x) && Math.round(track.start.y) === Math.round(track.end.y)) return false;
    return !rejectedIds.has(created[createdIndex++]?.id ?? "");
  });
  const vias = result.vias.filter(() => !rejectedIds.has(created[createdIndex++]?.id ?? ""));
  return {
    ...result,
    tracks,
    vias,
  };
}

/** Compact, renderer-neutral copper geometry for a completed routing run. */
export function routeGeometry(items: readonly (Track | Arc | Via)[]): RouteJobGeometry[] {
  return items.map((item) => {
    if (item instanceof Via) {
      const r = item.diameter / 2;
      return {
        kind: "via",
        id: item.id,
        layer: -1,
        net: item.netCode ?? 0,
        points: [item.position.x - r, item.position.y - r, item.position.x + r, item.position.y + r],
      };
    }
    const points =
      item instanceof Arc
        ? [item.start.x, item.start.y, item.mid.x, item.mid.y, item.end.x, item.end.y]
        : [item.start.x, item.start.y, item.end.x, item.end.y];
    return { kind: "trace", id: item.id, layer: item.layerId, net: item.netCode ?? 0, points, width: item.width };
  });
}

/**
 * A run that routed nothing is reported as failed, with the router's own reason: a router's
 * retries swallow its precheck errors into `log` and hand back an empty result, and a killed
 * Freerouting writes no session. Null when something was routed or there was nothing to route.
 */
export function emptyResultReason(
  r: Pick<RouteResult, "totalConnections" | "tracks" | "vias" | "unrouted" | "timedOut" | "log">,
): string | null {
  if (r.totalConnections === 0 || r.tracks.length || r.vias.length || r.unrouted.length < r.totalConnections) return null;
  const why = [...r.log].reverse().find((l) => /solver failed|precheck|timed out|exited with|no session|ran out of/i.test(l));
  if (r.timedOut) return `timed out with nothing routed${why ? ` (${why})` : ""}`;
  return why ? `the router routed nothing: ${why}` : "the router returned no tracks or vias";
}

/** The commit message for a finished run; what the History panel shows. */
export function autorouteMessage(router: "js" | "freerouting", routed: number): string {
  return `Autoroute (${router}): ${routed} connection${routed === 1 ? "" : "s"}`;
}

/** Persist a route that has already been committed to KiCad's in-memory board. */
export async function persistAppliedRoute(board: { save(): Promise<void> }): Promise<void> {
  try {
    await board.save();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`route was applied in KiCad memory but SaveDocument failed; retry saving before closing the session: ${detail}`, {
      cause: e,
    });
  }
}

export function createRouteJobs(deps: RouteJobDeps = {}): RouteJobs {
  const jobs = new Map<string, Job>();
  const freerouting = deps.freerouting ?? resolveFreerouting();
  const configuredCapacity = typeof process === "undefined" ? undefined : process.env.FP_PCB_CAPACITY_ROUTER;
  if (configuredCapacity && configuredCapacity !== "fab-router" && configuredCapacity !== "js-autorouter") {
    throw new Error(`FP_PCB_CAPACITY_ROUTER must be "fab-router" or "js-autorouter", got ${JSON.stringify(configuredCapacity)}`);
  }
  const capacityRouter: Autorouter =
    deps.capacityRouter ?? deps.jsAutorouter ?? (configuredCapacity === "js-autorouter" ? new JsAutorouter() : new FabRouter());
  const log = deps.log ?? (() => {});

  const emit = (job: Job, ev: string, data: unknown) => {
    for (const l of [...job.listeners]) l(ev, data);
  };
  const finished = (s: RouteJobState) => s === "done" || s === "failed" || s === "cancelled";

  const start = (session: RouteJobSession, request: RouteJobRequest): RouteJobInfo => {
    const id = crypto.randomUUID().slice(0, 8);
    const info: RouteJobInfo = {
      id,
      sessionId: session.id,
      router: request.router,
      state: "queued",
      startedAt: new Date().toISOString(),
      log: [],
    };
    const abort = new AbortController();
    const job: Job = { info, listeners: new Set(), abort };
    jobs.set(id, job);
    const t0 = performance.now();
    const setState = (state: RouteJobState) => {
      info.state = state;
      emit(job, "progress", { state, progress: info.progress, log: info.log });
    };
    const pushLog = (line: string) => {
      info.log.push(line);
      if (info.log.length > LOG_TAIL) info.log.splice(0, info.log.length - LOG_TAIL);
    };
    const checkCancelled = () => {
      if (abort.signal.aborted) throw new RouteCancelled();
    };
    log(`route job ${id}: ${request.router} on session ${session.id}`);

    void (async () => {
      try {
        if (!session.transport) throw new Error("session has no KiCad transport");
        if (request.router === "freerouting" && !freerouting.ok) throw new Error(`Freerouting unavailable: ${freerouting.reason}`);
        const client = new KiCadClient(session.transport, { clientName: session.clientName ?? `fp-pcb/router-job-${id}` });
        const kicad = new KiCad(client);
        const board = await kicad.currentBoard();
        if (!board) throw new Error("no board open in this session");
        checkCancelled();
        if (request.refillZones ?? true) {
          setState("filling");
          await board.refillZones();
          checkCancelled();
        }
        setState("saving");
        await board.save();
        checkCancelled();
        setState("extracting");
        const copperBefore = new Set((await board.getTracks()).map((item) => item.id));
        const input = await extractRouteInput(board, { nets: request.options?.nets, warn: pushLog });
        pushLog(`extract: ${input.pads.length} pads, ${input.connections.length} connections, ${input.copperLayers.length} copper layers`);
        checkCancelled();
        const router: Autorouter =
          deps.routers?.(request, kicad, board) ??
          (request.router === "freerouting"
            ? new FreeroutingRouter(
                { board },
                {
                  mode: "kicad-dsn",
                  jar: freerouting.jar,
                  java: freerouting.java,
                  ...(freerouting.kicadCli ? { kicadCli: freerouting.kicadCli } : {}),
                  ...request.freerouting,
                },
              )
            : capacityRouter);
        info.router = router.name;
        setState("routing");
        let result: RouteResult = await router.route(input, { ...request.options, signal: abort.signal }, (p) => {
          info.progress = p;
          if (p.message) pushLog(`${p.phase}: ${p.message}`);
          else if (p.phase && p.phase !== info.log[info.log.length - 1]) pushLog(p.phase);
          emit(job, "progress", { state: info.state, progress: p, log: info.log });
        });
        checkCancelled();
        const empty = emptyResultReason(result);
        if (empty) {
          info.log = result.log.slice(-LOG_TAIL);
          throw new Error(empty);
        }
        const routed = result.totalConnections - result.unrouted.length;
        let message = request.message ?? autorouteMessage(request.router, routed);
        setState("applying");
        let applied = false;
        if (!alreadyApplied(result) && (result.tracks.length || result.vias.length || result.claimedVias?.length)) {
          const maxCleanupPasses = Math.min(20, result.tracks.length + result.vias.length + 1);
          for (let cleanupPass = 0; cleanupPass < maxCleanupPasses; cleanupPass++) {
            const committed = await applyRouteResult(board, result, { message });
            if (result.router !== "fab-router") {
              applied = true;
              break;
            }
            const createdIds = new Set(committed.created.map((item) => item.id));
            const drc = await board.drc.run({ refillZones: false });
            const rejectedIds = new Set(
              drc.markers
                .filter(
                  (marker) =>
                    marker.errorType === DrcErrorType.DRCET_DANGLING_TRACK || marker.errorType === DrcErrorType.DRCET_DANGLING_VIA,
                )
                .flatMap((marker) => marker.items.map((item) => item.value))
                .filter((id) => createdIds.has(id)),
            );
            if (!rejectedIds.size) {
              if (!request.message) {
                const nativeOpen = (await board.ratsnest(request.options?.nets ?? [])).edges.length;
                const nativeMessage = autorouteMessage(request.router, Math.max(0, result.totalConnections - nativeOpen));
                if (nativeMessage !== message) {
                  const undone = await board.undo(1);
                  if (undone.applied !== 1) throw new Error("could not relabel fab_router's tentative route commit");
                  message = nativeMessage;
                  await applyRouteResult(board, result, { message });
                }
              }
              applied = true;
              break;
            }
            const undone = await board.undo(1);
            if (undone.applied !== 1) throw new Error("could not undo fab_router's tentative dangling-copper commit");
            const before = result.tracks.length + result.vias.length;
            result = withoutRejectedCreatedCopper(result, committed.created as (Track | Arc | Via)[], rejectedIds);
            const removed = before - result.tracks.length - result.vias.length;
            result.log.push(
              `KiCad rejected ${removed} dangling fab_router item(s) before the durable commit (cleanup pass ${cleanupPass + 1})`,
            );
            if (!removed)
              throw new Error("KiCad identified dangling fab_router copper but it could not be mapped back to the route result");
            if (!result.tracks.length && !result.vias.length && !result.claimedVias?.length) break;
            if (cleanupPass + 1 === maxCleanupPasses) throw new Error("fab_router dangling-copper cleanup did not converge");
          }
        }
        const appliedByKicad = (result as RouteResult & { applied?: { tracksAdded: number; viasAdded: number } }).applied;
        if (applied || appliedByKicad) {
          setState("saving");
          await persistAppliedRoute(board);
        }
        // Re-measure with KiCad's connectivity: what is still an airline after the apply.
        let unrouted = unroutedOf(result);
        let measured = routed;
        try {
          const nets = new Set(request.options?.nets ?? []);
          const rats = await board.ratsnest(request.options?.nets ?? []);
          const edges = rats.edges.filter((e) => !nets.size || nets.has(e.net));
          unrouted = edges.slice(0, MAX_UNROUTED).map((e) => ({
            net: e.net,
            from: { x: e.sourcePosition.x, y: e.sourcePosition.y },
            to: { x: e.targetPosition.x, y: e.targetPosition.y },
          }));
          measured = Math.max(0, result.totalConnections - edges.length);
          if (measured !== routed)
            result.log.push(
              `GetRatsnest after the apply: ${edges.length} connection(s) still unrouted (the router counted ${result.unrouted.length})`,
            );
        } catch (e) {
          result.log.push(
            `GetRatsnest after the apply failed: ${e instanceof Error ? e.message : String(e)}; using the router's own count`,
          );
        }
        info.state = "done";
        info.finishedAt = new Date().toISOString();
        info.log = result.log.slice(-LOG_TAIL);
        const claimedIds = new Set(result.claimedVias?.map((via) => via.id) ?? []);
        const geometry = routeGeometry((await board.getTracks()).filter((item) => !copperBefore.has(item.id) || claimedIds.has(item.id)));
        info.summary = {
          tracks: appliedByKicad?.tracksAdded ?? result.tracks.length,
          vias: appliedByKicad?.viasAdded ?? result.vias.length,
          claimedVias: result.claimedVias?.length ?? 0,
          ...(result.preset ? { preset: result.preset } : {}),
          routed: measured,
          routerRouted: routed,
          total: result.totalConnections,
          trackLengthNm: trackLength(result),
          elapsedMs: result.elapsedMs,
          wallMs: Math.round(performance.now() - t0),
          timedOut: result.timedOut,
          message: applied || appliedByKicad ? message : "",
          unrouted,
          geometry,
          log: result.log,
        };
        log(`route job ${id}: done, ${measured}/${result.totalConnections} in ${info.summary.wallMs} ms`);
        emit(job, "done", info);
      } catch (e) {
        const cancelled = abort.signal.aborted || RouteCancelled.is(e);
        info.state = cancelled ? "cancelled" : "failed";
        info.finishedAt = new Date().toISOString();
        info.error = cancelled
          ? `cancelled${e instanceof Error && e.message !== "routing cancelled" ? `: ${e.message}` : ""}`
          : e instanceof Error
            ? e.message
            : String(e);
        log(`route job ${id}: ${info.state}: ${info.error}`);
        emit(job, "error", info);
      }
    })();
    return info;
  };

  const stream = (job: Job): Response => {
    const enc = new TextEncoder();
    let cleanup: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (ev: string, data: unknown) => {
          try {
            controller.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cleanup?.();
          }
        };
        send("state", job.info);
        if (finished(job.info.state)) {
          controller.close();
          return;
        }
        const listener = (ev: string, data: unknown) => {
          send(ev, data);
          if (ev === "done" || ev === "error") cleanup?.();
        };
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": keepalive\n\n"));
          } catch {
            cleanup?.();
          }
        }, 15_000);
        cleanup = () => {
          cleanup = undefined;
          clearInterval(keepalive);
          job.listeners.delete(listener);
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        job.listeners.add(listener);
      },
      cancel() {
        cleanup?.();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", ...CORS } });
  };

  const cancel = (id: string): boolean => {
    const j = jobs.get(id);
    if (!j) return false;
    if (!finished(j.info.state)) j.abort.abort();
    return true;
  };

  return {
    freerouting,
    jsAutorouter: () => capacityRouter.available?.() ?? Promise.resolve({ ok: true }),
    capacityRouter: async () => ({ name: capacityRouter.name, ...(await (capacityRouter.available?.() ?? Promise.resolve({ ok: true }))) }),
    start,
    get: (id) => jobs.get(id)?.info,
    list: (sessionId) => [...jobs.values()].map((j) => j.info).filter((i) => !sessionId || i.sessionId === sessionId),
    cancel,
    wait: (id) =>
      new Promise((resolve, reject) => {
        const j = jobs.get(id);
        if (!j) return reject(new Error(`unknown job "${id}"`));
        if (finished(j.info.state)) return resolve(j.info);
        const l = (ev: string) => {
          if (ev === "done" || ev === "error") {
            j.listeners.delete(l);
            resolve(j.info);
          }
        };
        j.listeners.add(l);
      }),
    async handle(req, session, jobId) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (!jobId) {
        if (req.method === "GET")
          return json({
            jobs: this.list(session.id),
            capacityRouter: await this.capacityRouter(),
            jsAutorouter: await this.jsAutorouter(),
            freerouting,
          });
        if (req.method === "POST") {
          let body: RouteJobRequest;
          try {
            body = (await req.json()) as RouteJobRequest;
          } catch {
            return json({ error: "body must be JSON" }, 400);
          }
          if (body.router !== "js" && body.router !== "freerouting") return json({ error: 'router must be "js" or "freerouting"' }, 400);
          if (body.router === "freerouting" && !freerouting.ok)
            return json({ error: `Freerouting unavailable: ${freerouting.reason}` }, 400);
          if (!session.transport) return json({ error: "session has no running KiCad" }, 409);
          if (body.router === "js") {
            const available = await this.capacityRouter();
            if (!available.ok) return json({ error: `${available.name} unavailable: ${available.reason}` }, 400);
          }
          return json({ job: start(session, body) }, 202);
        }
        return json({ error: "method not allowed" }, 405);
      }
      const job = jobs.get(jobId);
      if (!job || job.info.sessionId !== session.id) return json({ error: `unknown job "${jobId}"` }, 404);
      if (req.method === "GET") return req.headers.get("accept")?.includes("text/event-stream") ? stream(job) : json({ job: job.info });
      if (req.method === "DELETE") {
        cancel(jobId);
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
