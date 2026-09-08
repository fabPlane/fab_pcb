/**
 * A compile job the bridge can mount, the same shape as the router's (`@fp-pcb/router/bridge-job`):
 * `POST /sessions/:id/compile` starts a compile on the session's KiCad, `GET /sessions/:id/compile/:job`
 * polls it (or streams progress over SSE with `Accept: text/event-stream`), `DELETE` cancels.
 * Nothing here imports the bridge — the bridge imports this and calls `jobs.handle(...)`:
 *
 *   const jobs = createCompileJobs();
 *   // in fetch(): const m = matchCompileJobPath(path); if (m) return jobs.handle(req, { id, transport }, m.jobId);
 *
 * The HTTP contract (JSON unless noted):
 *
 *   POST   /sessions/:id/compile          body CompileJobRequest     -> 202 { job: CompileJobInfo }  (400 unknown frontend / bad source, 409 no KiCad)
 *   GET    /sessions/:id/compile          -> { jobs: CompileJobInfo[], frontends: string[] }
 *   GET    /sessions/:id/compile/:job     -> { job: CompileJobInfo }  (SSE: `event: state`, `progress`, `done`, `error`, `: keepalive` every 15 s)
 *   DELETE /sessions/:id/compile/:job     -> { ok, job }              (cancels between stages: KiCad requests are not interruptible)
 *
 * What a job does: finds the session's open board — or, when the session was started bare,
 * creates the project at `request.project.path` and opens its board — registers the frontend's
 * libraries in the project tables, runs `compile()` (frontend → validate → dry run → outline →
 * import → autoplace with the edge-clearance inset), and saves. A compile whose frontend or
 * netlist has errors ends `failed` with `result.diagnostics`; an infrastructure failure ends
 * `failed` with `error` and no `result`. Cancelling before the import leaves the board with at
 * most the outline commit; after it, KiCad's own "Update Netlist" commit stays.
 *
 * `done` events carry `revision` as a compatibility fallback for older fork builds that do not
 * publish `DocumentChanged` from `ImportNetlist`.
 */
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { KiCad, KiCadClient, type Board, type Schematic, type Transport } from "@fp-pcb/client";
import { edgeClearanceNm } from "./apply";
import { compile, CompileCancelled } from "./compile";
import { netlistJsonFrontend } from "./frontends/netlist-json";
import { registerLibraries } from "./libraries";
import { applyBoardConstraints, applyDefaultNetClass, hasRules } from "./rules";
import { generateSchematic } from "./schematic";
import type { BoardRules, BoardSpec, CompileResult, CompileSource, Frontend, LibrarySpec, MatchMode } from "./types";

export type CompileJobState =
  | "queued"
  | "frontend"
  | "validating"
  | "checking"
  | "outlining"
  | "importing"
  | "placing"
  | "schematic"
  | "saving"
  | "done"
  | "failed"
  | "cancelled";

export interface CompileJobRequest {
  source: CompileSource;
  /**
   * Where to create the KiCad project (the `.kicad_pro` path) when the session has no board open.
   * Ignored when a board is already open.
   */
  project?: { path: string };
  /** Overrides the frontend's board spec. */
  board?: BoardSpec;
  matchMode?: MatchMode;
  deleteExtraFootprints?: boolean;
  updateFootprints?: boolean;
  /** Default true. */
  autoplace?: boolean;
  /** `SaveDocument` after a successful compile; default true, because everything downstream reads the file. */
  save?: boolean;
  /** Where the generated `.net` is written, relative to the project directory; default `.fp-pcb/compile.net`. */
  netlistPath?: string;
  /** Commit message for the outline commit. */
  message?: string;
}

export interface CompileJobInfo {
  id: string;
  sessionId: string;
  frontend: string;
  state: CompileJobState;
  startedAt: string;
  finishedAt?: string;
  log: string[];
  /** Present when the compiler ran to a verdict, `ok` or not. */
  result?: CompileResult;
  /** Infrastructure failure; `result` is then absent. */
  error?: string;
  /** Board revision after the job, for clients that cannot rely on `DocumentChanged`. */
  revision?: number;
}

export interface CompileJobSession {
  id: string;
  /** The session's transport to KiCad (the bridge's `Session.transport`). */
  transport: Transport | null;
  clientName?: string;
  /** Lets the bridge keep its session discovery metadata authoritative after project creation. */
  updateProjectPath?(path: string): void;
}

export interface CompileJobDeps {
  /** Frontends by kind; default just `netlist-json`. */
  frontends?: Frontend[];
  /** Placement margin from the board edge in nm; default the board's copper-to-edge clearance rule. */
  edgeMargin?: (board: Board) => Promise<number>;
  log?: (message: string) => void;
  /** Standard libraries bundled with the bridge, registered together with frontend-local rows. */
  libraries?: readonly LibrarySpec[];
}

export interface CompileJobs {
  handle(req: Request, session: CompileJobSession, jobId?: string): Promise<Response>;
  start(session: CompileJobSession, request: CompileJobRequest): CompileJobInfo;
  get(id: string): CompileJobInfo | undefined;
  list(sessionId?: string): CompileJobInfo[];
  cancel(id: string): boolean;
  /** Resolves when the job has finished (done, failed or cancelled). */
  wait(id: string): Promise<CompileJobInfo>;
  /** The frontend kinds a request may name. */
  readonly frontends: string[];
}

export const DEFAULT_NETLIST_PATH = ".fp-pcb/compile.net";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
};
const LOG_TAIL = 40;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

interface Job {
  info: CompileJobInfo;
  listeners: Set<(ev: string, data: unknown) => void>;
  abort: AbortController;
}

/** Shape check of a request body; the frontend does the real validation of the files. */
export function checkRequest(
  body: unknown,
  frontends: readonly string[],
): { ok: true; request: CompileJobRequest } | { ok: false; error: string } {
  const b = body as Partial<CompileJobRequest> | null;
  const s = b?.source as Partial<CompileSource> | undefined;
  if (!s || typeof s !== "object") return { ok: false, error: "source is required" };
  if (typeof s.kind !== "string" || !s.kind) return { ok: false, error: "source.kind is required" };
  if (!frontends.includes(s.kind)) return { ok: false, error: `unknown frontend "${s.kind}"; available: ${frontends.join(", ")}` };
  if (!s.files || typeof s.files !== "object" || Array.isArray(s.files))
    return { ok: false, error: "source.files must be an object of file contents" };
  if (typeof s.entrypoint !== "string" || !s.entrypoint) return { ok: false, error: "source.entrypoint is required" };
  if (b!.project !== undefined && (typeof b!.project !== "object" || typeof b!.project?.path !== "string"))
    return { ok: false, error: "project.path must be a string" };
  return { ok: true, request: b as CompileJobRequest };
}

/** The board of the session, or a new project's board when the session was started bare. */
export async function boardFor(
  kicad: KiCad,
  request: Pick<CompileJobRequest, "project">,
  log: (l: string) => void,
  onProjectCreated?: (path: string) => void,
): Promise<Board> {
  const open = await kicad.currentBoard();
  if (open) return open;
  if (!request.project?.path) throw new Error("no board is open in this session and the request names no project.path to create one");
  const project = await kicad.newProject(request.project.path);
  onProjectCreated?.((await project.info()).kicadProPath);
  log(`created project ${request.project.path}`);
  return (await kicad.currentBoard()) ?? (await project.openBoard());
}

export function createCompileJobs(deps: CompileJobDeps = {}): CompileJobs {
  const jobs = new Map<string, Job>();
  const frontends = new Map<string, Frontend>((deps.frontends ?? [netlistJsonFrontend]).map((f) => [f.kind, f]));
  const kinds = [...frontends.keys()];
  const log = deps.log ?? (() => {});

  const emit = (job: Job, ev: string, data: unknown) => {
    for (const l of [...job.listeners]) l(ev, data);
  };
  const finished = (s: CompileJobState) => s === "done" || s === "failed" || s === "cancelled";

  const start = (session: CompileJobSession, request: CompileJobRequest): CompileJobInfo => {
    const id = crypto.randomUUID().slice(0, 8);
    const info: CompileJobInfo = {
      id,
      sessionId: session.id,
      frontend: request.source.kind,
      state: "queued",
      startedAt: new Date().toISOString(),
      log: [],
    };
    const abort = new AbortController();
    const job: Job = { info, listeners: new Set(), abort };
    jobs.set(id, job);
    const setState = (state: CompileJobState) => {
      info.state = state;
      emit(job, "progress", { state, log: info.log });
    };
    const pushLog = (line: string) => {
      info.log.push(line);
      if (info.log.length > LOG_TAIL) info.log.splice(0, info.log.length - LOG_TAIL);
    };
    log(`compile job ${id}: ${request.source.kind} on session ${session.id}`);

    void (async () => {
      try {
        if (!session.transport) throw new Error("session has no KiCad transport");
        const frontend = frontends.get(request.source.kind);
        if (!frontend) throw new Error(`unknown frontend "${request.source.kind}"`);
        const client = new KiCadClient(session.transport, { clientName: session.clientName ?? `fp-pcb/compile-job-${id}` });
        const kicad = new KiCad(client);
        const board = await boardFor(kicad, request, pushLog, session.updateProjectPath);
        abort.signal.throwIfAborted();

        const projectInfo = await kicad.projectInfo();
        const projectDir = dirname(projectInfo.kicadProPath);
        const rel = request.netlistPath ?? DEFAULT_NETLIST_PATH;
        const netlistPath = isAbsolute(rel) ? rel : resolve(projectDir, rel);
        await mkdir(dirname(netlistPath), { recursive: true });
        const autoplace = request.autoplace ?? true;
        let rules: BoardRules | undefined;
        let schematic: Schematic | undefined;
        const edgeMarginNm = autoplace ? await (deps.edgeMargin ?? edgeClearanceNm)(board) : 0;

        const result = await compile(request.source, board, {
          frontend,
          netlistPath,
          ...(request.board ? { board: request.board } : {}),
          ...(request.matchMode ? { matchMode: request.matchMode } : {}),
          ...(request.deleteExtraFootprints !== undefined ? { deleteExtraFootprints: request.deleteExtraFootprints } : {}),
          ...(request.updateFootprints !== undefined ? { updateFootprints: request.updateFootprints } : {}),
          ...(request.message ? { message: request.message } : {}),
          autoplace,
          edgeMarginNm,
          signal: abort.signal,
          onStage: setState,
          beforeApply: async (built) => {
            rules = (request.board ?? built.board)?.rules;
            if (hasRules(rules)) pushLog(`rules: ${(await applyBoardConstraints(board, rules)).join(", ")}`);
            const libraries = [...(deps.libraries ?? []), ...(built.libraries ?? [])];
            const uniqueLibraries = [...new Map(libraries.map((library) => [`${library.kind}:${library.nickname}`, library])).values()];
            if (uniqueLibraries.length) {
              await registerLibraries(kicad, uniqueLibraries);
              const names = uniqueLibraries.map((library) => library.nickname);
              const shown = names.slice(0, 12).join(", ") + (names.length > 12 ? `, … +${names.length - 12}` : "");
              pushLog(
                `registered ${uniqueLibraries.length} project librar${uniqueLibraries.length === 1 ? "y" : "ies"}: ${shown}`,
              );
            }
          },
          afterApply: async (built) => {
            const generated = await generateSchematic(kicad, built.netlist!);
            schematic = generated.schematic;
            pushLog(
              `schematic: ${generated.symbolsCreated} symbols, ${generated.wiresCreated} wires, ${generated.labelsCreated} labels`,
            );
            return generated.diagnostics;
          },
        });
        for (const d of result.diagnostics) pushLog(`${d.severity} [${d.stage}${d.code ? `/${d.code}` : ""}] ${d.message.split("\n")[0]}`);
        abort.signal.throwIfAborted();
        // The net class goes last: SetNetClasses breaks the autoplacer for later imports (G29).
        if (result.ok && hasRules(rules)) pushLog(`net class: ${(await applyDefaultNetClass(kicad, rules)).join(", ")}`);
        if (result.ok && request.save !== false) {
          setState("saving");
          await board.save();
          await schematic?.save();
        }
        const rev = await board.revision().catch(() => undefined);
        if (rev !== undefined) info.revision = Number(rev);
        info.result = result;
        info.state = result.ok ? "done" : "failed";
        info.finishedAt = new Date().toISOString();
        log(
          `compile job ${id}: ${info.state} in ${result.durationMs} ms (${result.counts.components} components, ${result.counts.footprintsAdded} added, ${result.counts.footprintsPlaced} placed${result.counts.viasAdded ? `, ${result.counts.viasAdded} blank vias` : ""})`,
        );
        emit(job, "done", info);
      } catch (e) {
        const cancelled = abort.signal.aborted || CompileCancelled.is(e);
        info.state = cancelled ? "cancelled" : "failed";
        info.finishedAt = new Date().toISOString();
        info.error = cancelled ? "cancelled" : e instanceof Error ? e.message : String(e);
        log(`compile job ${id}: ${info.state}: ${info.error}`);
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
    frontends: kinds,
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
        if (req.method === "GET") return json({ jobs: this.list(session.id), frontends: kinds });
        if (req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json({ error: "body must be JSON" }, 400);
          }
          const checked = checkRequest(body, kinds);
          if (!checked.ok) return json({ error: checked.error }, 400);
          if (!session.transport) return json({ error: "session has no running KiCad" }, 409);
          return json({ job: start(session, checked.request) }, 202);
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

/** Parses `/sessions/:id/compile[/:job]`; undefined when the path is something else. */
export function matchCompileJobPath(pathname: string): { sessionId: string; jobId?: string } | undefined {
  const m = /^\/sessions\/([^/]+)\/compile(?:\/([^/]+))?$/.exec(pathname);
  if (!m) return undefined;
  return { sessionId: decodeURIComponent(m[1]!), jobId: m[2] ? decodeURIComponent(m[2]) : undefined };
}
