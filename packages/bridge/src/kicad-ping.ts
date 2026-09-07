/**
 * The one protobuf message the bridge understands by hand: `Ping`, used to learn the
 * `kicad_token` and to detect readiness (AS_NOT_READY while a preloaded document loads).
 * Everything else is forwarded as opaque bytes.
 */
import type { Transport } from "@fp-pcb/client/transport";

const enc = new TextEncoder();
const dec = new TextDecoder();

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}
function bytesField(field: number, data: Uint8Array): Uint8Array {
  return Uint8Array.from([...varint((field << 3) | 2), ...varint(data.length), ...data]);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `ApiRequest{ header{ client_name }, message: Any{ type_url, value } }` */
export function encodeApiRequest(clientName: string, typeName: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const header = bytesField(2, enc.encode(clientName));
  const any = concat(bytesField(1, enc.encode(`type.googleapis.com/${typeName}`)), bytesField(2, payload));
  return concat(bytesField(1, header), bytesField(2, any));
}

export function encodePing(clientName = "fp-pcb/bridge"): Uint8Array {
  return encodeApiRequest(clientName, "kiapi.common.commands.Ping");
}

export const API_STATUS = [
  "AS_UNKNOWN",
  "AS_OK",
  "AS_TIMEOUT",
  "AS_BAD_REQUEST",
  "AS_NOT_READY",
  "AS_UNHANDLED",
  "AS_TOKEN_MISMATCH",
  "AS_BUSY",
  "AS_UNIMPLEMENTED",
] as const;

export interface ApiResponseEnvelope {
  token: string;
  status: number;
  statusName: string;
  error: string;
}

/** Decode `ApiResponse{ header{kicad_token}, status{status, error_message} }`; ignores `message`. */
export function decodeApiResponse(bytes: Uint8Array): ApiResponseEnvelope {
  const out: ApiResponseEnvelope = { token: "", status: 0, statusName: "AS_UNKNOWN", error: "" };
  for (const f of scan(bytes)) {
    if (f.field === 1 && f.bytes) {
      for (const h of scan(f.bytes)) if (h.field === 1 && h.bytes) out.token = dec.decode(h.bytes);
    } else if (f.field === 2 && f.bytes) {
      for (const s of scan(f.bytes)) {
        if (s.field === 1 && s.varint !== undefined) out.status = s.varint;
        if (s.field === 2 && s.bytes) out.error = dec.decode(s.bytes);
      }
    }
  }
  out.statusName = API_STATUS[out.status] ?? `status ${out.status}`;
  return out;
}

function scan(buf: Uint8Array): Array<{ field: number; varint?: number; bytes?: Uint8Array }> {
  const out: Array<{ field: number; varint?: number; bytes?: Uint8Array }> = [];
  let i = 0;
  const readVarint = () => {
    let r = 0;
    let s = 0;
    let b: number;
    do {
      if (i >= buf.length) throw new Error("truncated varint");
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
    if (wire === 0) out.push({ field, varint: readVarint() });
    else if (wire === 2) {
      const len = readVarint();
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

/**
 * Ping until the server answers AS_OK (it answers AS_NOT_READY while a preloaded document is
 * loading). Resolves with the kicad token. Rejects on any other status or when the deadline passes.
 */
export async function pingUntilReady(
  transport: Transport,
  opts: { timeoutMs: number; intervalMs?: number; clientName?: string; isCancelled?: () => boolean },
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  const req = encodePing(opts.clientName);
  for (;;) {
    if (opts.isCancelled?.()) throw new Error("cancelled");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`KiCad did not become ready within ${opts.timeoutMs} ms`);
    const r = decodeApiResponse(await transport.send(req, { timeoutMs: Math.min(remaining, 5000) }));
    if (r.status === 1) return r.token;
    if (r.status !== 4) throw new Error(`unexpected Ping reply ${r.statusName}: ${r.error}`);
    await Bun.sleep(opts.intervalMs ?? 50);
  }
}
