// Autorouting for the board editor (Route -> Autoroute...). Three ways to run, one result shape:
//
//   js-tab       `@fp-pcb/router`'s JsRouter in this tab: extractRouteInput over the session's
//                WebSocket, the solver's step loop yielding to the UI every few tens of ms (so the
//                dialog stays live and Cancel works), applyRouteResult as one commit.
//   js-server    the same router inside the bridge (`POST /sessions/:id/route {router:"js"}`),
//                for boards too big to keep a tab busy.
//   freerouting  Freerouting (Java) on the bridge, DSN from KiCad's own exporter, the session
//                parsed by the router package and applied under our commit message.
//
// The bridge jobs are followed over their SSE stream (`GET .../route/:job` with
// `Accept: text/event-stream`), progress and the log tail land in `AutorouteRun`, and the
// board is re-read when the job is done. Either way the result is one undo entry —
// "Autoroute (<router>): <n> connections" — in KiCad's stack, and in the app's own history
// (recorded from the created items) when the server has no undo.

import { KiCadObjectType } from '@fp-pcb/proto';
import { BoardLayer } from '@fp-pcb/proto';
import type { Board } from '@fp-pcb/client';
import { applyRouteResult } from '@fp-pcb/router/apply';
import { extractRouteInput } from '@fp-pcb/router/extract';
import { JsRouter } from '@fp-pcb/router/js-router';
import { RouteCancelled, type Autorouter, type RouteInput, type RouteOptions, type RouteProgress, type RouteResult } from '@fp-pcb/router/types';
import type { ItemOp, CommandService } from '../types';
import type { AutorouteAvailability, AutorouteRequest, AutorouteRun, AutorouteService, AutorouteState, AutorouteSummary } from '../extras';
import { SseParser, appendLog, applyBridgeEvent, autorouteMessage, buildJobRequest, emptyResultReason, isFinished, type BridgeRouteJobInfo } from '../autoroute-run';
import type { KicadDocumentService } from './KicadDocumentService';
import type { KicadSessionService } from './KicadSessionService';

/** Injection points for the unit tests; the defaults are the router package. */
export interface AutorouteDeps {
  extract: (board: Board, opts: { nets?: readonly string[]; warn?: (m: string) => void }) => Promise<RouteInput>;
  apply: (board: Board, result: RouteResult, opts: { message: string }) => Promise<{ created: { id: string; type?: KiCadObjectType }[] }>;
  createRouter: () => Autorouter;
  now: () => number;
}

const LAYER_TABLE = BoardLayer as unknown as Record<string, number | undefined>;
const COPPER_TYPES = ['KOT_PCB_TRACE', 'KOT_PCB_ARC', 'KOT_PCB_VIA'];
const CANCEL_GRACE_MS = 10_000;

export class KicadAutorouteService implements AutorouteService {
  private run: AutorouteRun | null = null;
  private subs = new Set<() => void>();
  private abort: AbortController | null = null;
  private jobId: string | null = null;
  private seq = 0;
  private readonly deps: AutorouteDeps;

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly session: KicadSessionService,
    private readonly commands: CommandService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
    deps: Partial<AutorouteDeps> = {},
  ) {
    this.deps = {
      extract: (board, opts) => extractRouteInput(board, opts),
      apply: (board, result, opts) => applyRouteResult(board, result, opts),
      createRouter: () => new JsRouter({ yieldEveryMs: 30 }),
      now: () => Date.now(),
      ...deps,
    };
  }

  current(): AutorouteRun | null {
    return this.run;
  }

  running(): boolean {
    return !!this.run && !isFinished(this.run);
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private set(next: AutorouteRun): void {
    this.run = next;
    for (const cb of this.subs) cb();
  }

  private patch(p: Partial<AutorouteRun>): void {
    if (this.run) this.set({ ...this.run, ...p });
  }

  private setState(state: AutorouteState): void {
    this.patch({ state });
  }

  private addLog(lines: string[]): void {
    if (this.run) this.set({ ...this.run, log: appendLog(this.run.log, lines) });
  }

  async available(): Promise<AutorouteAvailability> {
    const id = this.session.session?.id;
    if (this.session.bridgeless || !id) return { server: false, freerouting: { ok: false, reason: 'no bridge: the tab talks to KiCad directly' } };
    try {
      const r = await this.session.bridgeJson<{ freerouting?: { ok: boolean; reason?: string } }>(`/sessions/${encodeURIComponent(id)}/route`);
      return { server: true, freerouting: r.freerouting ?? { ok: false, reason: 'the bridge does not report Freerouting' } };
    } catch (e) {
      return { server: false, freerouting: { ok: false, reason: `the bridge has no /route (${e instanceof Error ? e.message : String(e)})` } };
    }
  }

  async start(request: AutorouteRequest): Promise<AutorouteRun> {
    if (this.running()) throw new Error('an autoroute run is already in progress');
    const board = this.docs.boardDoc;
    if (!board) throw new Error('no board is open');
    const run: AutorouteRun = { id: `ar-${++this.seq}`, request, state: 'starting', startedAt: this.deps.now(), log: [] };
    this.set(run);
    this.abort = new AbortController();
    const release = this.docs.beginActivity();
    try {
      if (request.router === 'js-tab') await this.runInTab(board, request);
      else await this.runOnBridge(board, request);
    } catch (e) {
      const cancelled = this.abort.signal.aborted || RouteCancelled.is(e);
      const message = e instanceof Error ? e.message : String(e);
      this.patch({ state: cancelled ? 'cancelled' : 'failed', finishedAt: this.deps.now(), error: cancelled ? (message === 'routing cancelled' ? 'cancelled' : `cancelled: ${message}`) : message });
      this.log(`Autoroute ${cancelled ? 'cancelled' : 'failed'}: ${message}`, cancelled ? 'warn' : 'error');
    } finally {
      release();
      this.abort = null;
      this.jobId = null;
    }
    return this.run!;
  }

  async cancel(): Promise<void> {
    if (!this.running()) return;
    const id = this.session.session?.id;
    if (this.jobId && id) {
      try {
        await this.session.bridgeJson(`/sessions/${encodeURIComponent(id)}/route/${encodeURIComponent(this.jobId)}`, { method: 'DELETE' });
      } catch (e) {
        this.log(`cancel: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
      // the bridge answers with the job's `error` event; only pull the plug if it does not
      const abort = this.abort;
      setTimeout(() => {
        if (abort && !abort.signal.aborted && this.abort === abort) abort.abort();
      }, CANCEL_GRACE_MS);
    } else this.abort?.abort();
  }

  // ------------------------------------------------------------------ in this tab

  private async runInTab(board: Board, request: AutorouteRequest): Promise<void> {
    const signal = this.abort!.signal;
    const t0 = performance.now();
    const check = () => {
      if (signal.aborted) throw new RouteCancelled();
    };
    if (request.refillZones ?? true) {
      this.setState('filling');
      await board.refillZones();
      check();
    }
    this.setState('extracting');
    const input = await this.deps.extract(board, { nets: request.nets, warn: (m) => this.addLog([m]) });
    this.addLog([`extract: ${input.pads.length} pads, ${input.connections.length} connections, ${input.copperLayers.length} copper layers`]);
    check();
    this.setState('routing');
    const router = this.deps.createRouter();
    const opts: RouteOptions = { signal };
    const layers = request.layers?.map((l) => LAYER_TABLE[l]).filter((v): v is number => v !== undefined) as BoardLayer[] | undefined;
    if (layers?.length) opts.layers = layers;
    if (request.nets?.length) opts.nets = request.nets;
    if (request.viaCost !== undefined && request.viaCost !== 1) opts.viaCost = request.viaCost;
    if (request.passes !== undefined) opts.effort = request.passes;
    if (request.timeLimitMs && request.timeLimitMs > 0) opts.maxTimeMs = request.timeLimitMs;
    let lastLogged = '';
    const result = await router.route(input, opts, (p: RouteProgress) => {
      const line = p.message ? `${p.phase}: ${p.message}` : p.phase;
      const lines = line !== lastLogged ? [line] : [];
      lastLogged = line;
      if (this.run) this.set({ ...this.run, progress: p, log: appendLog(this.run.log, lines) });
    });
    check();
    const empty = emptyResultReason(result);
    if (empty) {
      this.patch({ log: result.log });
      throw new Error(empty);
    }
    const routed = result.totalConnections - result.unrouted.length;
    const message = autorouteMessage('js', routed);
    this.setState('applying');
    let created: string[] = [];
    let createdItems: { id: string; type?: KiCadObjectType }[] = [];
    if (result.tracks.length || result.vias.length) {
      const r = await this.deps.apply(board, result, { message });
      createdItems = r.created;
      created = r.created.map((i) => i.id);
      await this.docs.resyncDocument('board');
      this.recordHistory(message, created);
    }
    // Re-measure with KiCad's connectivity: the airlines still there after the apply.
    let unrouted = result.unrouted.map((c) => ({ net: c.net, from: { x: c.from.position.x, y: c.from.position.y }, to: { x: c.to.position.x, y: c.to.position.y } }));
    let measured = routed;
    try {
      const nets = new Set(request.nets ?? []);
      const rats = await board.ratsnest(request.nets ?? []);
      const edges = rats.edges.filter((e) => !nets.size || nets.has(e.net));
      unrouted = edges.map((e) => ({ net: e.net, from: { x: e.sourcePosition.x, y: e.sourcePosition.y }, to: { x: e.targetPosition.x, y: e.targetPosition.y } }));
      measured = Math.max(0, result.totalConnections - edges.length);
      if (measured !== routed) result.log.push(`GetRatsnest after the apply: ${edges.length} connection(s) still unrouted (the router counted ${result.unrouted.length})`);
    } catch (e) {
      result.log.push(`GetRatsnest after the apply failed: ${e instanceof Error ? e.message : String(e)}; using the router's own count`);
    }
    const unroutedAfter = await board
      .unroutedCount()
      .then((u) => u.unroutedCount)
      .catch(() => undefined);
    // Count what KiCad actually created, not what the router produced: applyRouteResult drops
    // zero-length tracks, so the two can differ by a few items and the history entry must agree
    // with the board.
    const typed = createdItems.some((it) => it.type !== undefined);
    const createdTracks = createdItems.filter((it) => it.type === KiCadObjectType.KOT_PCB_TRACE || it.type === KiCadObjectType.KOT_PCB_ARC).length;
    const createdVias = createdItems.filter((it) => it.type === KiCadObjectType.KOT_PCB_VIA).length;
    const summary: AutorouteSummary = {
      router: result.router,
      tracks: typed ? createdTracks : result.tracks.length,
      vias: typed ? createdVias : result.vias.length,
      routed: measured,
      routerRouted: routed,
      total: result.totalConnections,
      trackLengthNm: Math.round(result.tracks.reduce((a, t) => a + Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y), 0)),
      elapsedMs: result.elapsedMs,
      wallMs: Math.round(performance.now() - t0),
      timedOut: result.timedOut,
      message: created.length ? message : '',
      unrouted,
      unroutedAfter,
      log: result.log,
    };
    this.patch({ state: 'done', finishedAt: this.deps.now(), summary, log: result.log });
    this.log(
      `Autoroute (js, in tab): ${measured}/${result.totalConnections} connections, ${summary.tracks} tracks, ${summary.vias} vias in ${summary.wallMs} ms${result.timedOut ? ' (timed out)' : ''}`,
    );
  }

  // ------------------------------------------------------------------ on the bridge

  private async runOnBridge(board: Board, request: AutorouteRequest): Promise<void> {
    const id = this.session.session?.id;
    if (!id || this.session.bridgeless) throw new Error('routing on the server needs the bridge (this tab talks to KiCad directly)');
    const signal = this.abort!.signal;
    const before = new Set(this.copperIds());
    const body = buildJobRequest(request, LAYER_TABLE);
    const { job } = await this.session.bridgeJson<{ job: BridgeRouteJobInfo }>(`/sessions/${encodeURIComponent(id)}/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    this.jobId = job.id;
    this.log(`Autoroute: bridge job ${job.id} (${body.router}) started`);
    const res = await this.session.bridgeFetch(`/sessions/${encodeURIComponent(id)}/route/${encodeURIComponent(job.id)}`, { headers: { accept: 'text/event-stream' }, signal });
    if (!res.ok || !res.body) throw new Error(`job stream: ${res.status} ${res.statusText}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const parser = new SseParser();
    const feed = (events: ReturnType<SseParser['push']>) => {
      for (const ev of events) if (this.run) this.set(applyBridgeEvent(this.run, ev, this.deps.now()));
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(parser.push(dec.decode(value, { stream: true })));
      if (isFinished(this.run)) break;
    }
    feed(parser.flush());
    reader.cancel().catch(() => undefined);
    const run = this.run!;
    if (!isFinished(run)) throw new Error(signal.aborted ? 'routing cancelled' : 'the bridge closed the job stream before the job finished');
    if (run.state === 'cancelled') throw new RouteCancelled(run.error ?? 'cancelled');
    if (run.state === 'failed') throw new Error(run.error ?? 'routing failed');
    // Done: the bridge's client made the commit, so the DocumentChanged relay has re-read the
    // created items already (foreign client); a full re-sync also picks up the zone fills.
    await this.docs.resyncDocument('board');
    const created = this.copperIds().filter((x) => !before.has(x));
    if (run.summary?.message && created.length) this.recordHistory(run.summary.message, created);
    const unroutedAfter = await board
      .unroutedCount()
      .then((u) => u.unroutedCount)
      .catch(() => undefined);
    if (this.run?.summary) this.patch({ summary: { ...this.run.summary, unroutedAfter } });
    const s = this.run?.summary;
    if (s) this.log(`Autoroute (${s.router}): ${s.routed}/${s.total} connections, ${s.tracks} tracks, ${s.vias} vias in ${s.wallMs} ms${s.timedOut ? ' (timed out)' : ''}`);
  }

  // ------------------------------------------------------------------ history

  private copperIds(): string[] {
    const store = this.docs.board();
    if (!store) return [];
    const out: string[] = [];
    for (const t of COPPER_TYPES) for (const it of store.byType(t)) out.push(it.id);
    return out;
  }

  /** Client-side history entry so the app's own undo (pre-11.0 servers) can take the pass back. */
  private recordHistory(message: string, ids: string[]): void {
    const store = this.docs.board();
    if (!store) return;
    const forward: ItemOp[] = [];
    const inverse: ItemOp[] = [];
    for (const id of ids) {
      const item = store.get(id);
      if (!item) continue;
      forward.push({ kind: 'create', item });
      inverse.push({ kind: 'delete', item });
    }
    if (forward.length) this.commands.record(store, message, forward, inverse);
  }
}
