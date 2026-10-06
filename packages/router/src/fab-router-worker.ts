/** Owns one synchronous calculation; the parent terminates it on exact-job cancellation. */
import { parentPort, workerData } from "node:worker_threads";
import type { FabRouteDsn } from "./fab-router";
import type { FabRouterWorkerInput, FabRouterWorkerMessage } from "./fab-router-worker-protocol";

if (!parentPort) throw new Error("fab-router-worker must run in a worker thread");
const port = parentPort;
const input = workerData as FabRouterWorkerInput;
const post = (message: FabRouterWorkerMessage) => port.postMessage(message);
try {
  const module = (await import(input.moduleSpecifier)) as { routeDsn?: FabRouteDsn };
  if (typeof module.routeDsn !== "function") throw new Error(`module ${input.moduleSpecifier} does not export routeDsn`);
  const result = module.routeDsn(input.dsn, input.settings, {
    onPass: (event) => post({ type: "pass", event }),
    onConnection: (event) => post({ type: "connection", event }),
    onProgress: (event) => post({ type: "progress", event }),
    onLog: (level, message) => post({ type: "log", level, message }),
  });
  post({ type: "result", result });
} catch (error) {
  post({
    type: "error",
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  port.close();
}
