import { Worker } from "node:worker_threads";
import type { FabRouterHooks, FabRouterTextResult } from "./fab-router";
import type { FabRouterWorkerInput, FabRouterWorkerMessage } from "./fab-router-worker-protocol";
import { RouteCancelled } from "./types";

/** The bridge event loop stays responsive; every outcome awaits its owned worker's exit. */
export function runFabRouterInWorker(input: FabRouterWorkerInput, hooks: FabRouterHooks = {}): Promise<FabRouterTextResult> {
  if (hooks.signal?.aborted) return Promise.reject(new RouteCancelled());
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fab-router-worker.ts", import.meta.url), { workerData: input });
    let settled = false;
    const finish = async (error: Error | null, result?: FabRouterTextResult) => {
      if (settled) return;
      settled = true;
      hooks.signal?.removeEventListener("abort", abort);
      try {
        await worker.terminate();
      } catch (stopError) {
        reject(stopError);
        return;
      }
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => void finish(new RouteCancelled());
    worker.on("message", (message: FabRouterWorkerMessage) => {
      if (settled) return;
      try {
        switch (message.type) {
          case "pass":
            hooks.onPass?.(message.event);
            break;
          case "connection":
            hooks.onConnection?.(message.event);
            break;
          case "progress":
            hooks.onProgress?.(message.event);
            break;
          case "log":
            hooks.onLog?.(message.level, message.message);
            break;
          case "result":
            void finish(null, message.result);
            break;
          case "error": {
            const error = new Error(message.message);
            error.name = message.name;
            void finish(error);
            break;
          }
        }
      } catch (error) {
        void finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.once("error", (error: Error) => void finish(error));
    worker.once("exit", (code) => {
      if (!settled) void finish(new Error(`fab_router worker exited without a result (code ${code})`));
    });
    hooks.signal?.addEventListener("abort", abort, { once: true });
    if (hooks.signal?.aborted) abort();
  });
}
