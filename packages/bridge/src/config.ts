import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFreerouting, type FreeroutingPaths } from "@fp-pcb/router/freerouting";
import { isSessionBackend, type SessionBackend } from "./wasm-protocol";

/** `<repo>/../kicad` — the KiCad checkout that sits next to fp-pcb. */
export const KICAD_CHECKOUT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(import.meta.dir, "../../../../kicad");
export const DEFAULT_KICAD_CLI = `${KICAD_CHECKOUT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
export const DEFAULT_WORKSPACE_ROOT = `${KICAD_CHECKOUT}/qa/data`;
/** Where `bun run --filter @fp-pcb/kicad-wasm fetch` puts the Emscripten build. */
export const DEFAULT_WASM_MODULE = resolve(import.meta.dir, "../../kicad-wasm/dist/kicad_api.js");

export interface BridgeConfig {
  /** TCP port for HTTP + WebSocket. `0` picks a free port. Env `PORT`, default 4020. */
  port: number;
  /** Env `HOST`, default `127.0.0.1`. */
  hostname: string;
  /** Path to `kicad-cli`. Env `KICAD_CLI`. */
  kicadCli: string;
  /** Directory for `api-<session>.sock`. Env `KICAD_SOCKET_DIR`, default `/tmp/kicad`. */
  socketDir: string;
  /** Root the `/files` API is confined to. Env `WORKSPACE_ROOT`, default the KiCad `qa/data` dir. */
  workspaceRoot: string;
  /** Directory served for unmatched GET requests (SPA). Env `STATIC_DIR`; unset disables. */
  staticDir: string | null;
  /** Timeout for one KiCad request. Env `KICAD_REQUEST_TIMEOUT_MS`, default 120 000 (jobs can be slow). */
  requestTimeoutMs: number;
  /** Time allowed for `kicad-cli api-server` to answer AS_OK. Env `KICAD_START_TIMEOUT_MS`, default 60 000. */
  startTimeoutMs: number;
  /** Bun WebSocket idle timeout in seconds. Env `WS_IDLE_TIMEOUT_SEC`, default 900. */
  wsIdleTimeoutSec: number;
  /** Largest WebSocket message accepted from a client. Env `WS_MAX_PAYLOAD_BYTES`, default 64 MiB. */
  maxPayloadBytes: number;
  /**
   * Destroy a session (as `DELETE /sessions/:id` would) once it has had no WebSocket or SSE
   * client for this many seconds. Env `SESSION_IDLE_TIMEOUT_SEC`, default 0 = never.
   */
  sessionIdleTimeoutSec: number;
  /** Relay KiCad's events socket to clients. Env `KICAD_EVENTS` (`0` disables), default on. */
  relayEvents: boolean;
  /**
   * What runs KiCad for a new session: a `kicad-cli api-server` process (`process`, the default)
   * or `kicad_api.wasm` in a Bun Worker (`wasm`). Env `SESSION_BACKEND`; `POST /sessions
   * {backend}` overrides it per session.
   */
  sessionBackend: SessionBackend;
  /**
   * The wasm build's ES module (`kicad_api.js`; its `.wasm` is found next to it). Env
   * `KICAD_WASM_MODULE`, else `<KICAD_WASM_DIR>/kicad_api.js`, else `@fp-pcb/kicad-wasm`'s `dist/`.
   */
  wasmModuleUrl: string;
  /** Host share tree copied into MEMFS at `wasmShare`. Env `KICAD_WASM_SHARE`; null when the build carries a `.data` bundle. */
  wasmShareDir: string | null;
  /** MEMFS path for KiCad's settings (`kiapi_init.home`). Env `KICAD_WASM_HOME`, default `/home/kicad`. */
  wasmHome: string;
  /** MEMFS path of the share tree (`kiapi_init.share`). Env `KICAD_WASM_SHARE_PATH`, default `/kicad/share`. */
  wasmShare: string;
  /** How long `stop()` waits for the worker to flush MEMFS and shut down before `terminate()`. Env `KICAD_WASM_STOP_TIMEOUT_MS`, default 5000. */
  wasmStopTimeoutMs: number;
  /** Extra environment for the KiCad child processes. */
  kicadEnv: Record<string, string>;
  /**
   * Freerouting jar and Java for `POST /sessions/:id/route {router:"freerouting"}`: env
   * `FREEROUTING_JAR` (default `packages/router/vendor/freerouting-<version>.jar`) and
   * `FP_PCB_JAVA` / `FREEROUTING_JAVA` (default the vendored Temurin 25, then a system `java`).
   * `ok: false` carries the reason; the route is then refused with it.
   */
  freerouting: FreeroutingPaths;
  log: (message: string) => void;
}

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
}

function backend(v: string | undefined): SessionBackend {
  if (v === undefined || v === "") return "process";
  if (!isSessionBackend(v)) throw new Error(`SESSION_BACKEND must be "process" or "wasm", got "${v}"`);
  return v;
}

/** `KICAD_WASM_MODULE` wins, then `<KICAD_WASM_DIR>/kicad_api.js`, then the package's own `dist/`. */
function moduleUrl(env: Record<string, string | undefined>): string {
  const path = env.KICAD_WASM_MODULE ?? (env.KICAD_WASM_DIR ? join(env.KICAD_WASM_DIR, "kicad_api.js") : DEFAULT_WASM_MODULE);
  return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : pathToFileURL(resolve(path)).href;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const base: BridgeConfig = {
    port: int(env.PORT, 4020),
    hostname: env.HOST ?? "127.0.0.1",
    kicadCli: env.KICAD_CLI ?? DEFAULT_KICAD_CLI,
    socketDir: env.KICAD_SOCKET_DIR ?? "/tmp/kicad",
    workspaceRoot: resolve(env.WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT),
    staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : null,
    requestTimeoutMs: int(env.KICAD_REQUEST_TIMEOUT_MS, 120_000),
    startTimeoutMs: int(env.KICAD_START_TIMEOUT_MS, 60_000),
    wsIdleTimeoutSec: int(env.WS_IDLE_TIMEOUT_SEC, 900),
    maxPayloadBytes: int(env.WS_MAX_PAYLOAD_BYTES, 64 * 1024 * 1024),
    sessionIdleTimeoutSec: int(env.SESSION_IDLE_TIMEOUT_SEC, 0),
    relayEvents: !["0", "false", "off", "no"].includes((env.KICAD_EVENTS ?? "1").toLowerCase()),
    sessionBackend: backend(env.SESSION_BACKEND),
    wasmModuleUrl: moduleUrl(env),
    wasmShareDir: env.KICAD_WASM_SHARE ? resolve(env.KICAD_WASM_SHARE) : null,
    wasmHome: env.KICAD_WASM_HOME ?? "/home/kicad",
    wasmShare: env.KICAD_WASM_SHARE_PATH ?? "/kicad/share",
    wasmStopTimeoutMs: int(env.KICAD_WASM_STOP_TIMEOUT_MS, 5000),
    kicadEnv: {},
    freerouting: resolveFreerouting(env),
    log: (m) => console.log(`[bridge ${new Date().toISOString()}] ${m}`),
  };
  return { ...base, ...overrides };
}
