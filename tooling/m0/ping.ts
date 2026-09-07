#!/usr/bin/env bun
/**
 * M0: talk to `kicad-cli api-server` over its nng REQ/REP unix socket with no
 * dependencies. Sends Ping and GetVersion, prints the replies.
 *
 * Wire format (nng "SP" over ipc://):
 *   handshake  8 bytes each way: 00 'S' 'P' 00 <proto BE16> 00 00   (REQ0=0x30, REP0=0x31)
 *   message    9-byte header: byte 0 = 0x01 (type "data"), bytes 1..8 = big-endian uint64 length; then body
 *   REQ0 body  4-byte request id (top bit set) + payload; the reply echoes the id
 * Payload is kiapi.common.ApiRequest / ApiResponse, hand-encoded protobuf below.
 *
 * Usage: bun tooling/m0/ping.ts [socket-path] [board.kicad_pcb]   (default /tmp/kicad/api.sock)
 * If a board path is given it is opened with OpenDocument first; note that preloading a
 * .kicad_pro on the server command line loads only the project, not the board.
 */

const socketPath = process.argv[2] ?? "/tmp/kicad/api.sock";
const boardPath = process.argv[3];

// ---------- minimal protobuf encode/decode ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
function bytesField(field: number, data: Uint8Array): Uint8Array {
  return Uint8Array.from([...varint((field << 3) | 2), ...varint(data.length), ...data]);
}
function stringField(field: number, s: string): Uint8Array {
  return bytesField(field, enc.encode(s));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

type Field = { wire: number; varint?: number; bytes?: Uint8Array };
function decode(buf: Uint8Array): Map<number, Field[]> {
  const fields = new Map<number, Field[]>();
  let i = 0;
  const readVarint = () => { let r = 0, s = 0, b: number; do { b = buf[i++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const key = readVarint();
    const field = key >>> 3, wire = key & 7;
    let f: Field;
    if (wire === 0) f = { wire, varint: readVarint() };
    else if (wire === 2) { const len = readVarint(); f = { wire, bytes: buf.subarray(i, i + len) }; i += len; }
    else if (wire === 1) { i += 8; f = { wire }; }
    else if (wire === 5) { i += 4; f = { wire }; }
    else throw new Error(`unsupported wire type ${wire}`);
    (fields.get(field) ?? fields.set(field, []).get(field)!).push(f);
  }
  return fields;
}
const first = (m: Map<number, Field[]>, n: number) => m.get(n)?.[0];
const str = (m: Map<number, Field[]>, n: number) => { const f = first(m, n); return f?.bytes ? dec.decode(f.bytes) : ""; };
const sub = (m: Map<number, Field[]>, n: number) => decode(first(m, n)?.bytes ?? new Uint8Array());

// ---------- kiapi envelope ----------
function apiRequest(typeName: string, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const header = stringField(2, "fp-pcb/m0-ping");                                   // ApiRequestHeader.client_name
  const any = concat(stringField(1, `type.googleapis.com/${typeName}`), bytesField(2, payload)); // google.protobuf.Any
  return concat(bytesField(1, header), bytesField(2, any));                             // ApiRequest
}
const STATUS = ["AS_UNKNOWN", "AS_OK", "AS_TIMEOUT", "AS_BAD_REQUEST", "AS_NOT_READY", "AS_UNHANDLED", "AS_TOKEN_MISMATCH", "AS_BUSY", "AS_UNIMPLEMENTED"];

// ---------- nng SP transport ----------
class NngReq {
  private buf = new Uint8Array(0);
  private handshaken = false;
  private pending: { id: number; resolve: (b: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  private nextId = 1;
  private sock!: Awaited<ReturnType<typeof Bun.connect>>;
  private ready!: () => void;
  private readyP = new Promise<void>((r) => (this.ready = r));

  async connect(path: string) {
    this.sock = await Bun.connect({
      unix: path,
      socket: {
        open: (s) => s.write(Uint8Array.from([0x00, 0x53, 0x50, 0x00, 0x00, 0x30, 0x00, 0x00])), // "\0SP\0" + REQ0
        data: (_s, chunk) => this.onData(new Uint8Array(chunk)),
        error: (_s, e) => this.pending?.reject(e),
        close: () => this.pending?.reject(new Error("socket closed")),
      },
    });
    await this.readyP;
  }

  private onData(chunk: Uint8Array) {
    if (process.env.DEBUG) console.log("recv", chunk.length, Buffer.from(chunk).toString("hex"));
    this.buf = concat(this.buf, chunk);
    if (!this.handshaken) {
      if (this.buf.length < 8) return;
      const h = this.buf.subarray(0, 8);
      const proto = (h[4] << 8) | h[5];
      if (h[0] !== 0 || h[1] !== 0x53 || h[2] !== 0x50 || proto !== 0x31)
        throw new Error(`unexpected SP handshake ${Buffer.from(h).toString("hex")} (expected REP0 peer)`);
      this.buf = this.buf.subarray(8);
      this.handshaken = true;
      this.ready();
    }
    while (this.buf.length >= 9) {
      if (this.buf[0] !== 0x01) throw new Error(`unexpected IPC frame type 0x${this.buf[0].toString(16)}`);
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset + 1, 8);
      const len = Number(dv.getBigUint64(0));
      if (this.buf.length < 9 + len) return;
      const body = this.buf.subarray(9, 9 + len);
      this.buf = this.buf.subarray(9 + len);
      const id = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
      if (this.pending && id === this.pending.id) {
        const p = this.pending; this.pending = null;
        p.resolve(body.subarray(4));
      }
    }
  }

  request(payload: Uint8Array, timeoutMs = 5000): Promise<Uint8Array> {
    if (this.pending) return Promise.reject(new Error("REQ/REP allows one request in flight"));
    const id = (this.nextId++ | 0x80000000) >>> 0;
    const body = new Uint8Array(4 + payload.length);
    new DataView(body.buffer).setUint32(0, id);
    body.set(payload, 4);
    const frame = new Uint8Array(9 + body.length);
    frame[0] = 0x01; // nng ipc message type: data
    new DataView(frame.buffer).setBigUint64(1, BigInt(body.length));
    frame.set(body, 9);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending = null; reject(new Error(`timeout after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending = { id, resolve: (b) => { clearTimeout(t); resolve(b); }, reject: (e) => { clearTimeout(t); reject(e); } };
      const n = this.sock.write(frame);
      if (process.env.DEBUG) console.log("sent", n, "/", frame.length, Buffer.from(frame).toString("hex"));
    });
  }
  close() { this.sock.end(); }
}

// ---------- main ----------
const req = new NngReq();
console.log(`connecting to ipc://${socketPath}`);
await req.connect(socketPath);
console.log("SP handshake ok (peer is REP0)");

async function call(typeName: string, payload?: Uint8Array) {
  const t0 = performance.now();
  const resp = decode(await req.request(apiRequest(typeName, payload)));
  const ms = (performance.now() - t0).toFixed(2);
  const status = sub(resp, 2);
  const code = first(status, 1)?.varint ?? 0;
  const token = str(sub(resp, 1), 1);
  console.log(`${typeName.split(".").pop()}: ${STATUS[code] ?? code} (${ms} ms) token=${token} ${str(status, 2)}`);
  return resp;
}

await call("kiapi.common.commands.Ping");
const v = await call("kiapi.common.commands.GetVersion");
const any = sub(v, 3);
console.log("  response type:", str(any, 1));
const ver = sub(sub(any, 2), 1); // GetVersionResponse.version → KiCadVersion
console.log(`  KiCad ${first(ver, 1)?.varint}.${first(ver, 2)?.varint}.${first(ver, 3)?.varint ?? 0}  "${str(ver, 4)}"`);

if (boardPath) {
  // OpenDocument{ type = DOCTYPE_PCB (3), path }
  const open = await call("kiapi.common.commands.OpenDocument", concat(Uint8Array.from([0x08, 0x03]), stringField(2, boardPath)));
  const spec = sub(sub(sub(open, 3), 2), 1);                   // OpenDocumentResponse.document
  console.log(`  opened: ${str(spec, 4)} in project "${str(sub(spec, 5), 1)}"`);
}
// GetOpenDocuments{ type = DOCTYPE_PCB (3) }; answers AS_UNHANDLED when no board is open
const docs = await call("kiapi.common.commands.GetOpenDocuments", Uint8Array.from([0x08, 0x03]));
for (const d of sub(sub(docs, 3), 2).get(1) ?? []) {           // GetOpenDocumentsResponse.documents[]
  const spec = decode(d.bytes!);
  const proj = sub(spec, 5);
  console.log(`  open PCB: ${str(spec, 4)}  project "${str(proj, 1)}" at ${str(proj, 2)}`);
}
req.close();
