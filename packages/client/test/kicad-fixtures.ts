/**
 * Shared test helpers: locating `kicad-cli`, spawning a headless API server, and the hand-encoded
 * Ping request/response used before the protobuf codegen exists.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const KICAD_ROOT = resolve(import.meta.dir, "../../../../kicad");
export const DEFAULT_KICAD_CLI = `${KICAD_ROOT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
export const KICAD_CLI = process.env.KICAD_CLI ?? DEFAULT_KICAD_CLI;
/**
 * A newer (development) build used only for commands the stable binary predates (events socket,
 * NewProject/NewDocument/GetProjectInfo, symbol documents). Tests skip cleanly when it is absent.
 */
export const DEFAULT_KICAD_CLI_DEV = `${KICAD_ROOT}/build/dev/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
export const KICAD_CLI_DEV = process.env.KICAD_CLI_DEV ?? DEFAULT_KICAD_CLI_DEV;
export const KITCHEN_SINK_PCB = `${KICAD_ROOT}/qa/data/pcbnew/api_kitchen_sink.kicad_pcb`;
export const KITCHEN_SINK_SCH = `${KICAD_ROOT}/qa/data/eeschema/api_kitchen_sink.kicad_sch`;

export function haveKicad(): boolean {
  return existsSync(KICAD_CLI);
}

export function haveKicadDev(): boolean {
  return existsSync(KICAD_CLI_DEV);
}

/** `ApiRequest{ header{client_name:"kicad-web/m0-ping"}, message: Any(kiapi.common.commands.Ping) }` */
export const PING_REQUEST = hexToBytes(
  "0a1312116b696361642d7765622f6d302d70696e6712320a2e747970652e676f6f676c65617069732e636f6d2f6b696170692e636f6d6d6f6e2e636f6d6d616e64732e50696e671200",
);

export const STATUS_NAMES = [
  "AS_UNKNOWN",
  "AS_OK",
  "AS_TIMEOUT",
  "AS_BAD_REQUEST",
  "AS_NOT_READY",
  "AS_UNHANDLED",
  "AS_TOKEN_MISMATCH",
  "AS_BUSY",
  "AS_UNIMPLEMENTED",
];

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Minimal protobuf field scanner: returns [fieldNumber, wireType, value] triples of one message. */
function scanFields(buf: Uint8Array): Array<{ field: number; wire: number; varint?: number; bytes?: Uint8Array }> {
  const out: Array<{ field: number; wire: number; varint?: number; bytes?: Uint8Array }> = [];
  let i = 0;
  const readVarint = () => {
    let r = 0;
    let s = 0;
    let b: number;
    do {
      b = buf[i++]!;
      r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  };
  while (i < buf.length) {
    const key = readVarint();
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) out.push({ field, wire, varint: readVarint() });
    else if (wire === 2) {
      const len = readVarint();
      out.push({ field, wire, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) {
      i += 8;
      out.push({ field, wire });
    } else if (wire === 5) {
      i += 4;
      out.push({ field, wire });
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/** Decode the `ApiResponse` envelope: header.kicad_token, status.status, status.error_message. */
export function decodeApiResponse(bytes: Uint8Array): { token: string; status: number; statusName: string; error: string } {
  const dec = new TextDecoder();
  const top = scanFields(bytes);
  let token = "";
  let status = 0;
  let error = "";
  for (const f of top) {
    if (f.field === 1 && f.bytes) {
      for (const h of scanFields(f.bytes)) if (h.field === 1 && h.bytes) token = dec.decode(h.bytes);
    } else if (f.field === 2 && f.bytes) {
      for (const s of scanFields(f.bytes)) {
        if (s.field === 1 && s.varint !== undefined) status = s.varint;
        if (s.field === 2 && s.bytes) error = dec.decode(s.bytes);
      }
    }
  }
  return { token, status, statusName: STATUS_NAMES[status] ?? `status ${status}`, error };
}

export interface KicadServer {
  socketPath: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** True once the process has exited on its own (crash) — `stop()` was not called. */
  readonly crashed: boolean;
  /** Everything the server wrote to stderr so far (crash diagnostics). */
  stderr(): string;
  stop(): Promise<void>;
}

/**
 * Spawn `kicad-cli api-server <file> --socket /tmp/kicad/<prefix>-<pid>-<random>.sock` and wait for
 * the socket file to appear. (Readiness — replies other than AS_NOT_READY — is up to the caller.)
 */
export async function startKicadServer(file: string | null, prefix = "test", cli: string = KICAD_CLI): Promise<KicadServer> {
  await mkdir("/tmp/kicad", { recursive: true });
  const socketPath = `/tmp/kicad/${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  await rm(socketPath, { force: true });
  const proc = Bun.spawn([cli, "api-server", ...(file ? [file] : []), "--socket", socketPath], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrChunks: string[] = [];
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrChunks.push(new TextDecoder().decode(value));
    }
  })().catch(() => {});
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`kicad-cli exited with ${proc.exitCode} before listening:\n${stderrChunks.join("")}`);
    }
    try {
      await stat(socketPath);
      break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`timeout waiting for ${socketPath}`);
    }
    await Bun.sleep(20);
  }
  let stopping = false;
  return {
    socketPath,
    proc,
    get crashed() {
      return !stopping && proc.exitCode !== null;
    },
    stderr() {
      return stderrChunks.join("");
    },
    async stop() {
      stopping = true;
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        const t = setTimeout(() => proc.kill("SIGKILL"), 3000);
        await proc.exited;
        clearTimeout(t);
      }
      await rm(socketPath, { force: true });
      // The events socket (KiCad >= e8cd61a2f2) sits next to the request socket.
      await rm(socketPath.replace(/\.sock$/, "-events.sock"), { force: true });
    },
  };
}
