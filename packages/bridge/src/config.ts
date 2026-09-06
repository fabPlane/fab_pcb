import { resolve } from "node:path";

/** `<repo>/../kicad` — the KiCad checkout that sits next to kicad-web. */
export const KICAD_CHECKOUT = resolve(import.meta.dir, "../../../../kicad");
export const DEFAULT_KICAD_CLI = `${KICAD_CHECKOUT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
export const DEFAULT_WORKSPACE_ROOT = `${KICAD_CHECKOUT}/qa/data`;

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
  /** Extra environment for the KiCad child processes. */
  kicadEnv: Record<string, string>;
  log: (message: string) => void;
}

function int(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${v}"`);
  return n;
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
    kicadEnv: {},
    log: (m) => console.log(`[bridge ${new Date().toISOString()}] ${m}`),
  };
  return { ...base, ...overrides };
}
