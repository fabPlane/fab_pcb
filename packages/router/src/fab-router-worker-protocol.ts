import type { FabRouterHooks, FabRouterSettings, FabRouterTextResult } from "./fab-router";

export interface FabRouterWorkerInput {
  moduleSpecifier: string;
  dsn: string;
  settings: FabRouterSettings;
}

export type FabRouterWorkerMessage =
  | { type: "pass"; event: Parameters<NonNullable<FabRouterHooks["onPass"]>>[0] }
  | { type: "connection"; event: Parameters<NonNullable<FabRouterHooks["onConnection"]>>[0] }
  | { type: "progress"; event: Parameters<NonNullable<FabRouterHooks["onProgress"]>>[0] }
  | { type: "log"; level: "info" | "warn"; message: string }
  | { type: "result"; result: FabRouterTextResult }
  | { type: "error"; name: string; message: string };
