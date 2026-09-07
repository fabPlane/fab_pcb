/**
 * `JsRouter`: the JavaScript autorouter, `@tscircuit/capacity-autorouter` (MIT), driven through
 * its generic `SimpleRouteJson` input. Runs in Bun and in the browser (pure JS, no workers
 * required; the step loop yields to the event loop so a page stays responsive).
 *
 * What is approximated when a `RouteInput` becomes `SimpleRouteJson` (the solver only knows
 * axis-aligned rectangles):
 * - pads are their rotated bounding box (a circle becomes its square; a 45° rectangle grows);
 * - existing tracks are the bounding box of the segment inflated by half its width (diagonal
 *   tracks block a larger area than they cover);
 * - rule areas are their bounding box;
 * - copper zones are ignored as obstacles (the solver is not zone-aware; the bench refills zones
 *   afterwards and lets DRC judge);
 * - a via always spans every routed layer (a through via), even when the solver only changed
 *   between two inner layers.
 * Every approximation is conservative (blocks more than it should) except the zone one.
 */
import { BoardLayer } from "@kicad-web/proto";
import { mm, toMm, type Vec2 } from "@kicad-web/client";
import { AutoroutingPipelineSolver } from "@tscircuit/capacity-autorouter";
import { isAxisAligned, polygonBounds, rotatedRectBounds } from "./geometry";
import { copperLayersInOrder, rulesForNet } from "./extract";
import type { Autorouter, NewTrack, NewVia, RouteConnection, RouteInput, RouteOptions, RouteProgress, RouteResult } from "./types";

/** The parts of `SimpleRouteJson` we produce (mirrors the solver's type; kept local so the contract is visible here). */
export interface SimpleRouteJson {
  layerCount: number;
  minTraceWidth: number;
  nominalTraceWidth?: number;
  minViaPadDiameter?: number;
  minViaHoleDiameter?: number;
  defaultObstacleMargin?: number;
  minTraceToPadEdgeClearance?: number;
  minBoardEdgeClearance?: number;
  obstacles: SrjObstacle[];
  connections: SrjConnection[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  outline?: { x: number; y: number }[];
}

export interface SrjObstacle {
  obstacleId?: string;
  type: "rect";
  layers: string[];
  center: { x: number; y: number };
  width: number;
  height: number;
  connectedTo: string[];
}

export type SrjPoint =
  | { x: number; y: number; layer: string; pointId?: string }
  | { x: number; y: number; layers: string[]; pointId?: string };

export interface SrjConnection {
  name: string;
  nominalTraceWidth?: number;
  pointsToConnect: SrjPoint[];
}

export interface SrjWire {
  route_type: "wire";
  x: number;
  y: number;
  width: number;
  layer: string;
}
export interface SrjVia {
  route_type: "via";
  x: number;
  y: number;
  from_layer: string;
  to_layer: string;
}
export interface SrjTrace {
  connection_name: string;
  route: (SrjWire | SrjVia | { route_type: string })[];
}

/** Bidirectional map between the board's copper layers and the solver's `top`/`inner<n>`/`bottom` names. */
export class LayerNames {
  readonly layers: BoardLayer[];
  private readonly byLayer = new Map<BoardLayer, string>();
  private readonly byName = new Map<string, BoardLayer>();

  constructor(layers: readonly BoardLayer[]) {
    this.layers = copperLayersInOrder(layers);
    this.layers.forEach((l, i) => {
      const name = i === 0 ? "top" : i === this.layers.length - 1 ? "bottom" : `inner${i}`;
      this.byLayer.set(l, name);
      this.byName.set(name, l);
    });
  }
  get count(): number {
    return this.layers.length;
  }
  name(l: BoardLayer): string | undefined {
    return this.byLayer.get(l);
  }
  names(ls: readonly BoardLayer[]): string[] {
    return ls.map((l) => this.byLayer.get(l)).filter((n): n is string => n !== undefined);
  }
  layer(name: string): BoardLayer | undefined {
    return this.byName.get(name);
  }
}

const p = (v: Vec2) => ({ x: toMm(v.x), y: toMm(v.y) });

/** Builds the solver input. Pure; unit-tested on hand-written `RouteInput`s. */
export function buildSimpleRouteJson(
  input: RouteInput,
  opts: RouteOptions = {},
): { srj: SimpleRouteJson; layers: LayerNames; notes: string[] } {
  const notes: string[] = [];
  const layers = new LayerNames(opts.layers ?? input.copperLayers.map((l) => l.id));
  if (layers.count === 0) throw new Error("no copper layers to route on");
  const rules = input.rules.default;
  const extra = (opts.extra ?? {}) as {
    obstacleInflate?: number;
    obstacleMargin?: number;
    viaInflate?: number;
    traceInflate?: number;
    safety?: number;
  };
  // The solver lands trace centrelines up to ~20 µm inside an obstacle rectangle; `safety` covers that.
  const safety = extra.safety ?? mm(0.05);
  // Every obstacle grows by `inflate` on each side (nm) and the solver keeps trace centrelines
  // `margin` (nm) away from the inflated edge. Measured on the practice boards: the solver honours
  // the rectangles strictly but `defaultObstacleMargin` only loosely (traces cut corners), so the
  // default puts the whole clearance + half track width into the rectangle and leaves a token
  // margin. Override through `opts.extra.obstacleInflate` / `opts.extra.obstacleMargin` (nm).
  const inflate = (extra.obstacleInflate ?? rules.clearance + rules.trackWidth / 2) + safety;
  const margin = extra.obstacleMargin ?? mm(0.01);
  const obstacles: SrjObstacle[] = [];
  const rect = (id: string, box: { x: number; y: number; w: number; h: number }, ls: string[], net: string): SrjObstacle | undefined =>
    ls.length
      ? {
          obstacleId: id,
          type: "rect",
          layers: ls,
          center: { x: toMm(box.x + box.w / 2), y: toMm(box.y + box.h / 2) },
          width: toMm(box.w + 2 * inflate),
          height: toMm(box.h + 2 * inflate),
          connectedTo: net ? [net] : [],
        }
      : undefined;

  let rotatedPads = 0;
  for (const pad of input.pads) {
    const ls = layers.names(pad.layers);
    if (!ls.length) continue;
    let box;
    if (pad.bounds) {
      box = pad.bounds;
    } else if (isAxisAligned(pad.rotation)) {
      const swap = Math.round(((pad.rotation % 180) + 180) % 180) === 90;
      const w = swap ? pad.size.y : pad.size.x;
      const h = swap ? pad.size.x : pad.size.y;
      box = { x: pad.position.x - w / 2, y: pad.position.y - h / 2, w, h };
    } else {
      rotatedPads++;
      box = rotatedRectBounds(pad.position, pad.size, pad.rotation);
    }
    if (pad.drill && (box.w < pad.drill || box.h < pad.drill))
      box = { x: pad.position.x - pad.drill / 2, y: pad.position.y - pad.drill / 2, w: pad.drill, h: pad.drill };
    const o = rect(pad.id, box, ls, pad.net);
    if (o) obstacles.push(o);
  }
  if (rotatedPads) notes.push(`${rotatedPads} pads at non-90° rotations are modelled by their bounding box`);

  let diagonal = 0;
  for (const t of input.tracks) {
    const name = layers.name(t.layer);
    if (!name) continue;
    if (t.start.x !== t.end.x && t.start.y !== t.end.y) diagonal++;
    const half = t.width / 2;
    const box = {
      x: Math.min(t.start.x, t.end.x) - half,
      y: Math.min(t.start.y, t.end.y) - half,
      w: Math.abs(t.end.x - t.start.x) + t.width,
      h: Math.abs(t.end.y - t.start.y) + t.width,
    };
    const o = rect(t.id, box, [name], t.net);
    if (o) obstacles.push(o);
  }
  if (diagonal) notes.push(`${diagonal} existing diagonal tracks are modelled by their bounding box`);

  for (const v of input.vias) {
    const box = { x: v.position.x - v.diameter / 2, y: v.position.y - v.diameter / 2, w: v.diameter, h: v.diameter };
    const o = rect(v.id, box, layers.names(v.layers), v.net);
    if (o) obstacles.push(o);
  }

  for (const k of input.keepouts) {
    if (!k.tracks && !k.copper) continue;
    const o = rect(k.id, polygonBounds(k.polygon), layers.names(k.layers.length ? k.layers : layers.layers), "");
    if (o) obstacles.push(o);
  }
  if (input.keepouts.length) notes.push(`${input.keepouts.length} rule areas are modelled by their bounding box`);

  for (const g of input.obstacles) {
    const o = rect(g.id, g.bounds, layers.names(g.layers), g.net);
    if (o) obstacles.push(o);
  }
  if (input.zones.length) notes.push(`${input.zones.length} copper zones are not obstacles for the JS router`);

  // Connections: one per net, the distinct endpoints of its ratsnest edges.
  const byNet = new Map<string, Map<string, SrjPoint>>();
  for (const c of input.connections) {
    let pts = byNet.get(c.net);
    if (!pts) byNet.set(c.net, (pts = new Map()));
    for (const e of [c.from, c.to]) {
      if (pts.has(e.itemId)) continue;
      const ls = layers.names(e.layers);
      if (!ls.length) continue;
      const base = { ...p(e.position), pointId: e.itemId };
      pts.set(e.itemId, ls.length === 1 ? { ...base, layer: ls[0]! } : { ...base, layers: ls });
    }
  }
  const connections: SrjConnection[] = [];
  for (const [net, pts] of byNet) {
    if (pts.size < 2) continue;
    connections.push({
      name: net,
      nominalTraceWidth: toMm(rulesForNet(input, net).trackWidth + (extra.traceInflate ?? rules.clearance)),
      pointsToConnect: [...pts.values()],
    });
  }

  const b = input.bounds;
  const pad = rules.viaDiameter + rules.clearance;
  const srj: SimpleRouteJson = {
    layerCount: layers.count,
    // Likewise trace-to-trace spacing follows the trace width the solver believes in; routes are
    // written back at the net class width, so the surplus becomes clearance.
    minTraceWidth: toMm(Math.max(rules.trackWidth, input.rules.minTrackWidth) + (extra.traceInflate ?? rules.clearance)),
    nominalTraceWidth: toMm(rules.trackWidth + (extra.traceInflate ?? rules.clearance)),
    // The solver spaces other nets' traces from its vias by the via's own outline; telling it a
    // fatter via buys the clearance KiCad will check (the via is created at its real size).
    minViaPadDiameter: toMm(rules.viaDiameter + (extra.viaInflate ?? 2 * rules.clearance)),
    minViaHoleDiameter: toMm(rules.viaDrill),
    defaultObstacleMargin: toMm(margin),
    minTraceToPadEdgeClearance: toMm(margin),
    minBoardEdgeClearance: toMm(Math.max(input.rules.edgeClearance, rules.clearance)),
    obstacles,
    connections,
    bounds: { minX: toMm(b.x - pad), maxX: toMm(b.x + b.w + pad), minY: toMm(b.y - pad), maxY: toMm(b.y + b.h + pad) },
    outline: input.outline[0]?.map(p),
  };
  return { srj, layers, notes };
}

/** Converts the solver's traces back to board items (nm). */
export function tracesToItems(
  traces: readonly SrjTrace[],
  input: RouteInput,
  layers: LayerNames,
): { tracks: NewTrack[]; vias: NewVia[]; routedNets: Set<string> } {
  const codes = new Map(input.nets.map((n) => [n.name, n.code]));
  const tracks: NewTrack[] = [];
  const vias: NewVia[] = [];
  const routedNets = new Set<string>();
  for (const trace of traces) {
    const net = trace.connection_name;
    const netCode = codes.get(net) ?? 0;
    const rules = rulesForNet(input, net);
    let prev: SrjWire | undefined;
    let any = false;
    for (const step of trace.route) {
      if (step.route_type === "wire") {
        const w = step as SrjWire;
        const layer = layers.layer(w.layer);
        if (prev && layer !== undefined && prev.layer === w.layer) {
          const start = { x: mm(prev.x), y: mm(prev.y) };
          const end = { x: mm(w.x), y: mm(w.y) };
          if (start.x !== end.x || start.y !== end.y) {
            tracks.push({ net, netCode, start, end, width: rules.trackWidth, layer });
            any = true;
          }
        }
        prev = w;
      } else if (step.route_type === "via") {
        const v = step as SrjVia;
        vias.push({
          net,
          netCode,
          position: { x: mm(v.x), y: mm(v.y) },
          diameter: rules.viaDiameter,
          drill: rules.viaDrill,
          layers: [...layers.layers],
        });
        any = true;
        prev = undefined;
      } else {
        prev = undefined;
      }
    }
    if (any) routedNets.add(net);
  }
  return { tracks, vias, routedNets };
}

export interface JsRouterOptions {
  /** How often the step loop yields to the event loop (ms). Default 50. */
  yieldEveryMs?: number;
}

export class JsRouter implements Autorouter {
  readonly name = "js";

  constructor(private readonly jsOpts: JsRouterOptions = {}) {}

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async route(input: RouteInput, opts: RouteOptions = {}, progress?: (p: RouteProgress) => void): Promise<RouteResult> {
    const t0 = performance.now();
    const log: string[] = [];
    const { srj, layers, notes } = buildSimpleRouteJson(input, opts);
    log.push(...notes.map((n) => `note: ${n}`));
    if (opts.seed !== undefined) log.push("note: the capacity autorouter is deterministic; `seed` is ignored");
    if (opts.viaCost !== undefined) log.push("note: `viaCost` is not a capacity-autorouter parameter; ignored");
    log.push(`srj: ${srj.layerCount} layers, ${srj.obstacles.length} obstacles, ${srj.connections.length} nets to route`);

    const deadline = opts.maxTimeMs ? t0 + opts.maxTimeMs : Infinity;
    const yieldEvery = this.jsOpts.yieldEveryMs ?? 50;
    let timedOut = false;
    let lastPhase = "";
    let lastPercent = -1;
    progress?.({ phase: "start", percent: 0, total: input.connections.length });

    /** Steps one solver to completion, failure or the deadline; returns its traces (empty on failure). */
    const solve = async (srjIn: SimpleRouteJson): Promise<{ traces: SrjTrace[]; error?: string; iterations: number }> => {
      let solver: InstanceType<typeof AutoroutingPipelineSolver>;
      try {
        solver = new AutoroutingPipelineSolver(srjIn as never, { effort: opts.effort ?? 1 });
      } catch (e) {
        return { traces: [], error: e instanceof Error ? e.message : String(e), iterations: 0 };
      }
      let lastYield = performance.now();
      while (!solver.solved && !solver.failed) {
        try {
          solver.step();
        } catch (e) {
          // Some stages throw instead of setting `failed` ("Could not find start region for ...").
          return { traces: [], error: e instanceof Error ? e.message : String(e), iterations: solver.iterations };
        }
        const now = performance.now();
        const phase = solver.getCurrentPhase();
        const percent = Math.round((solver.progress ?? 0) * 100);
        if (phase !== lastPhase || percent !== lastPercent) {
          lastPhase = phase;
          lastPercent = percent;
          progress?.({ phase, percent });
        }
        if (now >= deadline) {
          timedOut = true;
          log.push(`timed out after ${Math.round(now - t0)} ms in phase ${phase}`);
          break;
        }
        if (now - lastYield >= yieldEvery) {
          await new Promise<void>((r) => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }
      if (solver.failed) return { traces: [], error: solver.error ?? "unknown error", iterations: solver.iterations };
      if (!solver.solved) return { traces: [], iterations: solver.iterations };
      try {
        return { traces: solver.getOutputSimplifiedPcbTraces() as unknown as SrjTrace[], iterations: solver.iterations };
      } catch (e) {
        return { traces: [], error: `no output traces: ${e instanceof Error ? e.message : String(e)}`, iterations: solver.iterations };
      }
    };

    // The pipeline is all-or-nothing: when its reachability precheck finds a net whose start point
    // is sealed in by obstacles (typically neighbouring pads whose inflated boxes touch), the whole
    // run fails. Retry with less inflation, then without the nets it names, so a dense connector
    // costs a few nets rather than the board. Everything dropped is reported as unrouted.
    const dropped = new Set<string>();
    let attempt = { srj, layers, notes };
    let iterations = 0;
    let traces: SrjTrace[] = [];
    const inflations: (number | undefined)[] = [undefined, input.rules.default.clearance, 0];
    for (let round = 0; round < 8 && !timedOut; round++) {
      const r = await solve(attempt.srj);
      iterations += r.iterations;
      if (!r.error) {
        traces = r.traces;
        break;
      }
      log.push(`solver failed (attempt ${round + 1}): ${r.error.slice(0, 300)}`);
      // Failure messages name connections as `<net>_mst<n>` ("GND_mst2 (id->id)", 'connection "GND_mst0"').
      const named = [...new Set([...r.error.matchAll(/"?([^\s"]+?)_mst\d+\b/g)].map((m) => m[1]!))].filter((n) =>
        attempt.srj.connections.some((c) => c.name === n),
      );
      const inflate = inflations[round + 1];
      if (round + 1 < inflations.length && !named.length) {
        log.push(`retrying with obstacle inflation ${inflate} nm`);
        attempt = buildSimpleRouteJson(input, { ...opts, extra: { ...opts.extra, obstacleInflate: inflate } });
      } else if (named.length) {
        for (const n of named) dropped.add(n);
        log.push(`retrying without ${named.join(", ")}`);
        const filtered: RouteInput = { ...input, connections: input.connections.filter((c) => !dropped.has(c.net)) };
        attempt = buildSimpleRouteJson(filtered, opts);
      } else break;
      if (attempt.srj.connections.length === 0) break;
    }
    if (dropped.size) log.push(`nets left unrouted after solver failures: ${[...dropped].join(", ")}`);

    const { tracks, vias, routedNets } = tracesToItems(traces, input, attempt.layers);
    const unrouted: RouteConnection[] = input.connections.filter((c) => !routedNets.has(c.net));
    const elapsedMs = Math.round(performance.now() - t0);
    log.push(
      `${tracks.length} tracks, ${vias.length} vias, ${routedNets.size}/${srj.connections.length} nets in ${elapsedMs} ms (${iterations} iterations)`,
    );
    progress?.({ phase: "done", percent: 100, routed: input.connections.length - unrouted.length, total: input.connections.length });
    return { router: this.name, tracks, vias, unrouted, totalConnections: input.connections.length, timedOut, elapsedMs, log };
  }
}
