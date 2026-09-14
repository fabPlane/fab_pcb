export { startBridge, type BridgeServer } from "./server";
export { configFromEnv, DEFAULT_KICAD_CLI, DEFAULT_WASM_MODULE, DEFAULT_WORKSPACE_ROOT, KICAD_CHECKOUT, type BridgeConfig } from "./config";
export {
  SessionManager,
  Session,
  eventsSocketPathFor,
  kicadChildEnvironment,
  type SessionInfo,
  type SessionLike,
  type CreateSessionOptions,
} from "./session";
export { WasmSession, type WasmSessionOptions } from "./session-wasm";
export { isSessionBackend, requestTypeName, shouldFlushAfter, type SessionBackend, type WasmWorkerInit } from "./wasm-protocol";
export { encodeApiRequest, encodePing, decodeApiResponse, pingUntilReady, API_STATUS } from "./kicad-ping";
export { resolveInRoot, realRoot, FilesError } from "./files";
