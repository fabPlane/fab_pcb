// The pure half of the autoroute service: the dialog's request turned into the bridge job's
// body, the bridge's SSE stream parsed, and its events folded into an `AutorouteRun`. No I/O,
// so it is unit-tested on hand-written events (test/autoroute.test.ts); the service in
// `kicad/KicadAutorouteService.ts` does the fetching and the in-tab routing.

import type { AutorouteProgress, AutorouteRequest, AutorouteRun, AutorouteState, AutorouteSummary } from './extras';

/** `RouteJobRequest` of `@kicad-web/router/bridge-job` (kept structural so the app compiles without the node-only module). */
export interface BridgeRouteJobRequest {
  router: 'js' | 'freerouting';
  options?: { layers?: number[]; viaCost?: number; maxTimeMs?: number; nets?: string[]; effort?: number };
  freerouting?: { passes?: number };
  refillZones?: boolean;
}

/** `RouteJobInfo` as the bridge streams it (the fields the app reads). */
export interface BridgeRouteJobInfo {
  id: string;
  router: string;
  state: 'queued' | 'saving' | 'filling' | 'extracting' | 'routing' | 'applying' | 'done' | 'failed' | 'cancelled';
  progress?: AutorouteProgress;
  log?: string[];
  summary?: Omit<AutorouteSummary, 'router' | 'unroutedAfter'>;
  error?: string;
}

/** `BL_F_Cu` -> the kiapi BoardLayer value, for the job body. */
export function layerIdToEnum(id: string, table: Record<string, number | undefined>): number | undefined {
  const v = table[id];
  return typeof v === 'number' ? v : undefined;
}

/** The dialog's request as the bridge job body. `layerTable` is the proto `BoardLayer` enum. */
export function buildJobRequest(req: AutorouteRequest, layerTable: Record<string, number | undefined>): BridgeRouteJobRequest {
  const layers = req.layers?.map((l) => layerIdToEnum(l, layerTable)).filter((v): v is number => v !== undefined);
  const options: NonNullable<BridgeRouteJobRequest['options']> = {};
  if (layers?.length) options.layers = layers;
  if (req.nets?.length) options.nets = req.nets;
  if (req.viaCost !== undefined && req.viaCost !== 1) options.viaCost = req.viaCost;
  if (req.timeLimitMs && req.timeLimitMs > 0) options.maxTimeMs = req.timeLimitMs;
  if (req.passes !== undefined) options.effort = req.passes;
  const body: BridgeRouteJobRequest = { router: req.router === 'freerouting' ? 'freerouting' : 'js', options };
  if (req.router === 'freerouting' && req.passes !== undefined) body.freerouting = { passes: req.passes };
  if (req.refillZones === false) body.refillZones = false;
  return body;
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser: feed chunks, get complete events (`event:` + `data:` lines, blank-line
 * terminated; comment lines such as the bridge's `: keepalive` are dropped).
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Whatever a stream left without a terminating blank line. */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    const ev = rest.trim() ? parseSseBlock(rest) : null;
    return ev ? [ev] : [];
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

export const AUTOROUTE_LOG_TAIL = 60;

export function appendLog(log: string[], lines: readonly string[]): string[] {
  const next = [...log, ...lines];
  return next.length > AUTOROUTE_LOG_TAIL ? next.slice(next.length - AUTOROUTE_LOG_TAIL) : next;
}

/** Folds one bridge SSE event into the run; returns the updated copy (the run is immutable for React). */
export function applyBridgeEvent(run: AutorouteRun, ev: SseEvent, now = Date.now()): AutorouteRun {
  let data: Partial<BridgeRouteJobInfo> & { state?: BridgeRouteJobInfo['state']; progress?: AutorouteProgress; log?: string[] };
  try {
    data = JSON.parse(ev.data) as typeof data;
  } catch {
    return { ...run, log: appendLog(run.log, [`unreadable event from the bridge: ${ev.data.slice(0, 120)}`]) };
  }
  const state = data.state ? bridgeState(data.state) : run.state;
  const log = data.log ? [...data.log] : run.log;
  if (ev.event === 'done') {
    const s = data.summary;
    return {
      ...run,
      state: 'done',
      finishedAt: now,
      progress: data.progress ?? run.progress,
      log: s?.log ?? log,
      summary: s ? { ...s, router: data.router ?? run.summary?.router ?? run.request.router } : run.summary,
    };
  }
  if (ev.event === 'error') {
    return { ...run, state: state === 'cancelled' ? 'cancelled' : 'failed', finishedAt: now, error: data.error ?? 'routing failed', log };
  }
  // `state` (first event) and `progress`
  const next: AutorouteRun = { ...run, state, log };
  if (data.progress) next.progress = data.progress;
  if (ev.event === 'state' && (data.state === 'done' || data.state === 'failed' || data.state === 'cancelled')) {
    // a finished job re-read after a reconnect
    next.finishedAt = now;
    if (data.summary) next.summary = { ...data.summary, router: data.router ?? run.request.router };
    if (data.error) next.error = data.error;
    if (data.summary?.log) next.log = data.summary.log;
  }
  return next;
}

export function bridgeState(s: BridgeRouteJobInfo['state']): AutorouteState {
  return s === 'queued' ? 'starting' : s;
}

export const FINISHED_STATES: ReadonlySet<AutorouteState> = new Set<AutorouteState>(['done', 'failed', 'cancelled']);

export function isFinished(run: AutorouteRun | null | undefined): boolean {
  return !!run && FINISHED_STATES.has(run.state);
}

/** `Autoroute (js): 84 connections` — the commit message, shared with the bridge job. */
export function autorouteMessage(router: 'js' | 'freerouting', routed: number): string {
  return `Autoroute (${router}): ${routed} connection${routed === 1 ? '' : 's'}`;
}

/** Camera target for an airline: centre and a zoom (px per nm) that shows it with room around it. */
export function airlineCamera(c: { from: { x: number; y: number }; to: { x: number; y: number } }, viewportPx: { width: number; height: number }): { x: number; y: number; zoom: number } {
  const len = Math.max(Math.hypot(c.to.x - c.from.x, c.to.y - c.from.y), 2_000_000);
  const span = Math.max(Math.abs(c.to.x - c.from.x), Math.abs(c.to.y - c.from.y), len * 0.6);
  const px = Math.max(Math.min(viewportPx.width, viewportPx.height), 100);
  return { x: (c.from.x + c.to.x) / 2, y: (c.from.y + c.to.y) / 2, zoom: (px * 0.55) / span };
}

/**
 * A run that routed nothing is a failure, not a "done" with zeros: the JS router's retries swallow
 * its precheck errors into `log` and return an empty result. Returns the reason to report, or null
 * when something was routed (or there was nothing to route).
 */
export function emptyResultReason(r: {
  totalConnections: number;
  tracks: { length: number };
  vias: { length: number };
  unrouted: { length: number };
  timedOut: boolean;
  log: string[];
}): string | null {
  if (r.totalConnections === 0 || r.tracks.length || r.vias.length || r.unrouted.length < r.totalConnections) return null;
  const why = [...r.log].reverse().find((l) => /solver failed|precheck|timed out|exited with|no session|ran out of/i.test(l));
  if (r.timedOut) return `timed out with nothing routed${why ? ` (${why})` : ''}`;
  return why ? `the router routed nothing: ${why}` : 'the router returned no tracks or vias';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s.toString().padStart(2, '0')} s`;
}
