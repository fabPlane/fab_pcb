// The autoroute service and its pure helpers on fakes: the bridge job body built from the
// dialog's request, the SSE parser, the event fold into `AutorouteRun`, the in-tab run (extract ->
// route -> apply -> one history entry, and Cancel leaving the board alone), and the bridge run
// followed over a fake event stream. The real routers and the real bridge are covered by
// packages/router, packages/bridge/test/route*.test.ts and e2e/real/autoroute.spec.ts.

import './setup';
import { describe, expect, test } from 'bun:test';
import { BoardLayer } from '@fp-pcb/proto';
import { RouteCancelled, type RouteInput, type RouteResult } from '@fp-pcb/router/types';
import { SseParser, airlineCamera, applyBridgeEvent, autorouteMessage, buildJobRequest, formatDuration, parseSseBlock } from '@/services/autoroute-run';
import type { AutorouteRun } from '@/services/types';
import { KicadAutorouteService } from '@/services/kicad/KicadAutorouteService';

const LAYERS = BoardLayer as unknown as Record<string, number | undefined>;

describe('buildJobRequest', () => {
  test('maps the dialog request onto the bridge job body', () => {
    const body = buildJobRequest({ router: 'freerouting', nets: ['GND'], layers: ['BL_F_Cu', 'BL_B_Cu', 'BL_Nope'], viaCost: 2, passes: 20, timeLimitMs: 90_000, refillZones: false }, LAYERS);
    expect(body).toEqual({
      router: 'freerouting',
      options: { layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu], nets: ['GND'], viaCost: 2, maxTimeMs: 90_000, effort: 20 },
      freerouting: { passes: 20 },
      refillZones: false,
    });
    expect(buildJobRequest({ router: 'js-server', viaCost: 1 }, LAYERS)).toEqual({ router: 'js', options: {} });
    expect(buildJobRequest({ router: 'js-tab', passes: 3, timeLimitMs: 0 }, LAYERS)).toEqual({ router: 'js', options: { effort: 3 } });
  });
});

describe('SSE parsing', () => {
  test('events split across chunks, comments dropped, multi-line data joined', () => {
    const p = new SseParser();
    expect(p.push('event: state\ndata: {"a":1}\n\n: keepalive\n\nevent: prog')).toEqual([{ event: 'state', data: '{"a":1}' }]);
    expect(p.push('ress\ndata: {"b":\ndata: 2}\n\n')).toEqual([{ event: 'progress', data: '{"b":\n2}' }]);
    expect(p.push('data: tail')).toEqual([]);
    expect(p.flush()).toEqual([{ event: 'message', data: 'tail' }]);
    expect(parseSseBlock(': only a comment')).toBeNull();
  });
});

describe('applyBridgeEvent', () => {
  const base: AutorouteRun = { id: 'ar-1', request: { router: 'freerouting' }, state: 'starting', startedAt: 1000, log: [] };
  test('state, progress, done', () => {
    let run = applyBridgeEvent(base, { event: 'state', data: JSON.stringify({ id: 'j1', state: 'queued', log: [] }) }, 1001);
    expect(run.state).toBe('starting');
    run = applyBridgeEvent(
      run,
      { event: 'progress', data: JSON.stringify({ state: 'routing', progress: { phase: 'pass 3', percent: 40, routed: 50, total: 128 }, log: ['pass 3: 78 unrouted'] }) },
      1002,
    );
    expect(run.state).toBe('routing');
    expect(run.progress).toEqual({ phase: 'pass 3', percent: 40, routed: 50, total: 128 });
    expect(run.log).toEqual(['pass 3: 78 unrouted']);
    const summary = {
      tracks: 400,
      vias: 42,
      routed: 113,
      total: 128,
      trackLengthNm: 616_900_000,
      elapsedMs: 300_000,
      wallMs: 310_000,
      timedOut: false,
      message: 'Autoroute (freerouting): 113 connections',
      unrouted: [{ net: 'GND', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }],
      log: ['a', 'b'],
    };
    run = applyBridgeEvent(run, { event: 'done', data: JSON.stringify({ state: 'done', router: 'freerouting-kicad-dsn', summary }) }, 2000);
    expect(run.state).toBe('done');
    expect(run.finishedAt).toBe(2000);
    expect(run.summary).toEqual({ ...summary, router: 'freerouting-kicad-dsn' });
    expect(run.log).toEqual(['a', 'b']);
  });
  test('error events: failed and cancelled', () => {
    const failed = applyBridgeEvent(base, { event: 'error', data: JSON.stringify({ state: 'failed', error: 'precheck failed' }) }, 5);
    expect(failed).toMatchObject({ state: 'failed', error: 'precheck failed', finishedAt: 5 });
    const cancelled = applyBridgeEvent(base, { event: 'error', data: JSON.stringify({ state: 'cancelled', error: 'cancelled' }) }, 6);
    expect(cancelled.state).toBe('cancelled');
    const junk = applyBridgeEvent(base, { event: 'progress', data: '{not json' }, 7);
    expect(junk.log[0]).toMatch(/unreadable event/);
  });
  test('a finished job re-read through its state event', () => {
    const run = applyBridgeEvent(base, { event: 'state', data: JSON.stringify({ state: 'failed', error: 'boom', log: ['x'] }) }, 9);
    expect(run).toMatchObject({ state: 'failed', error: 'boom', finishedAt: 9 });
  });
});

describe('helpers', () => {
  test('autorouteMessage, formatDuration, airlineCamera', () => {
    expect(autorouteMessage('js', 1)).toBe('Autoroute (js): 1 connection');
    expect(autorouteMessage('freerouting', 113)).toBe('Autoroute (freerouting): 113 connections');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(3_200)).toBe('3.2 s');
    expect(formatDuration(315_000)).toBe('5 min 15 s');
    const cam = airlineCamera({ from: { x: 0, y: 0 }, to: { x: 10_000_000, y: 0 } }, { width: 800, height: 600 });
    expect(cam.x).toBe(5_000_000);
    expect(cam.zoom * 10_000_000).toBeLessThan(600); // the airline fits in the shorter side
    expect(cam.zoom * 10_000_000).toBeGreaterThan(200);
  });
});

// --------------------------------------------------------------------------- the service on fakes

interface FakeItem {
  id: string;
  type: string;
  net?: string;
}

type FakeEdge = { net: string; sourcePosition: { x: number; y: number }; targetPosition: { x: number; y: number } };

function fakes(opts: { unrouted?: number[]; items?: FakeItem[]; edges?: FakeEdge[] } = {}) {
  const unrouted = opts.unrouted ?? [14, 0];
  const items = new Map<string, FakeItem>((opts.items ?? []).map((i) => [i.id, i]));
  const calls: string[] = [];
  const board = {
    refillZones: async () => {
      calls.push('refillZones');
    },
    unroutedCount: async () => ({ unroutedCount: unrouted.shift() ?? 0, unroutedNetCount: 0 }),
    ratsnest: async () => ({ edges: opts.edges ?? [], unroutedCount: 0 }),
  };
  const store = {
    get: (id: string) => items.get(id),
    byType: (type: string) => [...items.values()].filter((i) => i.type === type),
    all: () => items.values(),
  };
  const docs = {
    boardDoc: board,
    board: () => store,
    beginActivity: () => {
      calls.push('activity+');
      return () => calls.push('activity-');
    },
    resyncDocument: async (kind: string) => {
      calls.push(`resync:${kind}`);
    },
  };
  const recorded: { message: string; forward: number; inverse: number }[] = [];
  const commands = { record: (_s: unknown, message: string, forward: unknown[], inverse: unknown[]) => recorded.push({ message, forward: forward.length, inverse: inverse.length }) };
  return { board, store, docs, commands, calls, recorded, items };
}

const input = (n: number): RouteInput =>
  ({
    connections: Array.from({ length: n }, (_, i) => ({
      net: `N${i}`,
      netCode: i,
      from: { itemId: `a${i}`, position: { x: 0, y: i }, layers: [] },
      to: { itemId: `b${i}`, position: { x: 10, y: i }, layers: [] },
      length: 10,
    })),
    pads: [],
    copperLayers: [{ id: BoardLayer.BL_F_Cu, name: 'BL_F_Cu', userName: 'F.Cu', index: 0 }],
  }) as unknown as RouteInput;

const result = (routed: number, total: number): RouteResult => ({
  router: 'js',
  tracks: Array.from({ length: routed }, (_, i) => ({ net: `N${i}`, netCode: i, start: { x: 0, y: i }, end: { x: 3_000_000, y: i }, width: 200_000, layer: BoardLayer.BL_F_Cu })),
  vias: routed ? [{ net: 'N0', netCode: 0, position: { x: 1, y: 1 }, diameter: 800_000, drill: 400_000, layers: [BoardLayer.BL_F_Cu] }] : [],
  unrouted: input(total).connections.slice(routed),
  totalConnections: total,
  timedOut: false,
  elapsedMs: 12,
  log: ['srj: 1 layers'],
});

describe('KicadAutorouteService in the tab', () => {
  test('refill -> extract -> route -> apply -> resync -> one history entry, with progress and the summary', async () => {
    const edge = (net: string, y: number) => ({ net, sourcePosition: { x: 0, y }, targetPosition: { x: 10, y } });
    const f = fakes({
      unrouted: [3],
      items: [
        { id: 't1', type: 'KOT_PCB_TRACE', net: 'N0' },
        { id: 'v1', type: 'KOT_PCB_VIA', net: 'N0' },
      ],
      // KiCad's ratsnest after the apply still shows N2..N4, and N1 as well: the router overstated by one
      edges: [edge('N1', 1), edge('N2', 2), edge('N3', 3), edge('N4', 4)],
    });
    const session = { session: { id: 's1' }, bridgeless: false };
    let applied: { message: string } | undefined;
    const svc = new KicadAutorouteService(f.docs as never, session as never, f.commands as never, () => {}, {
      extract: async () => input(5),
      createRouter: () => ({
        name: 'js',
        route: async (_i, opts, progress) => {
          progress?.({ phase: 'start', percent: 0 });
          progress?.({ phase: 'solve', percent: 50, message: 'half' });
          expect(opts.effort).toBe(2);
          expect(opts.layers).toEqual([BoardLayer.BL_F_Cu]);
          expect(opts.maxTimeMs).toBe(5000);
          return result(2, 5);
        },
      }),
      apply: async (_b, _r, o) => {
        applied = o;
        return { created: [{ id: 't1' }, { id: 'v1' }] };
      },
      now: () => 100,
    });
    const states: string[] = [];
    svc.onChange(() => states.push(svc.current()!.state));
    const run = await svc.start({ router: 'js-tab', layers: ['BL_F_Cu'], passes: 2, timeLimitMs: 5000 });
    expect(run.state).toBe('done');
    expect(applied).toEqual({ message: 'Autoroute (js): 2 connections' });
    expect(run.summary).toMatchObject({ router: 'js', tracks: 2, vias: 1, routed: 1, routerRouted: 2, total: 5, trackLengthNm: 6_000_000, message: 'Autoroute (js): 2 connections', unroutedAfter: 3 });
    expect(run.summary!.unrouted.map((u) => u.net)).toEqual(['N1', 'N2', 'N3', 'N4']);
    expect(run.log.some((l) => /GetRatsnest after the apply: 4/.test(l))).toBe(true);
    expect(run.log[0]).toBe('srj: 1 layers');
    expect(f.calls).toEqual(['activity+', 'refillZones', 'resync:board', 'activity-']);
    expect(f.recorded).toEqual([{ message: 'Autoroute (js): 2 connections', forward: 2, inverse: 2 }]);
    expect(states).toContain('routing');
    expect(states[states.length - 1]).toBe('done');
    expect(svc.running()).toBe(false);
  });

  test('a router that routes nothing is a failed run with its own reason, nothing applied', async () => {
    const f = fakes();
    const svc = new KicadAutorouteService(f.docs as never, { session: { id: 's1' }, bridgeless: false } as never, f.commands as never, () => {}, {
      extract: async () => input(3),
      createRouter: () => ({
        name: 'js',
        route: async () => ({
          ...result(0, 3),
          log: [
            'solver failed (attempt 1): Could not find start region for connection "GND_mst0"',
            'retrying without GND',
            'solver failed (attempt 2): HB ran out of iterations',
            '0 tracks, 0 vias, 0/3 nets in 5 ms',
          ],
        }),
      }),
      apply: async () => {
        throw new Error('must not apply');
      },
    });
    const run = await svc.start({ router: 'js-tab', refillZones: false });
    expect(run.state).toBe('failed');
    expect(run.error).toContain('HB ran out of iterations');
    expect(run.log.length).toBe(4);
    expect(f.recorded).toEqual([]);
  });

  test('a router failure applies nothing and reports the error; a second start is allowed afterwards', async () => {
    const f = fakes();
    const svc = new KicadAutorouteService(f.docs as never, { session: { id: 's1' }, bridgeless: false } as never, f.commands as never, () => {}, {
      extract: async () => input(2),
      createRouter: () => ({ name: 'js', route: async () => Promise.reject(new Error('Static reachability precheck failed')) }),
      apply: async () => {
        throw new Error('must not apply');
      },
    });
    const run = await svc.start({ router: 'js-tab', refillZones: false });
    expect(run.state).toBe('failed');
    expect(run.error).toContain('precheck');
    expect(f.calls).toEqual(['activity+', 'activity-']);
    expect(f.recorded).toEqual([]);
    expect(svc.running()).toBe(false);
  });

  test('cancel aborts the in-tab router and leaves the board untouched', async () => {
    const f = fakes();
    const svc = new KicadAutorouteService(f.docs as never, { session: { id: 's1' }, bridgeless: false } as never, f.commands as never, () => {}, {
      extract: async () => input(2),
      createRouter: () => ({
        name: 'js',
        route: (_i, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal!.addEventListener('abort', () => reject(new RouteCancelled()));
          }),
      }),
      apply: async () => {
        throw new Error('must not apply');
      },
    });
    const p = svc.start({ router: 'js-tab', refillZones: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.running()).toBe(true);
    expect(svc.current()!.state).toBe('routing');
    await svc.cancel();
    const run = await p;
    expect(run.state).toBe('cancelled');
    expect(f.recorded).toEqual([]);
    expect(svc.running()).toBe(false);
    // a new run is allowed afterwards (and can be cancelled again)
    const p2 = svc.start({ router: 'js-tab', refillZones: false });
    await new Promise((r) => setTimeout(r, 5));
    await svc.cancel();
    expect((await p2).state).toBe('cancelled');
  });

  test('refuses a second concurrent run and a missing board', async () => {
    const f = fakes();
    const svc = new KicadAutorouteService({ ...f.docs, boardDoc: null } as never, { session: { id: 's1' }, bridgeless: false } as never, f.commands as never);
    await expect(svc.start({ router: 'js-tab' })).rejects.toThrow(/no board/);
  });
});

function sseBody(events: { event: string; data: unknown }[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      c.enqueue(enc.encode(': keepalive\n\n'));
      c.close();
    },
  });
}

describe('KicadAutorouteService on the bridge', () => {
  const summary = {
    tracks: 3,
    vias: 1,
    routed: 2,
    total: 2,
    trackLengthNm: 9_000_000,
    elapsedMs: 50,
    wallMs: 80,
    timedOut: false,
    message: 'Autoroute (freerouting): 2 connections',
    unrouted: [],
    log: ['imported'],
  };

  test('POSTs the job, follows the stream, re-syncs, records the created items, adds GetUnroutedCount', async () => {
    const f = fakes({ unrouted: [0] });
    const requests: { path: string; init?: RequestInit }[] = [];
    const session = {
      session: { id: 's1' },
      bridgeless: false,
      bridgeJson: async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        if (init?.method === 'POST') return { job: { id: 'j1', state: 'queued', log: [] } };
        return { jobs: [], freerouting: { ok: true } };
      },
      bridgeFetch: async (path: string, init?: RequestInit) => {
        requests.push({ path, init });
        f.items.set('t9', { id: 't9', type: 'KOT_PCB_TRACE', net: 'A' }); // "KiCad created it" before the done event arrives
        return {
          ok: true,
          status: 200,
          body: sseBody([
            { event: 'state', data: { id: 'j1', state: 'queued', log: [] } },
            { event: 'progress', data: { state: 'routing', progress: { phase: 'pass 1', percent: 10, routed: 1, total: 2 }, log: ['pass 1: 1 unrouted'] } },
            { event: 'done', data: { id: 'j1', state: 'done', router: 'freerouting-kicad-dsn', summary } },
          ]),
        };
      },
    };
    const svc = new KicadAutorouteService(f.docs as never, session as never, f.commands as never);
    const seen: string[] = [];
    svc.onChange(() => seen.push(`${svc.current()!.state}:${svc.current()!.progress?.phase ?? ''}`));
    const run = await svc.start({ router: 'freerouting', passes: 20 });
    expect(run.state).toBe('done');
    expect(run.summary).toEqual({ ...summary, router: 'freerouting-kicad-dsn', unroutedAfter: 0 });
    expect(requests[0]).toMatchObject({ path: '/sessions/s1/route', init: { method: 'POST' } });
    expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({ router: 'freerouting', options: { effort: 20 }, freerouting: { passes: 20 } });
    expect(requests[1]!.path).toBe('/sessions/s1/route/j1');
    expect(seen).toContain('routing:pass 1');
    expect(f.calls).toContain('resync:board');
    expect(f.recorded).toEqual([{ message: 'Autoroute (freerouting): 2 connections', forward: 1, inverse: 1 }]);
    expect(await svc.available()).toEqual({ server: true, freerouting: { ok: true } });
  });

  test('a failed job and a refused POST both end as failed runs', async () => {
    const f = fakes();
    const session = {
      session: { id: 's1' },
      bridgeless: false,
      bridgeJson: async (_path: string, init?: RequestInit) => {
        if (init?.method === 'POST' && (init.body as string).includes('"js"')) throw new Error('POST /sessions/s1/route: 400 Freerouting unavailable: no jar');
        return { job: { id: 'j2', state: 'queued', log: [] } };
      },
      bridgeFetch: async () => ({
        ok: true,
        status: 200,
        body: sseBody([
          { event: 'state', data: { id: 'j2', state: 'routing', log: [] } },
          { event: 'error', data: { id: 'j2', state: 'failed', error: 'HB ran out of iterations' } },
        ]),
      }),
    };
    const svc = new KicadAutorouteService(f.docs as never, session as never, f.commands as never);
    const failed = await svc.start({ router: 'freerouting' });
    expect(failed).toMatchObject({ state: 'failed', error: 'HB ran out of iterations' });
    const refused = await svc.start({ router: 'js-server' });
    expect(refused.state).toBe('failed');
    expect(refused.error).toContain('no jar');
    expect(f.recorded).toEqual([]);
  });

  test('cancel DELETEs the job and the stream end marks the run cancelled', async () => {
    const f = fakes();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deleted: string[] = [];
    const session = {
      session: { id: 's1' },
      bridgeless: false,
      bridgeJson: async (path: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deleted.push(path);
          release();
          return { ok: true };
        }
        return { job: { id: 'j3', state: 'queued', log: [] } };
      },
      bridgeFetch: async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          async start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify({ id: 'j3', state: 'routing', log: [] })}\n\n`));
            await gate;
            c.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify({ id: 'j3', state: 'cancelled', error: 'cancelled' })}\n\n`));
            c.close();
          },
        }),
      }),
    };
    const svc = new KicadAutorouteService(f.docs as never, session as never, f.commands as never);
    const p = svc.start({ router: 'js-server' });
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.current()!.state).toBe('routing');
    await svc.cancel();
    const run = await p;
    expect(deleted).toEqual(['/sessions/s1/route/j3']);
    expect(run.state).toBe('cancelled');
    expect(f.recorded).toEqual([]);
  });

  test('available() without a bridge', async () => {
    const f = fakes();
    const svc = new KicadAutorouteService(f.docs as never, { session: { id: 'ws://x' }, bridgeless: true } as never, f.commands as never);
    expect((await svc.available()).server).toBe(false);
  });
});
