import { describe, expect, test } from "bun:test";
import { FabRouter } from "../src/fab-router";
import { runFabRouterInWorker } from "../src/fab-router-worker-client";
import { twoNetBoard } from "./fixtures";

const moduleSpecifier = new URL("./fixtures/blocking-solver.ts", import.meta.url).href;

describe("FabRouter worker ownership", () => {
  test("health stays responsive during synchronous solving and progress crosses the worker boundary", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("healthy") });
    const events: string[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let finished = false;
    const solve = runFabRouterInWorker(
      { moduleSpecifier, dsn: "fixture", settings: { timeBudgetMs: 750 } },
      {
        onPass: () => {
          events.push("pass");
          entered();
        },
        onConnection: () => events.push("connection"),
        onProgress: () => events.push("progress"),
        onLog: (level, message) => events.push(`${level}:${message}`),
      },
    ).finally(() => {
      finished = true;
    });
    try {
      await started;
      expect(await (await fetch(`${server.url}health`)).text()).toBe("healthy");
      expect(finished).toBe(false);
      const result = await solve;
      expect(result).toMatchObject({ ok: false, error: { message: "fixture expected failure" } });
      expect(events).toEqual(["pass", "connection", "progress", "warn:fixture diagnostic"]);
    } finally {
      await solve;
      server.stop(true);
    }
  });

  test("abort terminates the exact busy worker before rejection and the next job still works", async () => {
    const abort = new AbortController();
    const started = performance.now();
    const solve = runFabRouterInWorker(
      { moduleSpecifier, dsn: "fixture", settings: { timeBudgetMs: 10_000 } },
      {
        signal: abort.signal,
        onPass: () => abort.abort(),
      },
    );
    await expect(solve).rejects.toMatchObject({ name: "RouteCancelled" });
    expect(performance.now() - started).toBeLessThan(1_000);
    const next = await runFabRouterInWorker({ moduleSpecifier, dsn: "fixture", settings: {} });
    expect(next.ok).toBe(false);
  });

  test("solver exceptions, process exit, missing modules, and progress callback errors are reported", async () => {
    await expect(runFabRouterInWorker({ moduleSpecifier, dsn: "fixture", settings: { seed: 42 } })).rejects.toMatchObject({
      name: "RangeError",
      message: "fixture solver exception",
    });
    await expect(runFabRouterInWorker({ moduleSpecifier, dsn: "fixture", settings: { seed: 43 } })).rejects.toThrow(
      "exited without a result (code 7)",
    );
    await expect(runFabRouterInWorker({ moduleSpecifier: "./missing-solver", dsn: "fixture", settings: {} })).rejects.toThrow(
      "missing-solver",
    );
    await expect(
      runFabRouterInWorker(
        { moduleSpecifier, dsn: "fixture", settings: { timeBudgetMs: 10_000 } },
        {
          onPass: () => {
            throw new Error("progress consumer failed");
          },
        },
      ),
    ).rejects.toThrow("progress consumer failed");
  });

  test("the default module adapter preserves real solver failures and pre-cancellation", async () => {
    const router = new FabRouter({ moduleSpecifier });
    await expect(router.route(twoNetBoard())).rejects.toThrow("fab_router failed: fixture expected failure");
    const abort = new AbortController();
    abort.abort();
    await expect(router.route(twoNetBoard(), { signal: abort.signal })).rejects.toMatchObject({ name: "RouteCancelled" });
  });
});
