/** Native server-side adapter for fabPlane/fab_router's text DSN/SES API. */
import { dsnLayers, extraViasFromRouteOptions, writeDsn } from "./specctra/dsn";
import { parseSes, sesToItems } from "./specctra/ses";
import {
  RouteCancelled,
  type Autorouter,
  type RouteConnection,
  type RouteInput,
  type RouteOptions,
  type RouteProgress,
  type RouteResult,
} from "./types";

export interface FabRouterSettings {
  maxPasses?: number;
  timeBudgetMs?: number;
  viaCost?: number;
  seed?: number;
}

export interface FabRouterReport {
  passes: number;
  attempted: number;
  completed: number;
  incompleteBefore: number;
  incompleteAfter: number;
  added: { tracks: number; barrels: number };
  violationsBefore: number;
  violationsAdded: number;
  timedOut: boolean;
  aborted: boolean;
  stoppedBy: string;
  wallClockMs: number;
  perNet: Array<{ net: string; incomplete: number }>;
  pairCapability?: "coupled";
  pairs?: import("./types").PairRouting["pairs"];
}

export interface FabRouterHooks {
  signal?: AbortSignal;
  onPass?(event: { pass: number; incomplete: number; elapsedMs: number }): void;
  onConnection?(event: { net: string; from: string; to: string; ok: boolean; elapsedMs: number }): void;
  onProgress?(event: { done: number; total: number; elapsedMs: number }): void;
  onLog?(level: "info" | "warn", message: string): void;
}

export type FabRouterTextResult =
  | {
      ok: true;
      ses: string;
      report: FabRouterReport;
      diagnostics: Array<{ level?: string; code?: string; message?: string }>;
    }
  | {
      ok: false;
      error: { message?: string } | string;
      diagnostics: Array<{ level?: string; code?: string; message?: string }>;
    };

export type FabRouteDsn = (
  dsnText: string,
  settings?: FabRouterSettings,
  hooks?: FabRouterHooks,
  request?: { differentialPairs: import("./types").DifferentialPair[]; minimumClearanceMm?: number },
) => FabRouterTextResult;

export interface FabRouterOptions {
  /** Test/host injection. When absent, the adapter imports `moduleSpecifier`. */
  routeDsn?: FabRouteDsn;
  /** Defaults to `FAB_ROUTER_MODULE`, then `@fabplane/fab-router`. */
  moduleSpecifier?: string;
}

function diagnosticText(diagnostic: { level?: string; code?: string; message?: string }): string {
  return [diagnostic.level, diagnostic.code, diagnostic.message].filter(Boolean).join(": ");
}

function failureText(result: Extract<FabRouterTextResult, { ok: false }>): string {
  const error = typeof result.error === "string" ? result.error : result.error.message;
  return error ?? result.diagnostics.map(diagnosticText).filter(Boolean).join("; ") ?? "unknown failure";
}

/** Untested input endpoints in millimetres; this list is not collision evidence. */
export function leftoverConnectionEndpoints(input: RouteInput): Array<{ net: string; x: number; y: number; itemId: string }> {
  const seen = new Set<string>();
  const out: Array<{ net: string; x: number; y: number; itemId: string }> = [];
  for (const connection of input.connections) {
    for (const end of [connection.from, connection.to]) {
      const key = `${connection.net}\0${end.itemId}\0${end.position.x}\0${end.position.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        net: connection.net,
        x: end.position.x / 1e6,
        y: end.position.y / 1e6,
        itemId: end.itemId,
      });
    }
  }
  return out;
}

export class FabRouter implements Autorouter {
  readonly name = "fab-router";
  private routeDsnPromise?: Promise<FabRouteDsn>;

  constructor(private readonly config: FabRouterOptions = {}) {}

  private solver(): Promise<FabRouteDsn> {
    if (this.config.routeDsn) return Promise.resolve(this.config.routeDsn);
    return (this.routeDsnPromise ??= (async () => {
      const configured = typeof process === "undefined" ? undefined : process.env.FAB_ROUTER_MODULE;
      const specifier = this.config.moduleSpecifier ?? configured ?? "@fabplane/fab-router";
      try {
        const loaded = (await import(specifier)) as { routeDsn?: FabRouteDsn };
        if (typeof loaded.routeDsn !== "function") throw new Error(`module ${specifier} does not export routeDsn`);
        return loaded.routeDsn;
      } catch (error) {
        throw new Error(
          `fab_router unavailable from ${specifier}: ${error instanceof Error ? error.message : String(error)}; install the router or set FAB_ROUTER_MODULE`,
        );
      }
    })());
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.solver();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async route(input: RouteInput, opts: RouteOptions = {}, progress?: (event: RouteProgress) => void): Promise<RouteResult> {
    const started = performance.now();
    const log: string[] = [];
    const freeVias = input.vias.filter((via) => !via.net);
    const preset = opts.preset ?? (freeVias.length ? "laser-prefab" : "default");
    if (freeVias.length || preset === "laser-prefab") {
      throw new Error(
        `fab_router cannot yet claim the board's ${freeVias.length} assignable prefab via(s); fixed-via claiming must be implemented before preset "laser-prefab" is safe`,
      );
    }
    if (opts.signal?.aborted) throw new RouteCancelled();

    const layers = dsnLayers(input, opts);
    const extraVias = extraViasFromRouteOptions(opts);
    const dsn = writeDsn(input, {
      layers,
      extraVias,
      ...(opts.nets ? { routableNets: opts.nets } : {}),
    });
    log.push(
      `fab_router: ${dsn.length} byte DSN, ${layers.length} layer(s), ${input.connections.length} connection(s)` +
        (opts.nets?.length ? `, leftover nets ${opts.nets.join(",")}` : ""),
    );
    progress?.({ phase: "export", percent: 0, total: input.connections.length });
    const routeDsn = await this.solver();
    if (opts.signal?.aborted) throw new RouteCancelled();

    const result = routeDsn(
      dsn,
      {
        ...(opts.effort !== undefined ? { maxPasses: Math.max(1, Math.round(opts.effort)) } : {}),
        ...(opts.maxTimeMs !== undefined ? { timeBudgetMs: opts.maxTimeMs } : {}),
        ...(opts.viaCost !== undefined ? { viaCost: opts.viaCost } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      },
      {
        signal: opts.signal,
        onPass: (event) => {
          progress?.({
            phase: `pass ${event.pass}`,
            ...(opts.effort ? { percent: Math.min(95, (event.pass / opts.effort) * 95) } : {}),
            routed: Math.max(0, input.connections.length - event.incomplete),
            total: input.connections.length,
          });
        },
        onConnection: (event) => {
          progress?.({
            phase: "connection",
            routed: undefined,
            total: input.connections.length,
            message: `${event.net}: ${event.ok ? "routed" : "open"}`,
          });
        },
        onProgress: (event) => {
          progress?.({
            phase: "routing",
            percent: event.total ? Math.min(95, (event.done / event.total) * 95) : undefined,
            routed: event.done,
            total: event.total,
          });
        },
        onLog: (level, message) => log.push(`${level}: ${message}`),
      },
      { differentialPairs: input.differentialPairs ?? [], minimumClearanceMm: input.rules.minClearance / 1e6 },
    );

    if (!result.ok) {
      throw new Error(
        `fab_router failed: ${failureText(result)}. No physical blocker was established. Next: check the solver diagnostics.`,
      );
    }

    log.push(
      ...result.diagnostics
        .map(diagnosticText)
        .filter(Boolean)
        .map((line) => `diagnostic: ${line}`),
    );
    if (opts.signal?.aborted || result.report.aborted) {
      throw new RouteCancelled(`routing cancelled after ${result.report.wallClockMs} ms (${result.report.stoppedBy})`);
    }

    progress?.({ phase: "import", percent: 99, total: input.connections.length });
    const session = parseSes(result.ses);
    const parsed = sesToItems(session, input);
    // SES also echoes protected input wires. Count only polylines that contribute new segments,
    // using the same exact echoed-geometry filter as the native import.
    const generatedWires = session.wires.filter((wire) => sesToItems({ ...session, wires: [wire], vias: [] }, input).tracks.length > 0);
    log.push(...parsed.warnings.map((warning) => `ses: ${warning}`));

    // A best-so-far SES can contain useful-looking stubs on nets the solver did not complete.
    // Applying them creates dangling-track DRC findings. Apply only complete nets; the original
    // board copper remains protected and the entire incomplete net stays honestly in the ratsnest.
    const incompleteNets = new Set(result.report.perNet.filter((net) => net.incomplete > 0).map((net) => net.net));
    const tracks = parsed.tracks.filter((track) => !incompleteNets.has(track.net));
    const vias = parsed.vias.filter((via) => !incompleteNets.has(via.net));
    const discardedTracks = parsed.tracks.length - tracks.length;
    const discardedVias = parsed.vias.length - vias.length;
    if (discardedTracks || discardedVias) {
      log.push(
        `discarded partial copper on ${incompleteNets.size} incomplete net(s): ${discardedTracks} track(s), ${discardedVias} via(s)`,
      );
    }
    const unrouted: RouteConnection[] = input.connections.filter((connection) => incompleteNets.has(connection.net));
    const remaining = result.report.perNet.filter((net) => net.incomplete > 0);
    const endpoints = leftoverConnectionEndpoints(input).filter((end) => incompleteNets.has(end.net));
    const discardedWires = generatedWires.filter((wire) => incompleteNets.has(wire.net)).length;
    const remainingText =
      remaining
        .slice(0, 8)
        .map((net) => `${net.net} ${net.incomplete}`)
        .join("; ") + (remaining.length > 8 ? `; ${remaining.length - 8} more nets` : "");
    const text = `fab_router stopped after ${result.report.passes} passes (${result.report.stoppedBy}): solver opens ${result.report.incompleteBefore} → ${result.report.incompleteAfter}; generated ${generatedWires.length} tracks and ${parsed.vias.length} vias; discarded ${discardedWires} tracks and ${discardedVias} vias because their nets were incomplete. Remaining (${remaining.length} nets, ${result.report.incompleteAfter} opens): ${remainingText || "none"}. Physical endpoint evidence is measured by the bridge after native connectivity is rechecked. Next: ${remaining.length ? "try Freerouting for these nets and check the remaining native opens" : "check native connectivity and DRC"}.`;
    const diagnostics: import("./types").RoutingDiagnostics = {
      text,
      passes: result.report.passes,
      stoppedBy: result.report.stoppedBy,
      solverOpens: { before: result.report.incompleteBefore, after: result.report.incompleteAfter },
      generated: { tracks: generatedWires.length, vias: parsed.vias.length },
      discarded: { tracks: discardedWires, vias: discardedVias },
      remaining: { nets: remaining.length, opens: result.report.incompleteAfter, detail: remaining.slice(0, 24) },
      leftoverEndpoints: endpoints.slice(0, 24),
      leftoverEndpointTotal: endpoints.length,
      physicalBlockerEstablished: false,
      collisions: [],
    };
    log.push(text);
    const elapsedMs = Math.round(performance.now() - started);
    log.push(
      `${tracks.length} tracks, ${vias.length} vias; ${input.connections.length - unrouted.length}/${input.connections.length} connections in ${elapsedMs} ms (${result.report.stoppedBy})`,
    );
    progress?.({
      phase: "done",
      percent: 100,
      routed: input.connections.length - unrouted.length,
      total: input.connections.length,
    });
    const pairRouting: import("./types").PairRouting | undefined = input.differentialPairs?.length
      ? {
          capability: result.report.pairCapability ?? "measurement-only",
          pairs:
            result.report.pairs ??
            input.differentialPairs.map((p) => ({
              p: p.p,
              n: p.n,
              status: incompleteNets.has(p.p) || incompleteNets.has(p.n) ? "unrouted" : "independent-fallback",
              reason: "solver supports measurement only; members routed independently",
            })),
        }
      : undefined;
    if (pairRouting) log.push(`pairRouting ${JSON.stringify(pairRouting)}`);
    return {
      ...(pairRouting ? { pairRouting } : {}),
      diagnostics,
      router: this.name,
      tracks,
      vias,
      preset,
      unrouted,
      totalConnections: input.connections.length,
      timedOut: result.report.timedOut,
      elapsedMs,
      log,
    };
  }
}
