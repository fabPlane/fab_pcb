import type { FabRouteDsn } from "../../src/fab-router";

/** Deliberately blocks its own thread; parent health and cancellation must still work. */
export const routeDsn: FabRouteDsn = (_dsn, settings, hooks) => {
  if (settings?.seed === 42) throw new RangeError("fixture solver exception");
  if (settings?.seed === 43) process.exit(7);
  hooks?.onPass?.({ pass: 1, incomplete: 1, elapsedMs: 0 });
  hooks?.onConnection?.({ net: "A", from: "a", to: "b", ok: false, elapsedMs: 0 });
  hooks?.onProgress?.({ done: 0, total: 1, elapsedMs: 0 });
  hooks?.onLog?.("warn", "fixture diagnostic");
  const until = performance.now() + (settings?.timeBudgetMs ?? 0);
  while (performance.now() < until) {
    // A synchronous solver cannot receive ordinary cancellation messages during this loop.
  }
  return { ok: false, error: { message: "fixture expected failure" }, diagnostics: [] };
};
