/**
 * Compatibility facade for callers that still import the former browser-side `JsRouter`.
 *
 * TensorFleet/js_autorouter is server-only today. New code should submit `router: "js"` to the
 * bridge, which uses `JsAutorouter`. Keeping this small facade produces a useful failure for an
 * older UI or third-party caller without pulling the retired tscircuit solver into browser builds.
 */
import type { Autorouter, RouteInput, RouteOptions, RouteProgress, RouteResult } from "./types";

export interface JsRouterOptions {
  /** Retained for source compatibility; browser-side stepping is no longer supported. */
  yieldEveryMs?: number;
}

export class JsRouter implements Autorouter {
  readonly name = "js";

  constructor(_options: JsRouterOptions = {}) {}

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return {
      ok: false,
      reason: "the in-tab capacity router was removed; run js_autorouter through the bridge",
    };
  }

  async route(
    _input: RouteInput,
    _opts: RouteOptions = {},
    _progress?: (progress: RouteProgress) => void,
  ): Promise<RouteResult> {
    throw new Error(
      "the in-tab capacity router was removed; choose the server-side JavaScript router",
    );
  }
}
