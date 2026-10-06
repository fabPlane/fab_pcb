import { strict as assert } from "node:assert";
import { runFabRouterInWorker } from "../../src/fab-router-worker-client";

const moduleSpecifier = process.argv[2];
assert(moduleSpecifier, "a fixture solver path is required");
const events: string[] = [];
const result = await runFabRouterInWorker({ moduleSpecifier, dsn: "fixture", settings: {} }, { onPass: () => events.push("pass") });
assert.equal(result.ok, false);
assert.deepEqual(events, ["pass"]);

const abort = new AbortController();
await assert.rejects(
  runFabRouterInWorker(
    { moduleSpecifier, dsn: "fixture", settings: { timeBudgetMs: 10_000 } },
    { signal: abort.signal, onPass: () => abort.abort() },
  ),
  { name: "RouteCancelled" },
);
const next = await runFabRouterInWorker({ moduleSpecifier, dsn: "fixture", settings: {} });
assert.equal(next.ok, false);
console.log("compiled solver worker: result, cancellation, and next job passed");
