/** Native server-side adapter for fabPlane/fab_router's text DSN/SES API. */
import { dsnLayers, extraViasFromRouteOptions, writeDsn } from "./specctra/dsn";
import { parseSes, sesToItems } from "./specctra/ses";
import { runFabRouterInWorker } from "./fab-router-worker-client";
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

export type FabRouteDsn = (dsnText: string, settings?: FabRouterSettings, hooks?: FabRouterHooks) => FabRouterTextResult;

export interface FabRouterOptions {
  /** Inline test/host injection. Native module solvers otherwise run in an owned worker. */
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

/** Leftover endpoints in millimetres, for a fail-fast "boxed pad" report when nothing routes. */
export function blockedConnectionPads(input: RouteInput): Array<{ net: string; x: number; y: number; itemId: string }> {
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
    if (opts.signal?.aborted) throw new RouteCancelled();

    const settings: FabRouterSettings = {
      ...(opts.effort !== undefined ? { maxPasses: Math.max(1, Math.round(opts.effort)) } : {}),
      ...(opts.maxTimeMs !== undefined ? { timeBudgetMs: opts.maxTimeMs } : {}),
      ...(opts.viaCost !== undefined ? { viaCost: opts.viaCost } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    };
    const hooks: FabRouterHooks = {
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
    };
    const result = this.config.routeDsn
      ? this.config.routeDsn(dsn, settings, hooks)
      : await runFabRouterInWorker(
          {
            moduleSpecifier: this.config.moduleSpecifier ?? process.env.FAB_ROUTER_MODULE ?? "@fabplane/fab-router",
            dsn,
            settings,
          },
          hooks,
        );

    if (!result.ok) {
      const blocked = blockedConnectionPads(input);
      const detail = blocked.length
        ? `; blockedPads ${blocked
            .slice(0, 24)
            .map((pad) => `${pad.net}@${pad.x.toFixed(2)},${pad.y.toFixed(2)}`)
            .join("; ")}`
        : "";
      throw new Error(`fab_router failed: ${failureText(result)}${detail}`);
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
    const parsed = sesToItems(parseSes(result.ses), input);
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
    if (unrouted.length === input.connections.length && input.connections.length) {
      const blocked = blockedConnectionPads(input);
      log.push(
        `no leftover connections routed; blockedPads: ${blocked
          .slice(0, 24)
          .map((pad) => `${pad.net} ${pad.itemId} (${pad.x.toFixed(3)},${pad.y.toFixed(3)})`)
          .join("; ")}`,
      );
    }
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
    return {
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
