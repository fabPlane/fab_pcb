/**
 * Server-side adapter for TensorFleet/js_autorouter.
 *
 * The dependency is loaded at runtime because it is currently private and GPL-derived. This keeps
 * the distribution decision explicit: development can point at a sibling checkout with
 * `JS_AUTOROUTER_MODULE`, while a release must deliberately provide an approved packaged module.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDsn, dsnLayers } from "./specctra/dsn";
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

export interface JsAutorouterRouteOptions {
  maxPasses?: number;
  maxConnectionMs?: number;
  maxTotalMs?: number;
}

export type RouteDsn = (input: string, workDir: string, options?: JsAutorouterRouteOptions) => Promise<string>;

export interface JsAutorouterOptions {
  /** Test/host injection. When absent, the adapter imports `moduleSpecifier`. */
  routeDsn?: RouteDsn;
  /** Defaults to `JS_AUTOROUTER_MODULE`, then `@tensorfleet/js-autorouter`. */
  moduleSpecifier?: string;
  /** Keep DSN/SES files for diagnosis. */
  keepFiles?: boolean;
  /** Parent directory for run files; defaults to a fresh directory under the OS temp dir. */
  workDir?: string;
}

export class JsAutorouter implements Autorouter {
  readonly name = "js-autorouter";
  private routeDsnPromise?: Promise<RouteDsn>;

  constructor(private readonly jsar: JsAutorouterOptions = {}) {}

  private solver(): Promise<RouteDsn> {
    if (this.jsar.routeDsn) return Promise.resolve(this.jsar.routeDsn);
    return (this.routeDsnPromise ??= (async () => {
      const configured = typeof process === "undefined" ? undefined : process.env.JS_AUTOROUTER_MODULE;
      const specifier = this.jsar.moduleSpecifier ?? configured ?? "@tensorfleet/js-autorouter";
      try {
        const loaded = (await import(specifier)) as { routeDsn?: RouteDsn };
        if (typeof loaded.routeDsn !== "function") throw new Error(`module ${specifier} does not export routeDsn`);
        return loaded.routeDsn;
      } catch (error) {
        throw new Error(
          `js_autorouter unavailable from ${specifier}: ${error instanceof Error ? error.message : String(error)}; install the private router or set JS_AUTOROUTER_MODULE`,
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

  async route(input: RouteInput, opts: RouteOptions = {}, progress?: (p: RouteProgress) => void): Promise<RouteResult> {
    const t0 = performance.now();
    const log: string[] = [];
    const freeVias = input.vias.filter((via) => !via.net);
    const preset = opts.preset ?? (freeVias.length ? "laser-prefab" : "default");
    if (freeVias.length || preset === "laser-prefab") {
      throw new Error(
        `js_autorouter cannot yet route through the board's ${freeVias.length} assignable prefab via(s); fixed-via claiming must be implemented before preset "laser-prefab" is safe`,
      );
    }
    if (opts.signal?.aborted) throw new RouteCancelled();

    const layers = dsnLayers(input, opts);
    const workDir = this.jsar.workDir ?? (await mkdtemp(join(tmpdir(), "fp-pcb-js-autorouter-")));
    try {
      const dsnPath = join(workDir, "board.dsn");
      const dsn = writeDsn(input, { layers });
      await writeFile(dsnPath, dsn);
      log.push(`js_autorouter: ${dsn.length} byte DSN, ${layers.length} layer(s), ${input.connections.length} connection(s)`);
      if (opts.seed !== undefined) log.push("note: js_autorouter is deterministic; `seed` is ignored");
      if (opts.viaCost !== undefined) log.push("note: `viaCost` is not yet mapped to js_autorouter settings; ignored");
      if (opts.nets?.length) log.push("note: js_autorouter routes the whole DSN; `nets` only filters the requested result scope");

      progress?.({ phase: "export", percent: 0, total: input.connections.length });
      const routeDsn = await this.solver();
      if (opts.signal?.aborted) throw new RouteCancelled();
      progress?.({ phase: "js-autorouter", percent: 1, total: input.connections.length });
      const sesPath = await routeDsn(dsnPath, workDir, {
        ...(opts.effort !== undefined ? { maxPasses: Math.max(1, Math.round(opts.effort)) } : {}),
        ...(opts.maxTimeMs !== undefined ? { maxTotalMs: opts.maxTimeMs } : {}),
      });
      if (opts.signal?.aborted) {
        throw new RouteCancelled(
          "routing cancelled after js_autorouter returned; in-process cancellation is pending an interruptible solver API",
        );
      }

      progress?.({ phase: "import", percent: 99, total: input.connections.length });
      const session = parseSes(await readFile(sesPath, "utf8"));
      const items = sesToItems(session, input);
      log.push(...items.warnings.map((warning) => `ses: ${warning}`));
      const routedNets = items.routedNets;
      const unrouted: RouteConnection[] = input.connections.filter((connection) => !routedNets.has(connection.net));
      const elapsedMs = Math.round(performance.now() - t0);
      log.push(
        `${items.tracks.length} tracks, ${items.vias.length} vias; ${input.connections.length - unrouted.length}/${input.connections.length} connections in ${elapsedMs} ms`,
      );
      progress?.({
        phase: "done",
        percent: 100,
        routed: input.connections.length - unrouted.length,
        total: input.connections.length,
      });
      return {
        router: this.name,
        tracks: items.tracks,
        vias: items.vias,
        preset,
        unrouted,
        totalConnections: input.connections.length,
        timedOut: false,
        elapsedMs,
        log,
      };
    } finally {
      if (this.jsar.keepFiles || this.jsar.workDir) log.push(`files kept in ${workDir}`);
      else await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
