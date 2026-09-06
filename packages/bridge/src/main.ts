#!/usr/bin/env bun
import { configFromEnv } from "./config";
import { startBridge } from "./server";

const bridge = await startBridge(configFromEnv());

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  bridge.config.log(`${signal}: shutting down`);
  await bridge.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
