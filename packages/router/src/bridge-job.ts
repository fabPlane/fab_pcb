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
 *   GET    /sessions/:id/route            -> { jobs: RouteJobInfo[], capacityRouter, freerouting }
 *   GET    /sessions/:id/route/:job       -> { job: RouteJobInfo }   (SSE: `event: state`, `progress`, `done`, `error`, `: keepalive` every 15 s)
 *   DELETE /sessions/:id/route/:job       -> { ok, job }             (fab_router: cooperative signal; Freerouting: kills java)
 *
 * The job refills the zones (unless `refillZones: false`), saves the board (`SaveDocument`, so
 * KiCad's exporter reads the current state), runs `extractRouteInput` -> router.route ->
 * `applyRouteResult` (one commit, message "Autoroute (<router>): <n> connections"), refills again,
 * then saves and re-measures the routed board. A failed post-apply refill for fab_router
 * fails without a final save and attempts an ownership-checked undo of the route commit.
 * Disabling refill still compares native DRC errors before and after tentative application.
 * Other engines retain best-effort refill behavior. A failed native DRC or tentative ratsnest query during fab_router's cleanup undoes that route
 * commit before failing the job; a failed undo is reported explicitly. The browser only has to
 * pick up the `DocumentChanged` event as usual. Cancelling
 * before the apply leaves the board untouched; a failed router run (a fab_router error, a
 * Freerouting crash) applies nothing and reports the error. A failure of the final save reports
 * the job as failed but leaves the applied route in KiCad memory, where the caller can retry
 * saving it.
 */
import { Arc, KiCad, KiCadClient, Track, Via, type Transport } from "@fp-pcb/client";
import { DrcErrorType, RuleSeverity, type DrcMarker } from "@fp-pcb/proto";
import { applyRouteResult } from "./apply";
import { extractRouteInput } from "./extract";
import { endpointCollisions } from "./endpoint-collisions";
import { applyRequestRules } from "./request-rules";
import { FreeroutingRouter, alreadyApplied, resolveFreerouting, type FreeroutingOptions, type FreeroutingPaths } from "./freerouting";
import { FabRouter, leftoverConnectionEndpoints } from "./fab-router";
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
   * `RefillZones` before extracting and after applying (default true). The first refill keeps
   * pour-connected pads out of the router's ratsnest; the second makes the saved fill match the
   * new tracks and vias.
   */
  refillZones?: boolean;
}

export interface RouteJobZoneRefill {
  /** The pre-route refill completed successfully. */
  before: boolean;
  /** The post-apply refill completed successfully. */
  after: boolean;
  /** A post-apply refill failure (fatal for fab_router). */
  error?: string;
}

/** An unrouted connection as reported to the browser (positions in nm). */
export interface RouteJobUnrouted {
  net: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface RouteJobSummary {
  endpointCollisions?: import("./types").EndpointCollisions;
  diagnostics?: import("./types").RoutingDiagnostics;
  pairRouting?: import("./types").PairRouting;
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
  /** Pre-existing, unlocked dangling copper removed on requested repair nets. */
  removedExistingCopper?: Array<{ id: string; net: string }>;
  /** Locked existing stubs retained rather than silently deleting protected user copper. */
  retainedDanglingCopper?: Array<{ id: string; net: string; reason: "locked" }>;
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
  /** Native net name, including when GetItems omits the net code. */
  netName?: string;
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
  /** Whether the pre-route and post-apply zone refills completed. */
  zoneRefill: RouteJobZoneRefill;
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
  /** The selected implementation behind the stable `router: "js"` capacity slot. */
  capacityRouter(): Promise<{ name: string; ok: boolean; reason?: string }>;
}

export interface RouteJobDeps {
  /** Replaces the router choice (tests). */
  routers?: (req: RouteJobRequest, kicad: KiCad, board: Awaited<ReturnType<KiCad["currentBoard"]>>) => Autorouter;
  /** Jar and Java for Freerouting; default `resolveFreerouting(process.env)`. */
  freerouting?: FreeroutingPaths;
  /** Replaces the selected capacity router (tests and embedded hosts). */
  capacityRouter?: Autorouter;
  /** Replaces opening the session's current board (tests and embedded hosts). */
  openBoard?: (session: RouteJobSession, jobId: string) => Promise<Awaited<ReturnType<KiCad["currentBoard"]>>>;
  /** Replaces route-input extraction (tests). */
  extract?: typeof extractRouteInput;
  /** Replaces applying the route result (tests). */
  apply?: typeof applyRouteResult;
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

// Every tentative-commit undo must verify ownership after asynchronous native
// queries. Refuse to undo a newer edit, even if that leaves tentative copper.
async function undoTentativeRoute(board: NonNullable<Awaited<ReturnType<KiCad["currentBoard"]>>>, commitId: string): Promise<void> {
  try {
    const top = (await board.undoStack()).undo.at(-1);
    if (!commitId || top?.commitId?.value !== commitId)
      throw new Error("tentative route commit is not at the top of the undo stack");
    const undone = await board.undo(1);
    if (undone.applied !== 1) throw new Error(`expected one undone commit, got ${undone.applied}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not undo tentative route: ${detail}; tentative route may remain in KiCad memory`, { cause: error });
  }
}

async function rejectTentativeValidation(
  board: NonNullable<Awaited<ReturnType<KiCad["currentBoard"]>>>,
  commitId: string,
  query: string,
  validationError: unknown,
): Promise<never> {
  const detail = validationError instanceof Error ? validationError.message : String(validationError);
  try {
    await undoTentativeRoute(board, commitId);
  } catch (rollbackError) {
    const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
    throw new Error(
      `${query} validation failed: ${detail}; rollback failed: ${rollbackDetail}; tentative route may remain in KiCad memory`,
      { cause: validationError },
    );
  }
  throw new Error(`${query} validation failed: ${detail}; tentative route commit undone`, { cause: validationError });
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
export function routeGeometry(
  items: readonly (Track | Arc | Via)[],
  codeByNet: ReadonlyMap<string, number> = new Map(),
): RouteJobGeometry[] {
  return items.map((item) => {
    if (item instanceof Via) {
      const r = item.diameter / 2;
      return {
        kind: "via",
        id: item.id,
        layer: -1,
        net: item.netCode || codeByNet.get(item.net ?? "") || 0,
        netName: item.net ?? "",
        points: [item.position.x - r, item.position.y - r, item.position.x + r, item.position.y + r],
      };
    }
    const points =
      item instanceof Arc
        ? [item.start.x, item.start.y, item.mid.x, item.mid.y, item.end.x, item.end.y]
        : [item.start.x, item.start.y, item.end.x, item.end.y];
    return {
      kind: "trace",
      id: item.id,
      layer: item.layerId,
      net: item.netCode || codeByNet.get(item.net ?? "") || 0,
      netName: item.net ?? "",
      points,
      width: item.width,
    };
  });
}

/**
 * A run that routed nothing is reported as failed, with the router's own reason: a router's
 * retries swallow its precheck errors into `log` and hand back an empty result, and a killed
 * Freerouting writes no session. Null when something was routed or there was nothing to route.
 */
export function emptyResultReason(
  r: Pick<RouteResult, "totalConnections" | "tracks" | "vias" | "unrouted" | "timedOut" | "log" | "diagnostics">,
): string | null {
  if (r.totalConnections === 0 || r.tracks.length || r.vias.length || r.unrouted.length < r.totalConnections) return null;
  if (r.diagnostics) return r.diagnostics.text;
  const why = [...r.log]
    .reverse()
    .find((l) => /solver failed|precheck|timed out|exited with|no session|ran out of|blockedPads|padstack-unknown/i.test(l));
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
  const capacityRouter: Autorouter = deps.capacityRouter ?? new FabRouter();
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
      zoneRefill: { before: false, after: false },
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
        if (!session.transport && !deps.openBoard) throw new Error("session has no KiCad transport");
        if (request.router === "freerouting" && !freerouting.ok) throw new Error(`Freerouting unavailable: ${freerouting.reason}`);
        const client = session.transport
          ? new KiCadClient(session.transport, { clientName: session.clientName ?? `fp-pcb/router-job-${id}` })
          : undefined;
        const kicad = client ? new KiCad(client) : undefined;
        const board = deps.openBoard ? await deps.openBoard(session, id) : await kicad!.currentBoard();
        if (!board) throw new Error("no board open in this session");
        checkCancelled();
        if (request.refillZones ?? true) {
          setState("filling");
          await board.refillZones();
          info.zoneRefill.before = true;
          checkCancelled();
        }
        setState("saving");
        await board.save();
        checkCancelled();
        setState("extracting");
        const originalCopper = await board.getTracks();
        const copperBefore = new Set(originalCopper.map((item) => item.id));
        const input = await (deps.extract ?? extractRouteInput)(board, { nets: request.options?.nets, warn: pushLog });
        const ruleLog = applyRequestRules(input, request.options ?? {});
        ruleLog.forEach(pushLog);
        pushLog(`extract: ${input.pads.length} pads, ${input.connections.length} connections, ${input.copperLayers.length} copper layers`);
        checkCancelled();
        if (request.options?.nets?.length && input.connections.length === 0) {
          pushLog(`onlyConnections ${request.options.nets.join(",")} has no remaining ratsnest; skipping the router`);
        }
        const router: Autorouter =
          deps.routers?.(request, kicad!, board) ??
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
        if (empty && !result.diagnostics) {
          const collisions = endpointCollisions(input, result.unrouted);
          const endpoints = leftoverConnectionEndpoints({ ...input, connections: result.unrouted });
          const solverStatus = [...result.log].reverse().find((line) => /stage completed|pass #.*unrouted/.test(line));
          const detail = endpoints
            .slice(0, 8)
            .map((end) => {
              const rules = input.rules.perNet.get(end.net) ?? input.rules.default;
              return `${end.net} ${end.itemId} (${end.x.toFixed(3)},${end.y.toFixed(3)}) mm; width ${rules.trackWidth / 1e6}, clearance ${rules.clearance / 1e6}, via ${rules.viaDiameter / 1e6}/${rules.viaDrill / 1e6} mm`;
            })
            .join("; ");
          const reason = `${empty}. ${solverStatus ?? "No solver search termination detail was exposed."} Remaining input connections: ${result.unrouted.length}; endpoints: ${detail}${endpoints.length > 8 ? `; ${endpoints.length - 8} more endpoints` : ""}. ${collisions.text} Next: inspect these connections and retained copper/keepouts; a failed search does not prove the board is unroutable.`;
          result.log.push(reason);
          info.log = result.log.slice(-LOG_TAIL);
          throw new Error(reason);
        }
        const routed = result.totalConnections - result.unrouted.length;
        let message = request.message ?? autorouteMessage(request.router, routed);
        setState("applying");
        let applied = false;
        let acceptedCommitId: string | undefined;
        const removedExistingCopper = new Map<string, string>();
        const retainedDanglingCopper: Array<{ id: string; net: string; reason: "locked" }> = [];
        // Without an explicit scope, repair only nets with input connections.
        const repairNets = new Set(request.options?.nets ?? input.connections.map((connection) => connection.net));
        const removableExisting = new Map(
          originalCopper.filter((item) => !item.locked && item.net && repairNets.has(item.net)).map((item) => [item.id, item.net!]),
        );
        // Compare matching states: filled when requested, otherwise unfilled. Marker UUIDs
        // change on each native check; retain multiplicity of stable identities.
        // Report every track finding so an existing clearance error cannot mask
        // a new violation on the same track. Use the same mode in every check.
        let nativeBaseline: DrcMarker[] | undefined;
        if (result.router === "fab-router" && !alreadyApplied(result) &&
            (result.tracks.length || result.vias.length || result.claimedVias?.length)) {
          nativeBaseline = (await board.drc.run({ refillZones: false, reportAllTrackErrors: true })).markers;
        }
        if (!alreadyApplied(result) && (result.tracks.length || result.vias.length || result.claimedVias?.length)) {
          // Each cleanup pass removes an item; allow one extra pass to validate a relabelled commit.
          const maxCleanupPasses = result.tracks.length + result.vias.length + removableExisting.size + 2;
          for (let cleanupPass = 0; cleanupPass < maxCleanupPasses; cleanupPass++) {
            const committed = await (deps.apply ?? applyRouteResult)(board, result, {
              message,
              removeCopperIds: [...removedExistingCopper.keys()],
            });
            if (result.router !== "fab-router") {
              applied = true;
              break;
            }
            const createdIds = new Set(committed.created.map((item) => item.id));
            let drc;
            try {
              drc = await board.drc.run({ refillZones: false, reportAllTrackErrors: true });
            } catch (validationError) {
              return await rejectTentativeValidation(board, committed.commitId, "native DRC", validationError);
            }
            const danglingIds = new Set(
              drc.markers
                .filter(
                  (marker) =>
                    !marker.excluded &&
                    (marker.severity === RuleSeverity.RS_ERROR || marker.severity === RuleSeverity.RS_WARNING) &&
                    (marker.errorType === DrcErrorType.DRCET_DANGLING_TRACK || marker.errorType === DrcErrorType.DRCET_DANGLING_VIA),
                )
                .flatMap((marker) => marker.items.map((item) => item.value)),
            );
            const rejectedIds = new Set([...danglingIds].filter((id) => createdIds.has(id)));
            const existingIds = [...danglingIds].filter((id) => removableExisting.has(id) && !removedExistingCopper.has(id));
            if (!rejectedIds.size && !existingIds.length) {
              // Disabling refill skips zone recomputation, not native DRC safety.
              // Compare matching unfilled states before accepting tentative copper.
              if (!(request.refillZones ?? true)) {
                const added = newNativeErrors(nativeBaseline ?? [], drc.markers);
                if (added) return await rejectTentativeValidation(
                  board, committed.commitId, "native DRC", new Error(`${added} new native DRC error(s)`),
                );
              }

              for (const item of originalCopper.filter(
                (item) => item.locked && item.net && repairNets.has(item.net) && danglingIds.has(item.id),
              )) {
                retainedDanglingCopper.push({ id: item.id, net: item.net!, reason: "locked" });
                result.log.push(
                  `Retained locked dangling copper on requested net ${item.net}: ${item.id}; native DRC still requires attention`,
                );
              }
              if (!request.message) {
                let nativeOpen: number;
                try {
                  nativeOpen = (await board.ratsnest(request.options?.nets ?? [])).edges.length;
                } catch (validationError) {
                  return await rejectTentativeValidation(board, committed.commitId, "native ratsnest", validationError);
                }
                const nativeMessage = autorouteMessage(request.router, Math.max(0, result.totalConnections - nativeOpen));
                if (nativeMessage !== message) {
                  await undoTentativeRoute(board, committed.commitId);
                  message = nativeMessage;
                  // Re-enter the same validation path for the replacement commit. Native
                  // checks describe the previous commit, including its created item IDs.
                  if (cleanupPass + 1 === maxCleanupPasses)
                    throw new Error("fab_router native connection count did not converge while relabelling the route");
                  continue;
                }
              }
              acceptedCommitId = committed.commitId;
              applied = true;
              break;
            }
            await undoTentativeRoute(board, committed.commitId);
            for (const id of existingIds) {
              removedExistingCopper.set(id, removableExisting.get(id)!);
              result.log.push(`Removed pre-existing dangling copper on requested net ${removableExisting.get(id)}: ${id}`);
            }
            const before = result.tracks.length + result.vias.length;
            result = withoutRejectedCreatedCopper(result, committed.created as (Track | Arc | Via)[], rejectedIds);
            const removed = before - result.tracks.length - result.vias.length;
            result.log.push(
              `KiCad rejected ${removed} generated and ${existingIds.length} pre-existing dangling item(s) before the durable commit (cleanup pass ${cleanupPass + 1})`,
            );
            if (!removed && !existingIds.length)
              throw new Error("KiCad identified dangling fab_router copper but it could not be mapped back to the route result");
            if (!result.tracks.length && !result.vias.length && !result.claimedVias?.length && !removedExistingCopper.size) break;
            if (cleanupPass + 1 === maxCleanupPasses) throw new Error("fab_router dangling-copper cleanup did not converge");
          }
        }
        const appliedByKicad = (result as RouteResult & { applied?: { tracksAdded: number; viasAdded: number } }).applied;
        if (applied || appliedByKicad) {
          if (request.refillZones ?? true) {
            setState("filling");
            try {
              await board.refillZones();
              info.zoneRefill.after = true;
            } catch (e) {
              const detail = e instanceof Error ? e.message : String(e);
              info.zoneRefill.error = detail;
              if (result.router === "fab-router" && acceptedCommitId) {
                // A failed refill may itself have committed. Never assume undo(1)
                // still targets the route; refuse if a newer native entry exists.
                return await rejectTentativeValidation(board, acceptedCommitId, "post-apply zone refill", e);
              }
              result.log.push(`RefillZones after the apply failed: ${detail}; saving the applied route without a fresh fill`);
            }
          }
          if (result.router === "fab-router" && acceptedCommitId && info.zoneRefill.after) {
            try {
              const filled = await board.drc.run({ refillZones: false, reportAllTrackErrors: true });
              const added = newNativeErrors(nativeBaseline ?? [], filled.markers);
              if (added) throw new Error(`${added} new filled native DRC error(s)`);
            } catch (validationError) {
              return await rejectTentativeValidation(board, acceptedCommitId, "post-refill native DRC", validationError);
            }
          }
          setState("saving");
          await persistAppliedRoute(board);
        }
        // Re-measure with KiCad's connectivity: what is still an airline after the apply.
        let unrouted = unroutedOf(result);
        let measured = routed;
        let nativeOpen: RouteConnection[] | undefined;
        try {
          const nets = new Set(request.options?.nets ?? []);
          const rats = await board.ratsnest(request.options?.nets ?? []);
          const edges = rats.edges.filter((e) => !nets.size || nets.has(e.net));
          nativeOpen = edges.map((e) => ({
            net: e.net,
            netCode: e.netCode,
            length: e.length,
            from: { itemId: e.source, position: e.sourcePosition, layers: [] },
            to: { itemId: e.target, position: e.targetPosition, layers: [] },
          }));
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
        result.log.push(...ruleLog);
        // Only native leftover endpoints, against input copper captured before either router ran.
        // On GetRatsnest failure omit the probe rather than label solver guesses as native opens.
        const collisions = nativeOpen ? endpointCollisions(input, nativeOpen) : undefined;
        if (collisions) {
          result.log.push(collisions.text);
          if (result.diagnostics) {
            result.diagnostics.physicalBlockerEstablished = collisions.physicalBlockerEstablished;
            result.diagnostics.collisions = collisions.collisions;
          }
        }
        info.state = "done";
        info.finishedAt = new Date().toISOString();
        info.log = result.log.slice(-LOG_TAIL);
        const claimedIds = new Set(result.claimedVias?.map((via) => via.id) ?? []);
        const geometry = routeGeometry(
          (await board.getTracks()).filter((item) => !copperBefore.has(item.id) || claimedIds.has(item.id)),
          new Map((input.nets ?? []).map((net) => [net.name, net.code])),
        );
        info.summary = {
          ...(retainedDanglingCopper.length ? { retainedDanglingCopper } : {}),
          ...(removedExistingCopper.size ? { removedExistingCopper: [...removedExistingCopper].map(([id, net]) => ({ id, net })) } : {}),
          ...(collisions ? { endpointCollisions: collisions } : {}),
          ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
          ...(result.pairRouting ? { pairRouting: result.pairRouting } : {}),
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
          message:
            result.diagnostics && (!(applied || appliedByKicad) || unrouted.length > 0)
              ? result.diagnostics.text
              : applied || appliedByKicad
                ? message
                : "",
          unrouted,
          geometry,
          log: result.log,
        };
        if (info.summary.diagnostics && (retainedDanglingCopper.length || removedExistingCopper.size)) {
          info.summary.diagnostics.danglingCopper = {
            removedExisting: [...removedExistingCopper].map(([id, net]) => ({ id, net })),
            retained: retainedDanglingCopper,
          };
        }
        if (retainedDanglingCopper.length) {
          const warning = `${retainedDanglingCopper.length} locked dangling copper item(s) remain on requested nets; route is not native-clean. Retained: ${retainedDanglingCopper.map((item) => `${item.net}/${item.id}`).join(", ")}.`;
          info.summary.message += `; ${warning}`;
          if (info.summary.diagnostics) info.summary.diagnostics.text += ` ${warning}`;
        }
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

/** Stable marker identity excludes regenerated marker UUIDs and human descriptions. */
function newNativeErrors(before: readonly DrcMarker[], after: readonly DrcMarker[]): number {
  const key = (m: DrcMarker) => JSON.stringify([
    m.errorType, m.layer, m.position ? [String(m.position.xNm), String(m.position.yNm)] : null,
    m.items.map((item) => item.value).sort(),
  ]);
  const active = (m: DrcMarker) => !m.excluded && m.severity === RuleSeverity.RS_ERROR;
  const remaining = new Map<string, number>();
  for (const marker of before.filter(active)) {
    const id = key(marker);
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  let added = 0;
  for (const marker of after.filter(active)) {
    const id = key(marker);
    const count = remaining.get(id) ?? 0;
    if (count) remaining.set(id, count - 1);
    else added++;
  }
  return added;
}
