// @fp-pcb/client — public entry point.
// Layer 1 (transports), Layer 2 (KiCadClient + generated commands), Layer 3 (object model) and
// Layer 4 (ItemStore). Keep this file additive: append exports, do not restructure.
export * from "./transport/index";

// Layer 2
export { KiCadClient, Capabilities } from "./client";
export type { CallOptions, CallTrace, CommandCapability, KiCadClientOptions, RetryOptions, ServerRestartInfo } from "./client";
export * as commands from "./commands";
export { COMMAND_SCHEMAS, commandSchemas, type CommandName, type CommandSchemas } from "./commands";
export {
  COMMANDS,
  COMMAND_BY_NAME,
  COMMAND_BY_REQUEST_TYPE,
  HEADLESS_COMMANDS,
  KICAD_COMMIT,
  type CommandInfo,
  type HeadlessStatus,
} from "./commands-data";
export * from "./errors";
export * from "./units";
export {
  KiCadEvents,
  TransportEventSubscriber,
  decodeEvent,
  eventToJson,
  type EventGap,
  type EventKind,
  type EventPayloads,
} from "./events";

// Layer 3
export * from "./model/index";

// Layer 4
export * from "./store/index";
