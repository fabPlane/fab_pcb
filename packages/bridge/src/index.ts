export { startBridge, type BridgeServer } from "./server";
export { configFromEnv, DEFAULT_KICAD_CLI, DEFAULT_WORKSPACE_ROOT, KICAD_CHECKOUT, type BridgeConfig } from "./config";
export { SessionManager, Session, eventsSocketPathFor, kicadChildEnvironment, type SessionInfo, type CreateSessionOptions } from "./session";
export { encodeApiRequest, encodePing, decodeApiResponse, pingUntilReady, API_STATUS } from "./kicad-ping";
export { resolveInRoot, realRoot, FilesError } from "./files";
