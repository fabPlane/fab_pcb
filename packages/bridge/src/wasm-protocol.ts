/**
 * The message protocol between the bridge's main thread (`WasmSession`) and the worker that owns
 * one `createKiCadWasm()` instance (`wasm-worker.ts`), plus the two bits of envelope sniffing the
 * worker needs to know when MEMFS has to be flushed back to the workspace.
 *
 * Both directions are structured-clone messages, never shared memory: request and reply bodies
 * travel as `Uint8Array` whose `ArrayBuffer` is transferred, so a board's worth of bytes moves
 * without a copy and the sender's view is neutered afterwards (both sides therefore hand over
 * buffers they own).
 *
 *   main -> worker   { start }            once, first
 *                    { id, req }          one ApiRequest
 *                    { flush }            export MEMFS back to the host now
 *                    { stop }             shut the module down and close the worker
 *   worker -> main   { state, message? }  starting -> running | failed | exited
 *                    { id, res }          the ApiResponse for that id
 *                    { id, error }        that request failed (no reply bytes exist)
 *                    { event }            one kiapi.common.events.Event frame
 *                    { log }              a diagnostic line for the session log ring
 *                    { error }            a fatal error outside any request
 */

/** Which implementation runs KiCad for a session. */
export type SessionBackend = "process" | "wasm";

export function isSessionBackend(v: unknown): v is SessionBackend {
  return v === "process" || v === "wasm";
}

/** Everything the worker is told once, before it loads the module. */
export interface WasmWorkerInit {
  sessionId: string;
  /**
   * ES module whose default export is the Emscripten factory (`kicad_api.js`). A file path is
   * accepted; the worker turns it into a `file://` URL. Tests point this at a JS mock of the ABI.
   */
  moduleUrl: string;
  /**
   * Host directory copied into MEMFS *at the same absolute path* before `kiapi_init` runs, so the
   * paths inside `.kicad_pro` / `fp-lib-table` stay valid. Null for a session with no project.
   */
  projectDir: string | null;
  /** MEMFS path `kiapi_init` opens at startup (the session's document), or `""`. */
  preload: string;
  /** Host share tree mounted at `share` when the build carries no `--preload-file` bundle. */
  shareDir: string | null;
  /** `kiapi_init` config: a writable MEMFS home, the share tree, extra env, the API token. */
  home: string;
  share: string;
  env: Record<string, string>;
  token: string;
  publishEvents: boolean;
}

export type ToWasmWorker = { start: WasmWorkerInit } | { id: number; req: Uint8Array } | { flush: true } | { stop: true };

/** `starting` until `kiapi_init` returns; `exited` after a clean stop, `failed` otherwise. */
export type WasmWorkerState = "starting" | "running" | "failed" | "exited";

export type FromWasmWorker =
  | { state: WasmWorkerState; message?: string }
  | { id: number; res: Uint8Array }
  | { id: number; error: string }
  | { event: Uint8Array }
  | { log: string }
  | { error: string };

/**
 * The `type.googleapis.com/<name>` inside an `ApiRequest`'s `Any`, reduced to the bare message
 * name (`SaveDocument`). `""` when the bytes are not a readable envelope — the worker only uses
 * this to decide whether to flush MEMFS, so a miss costs a missing flush, never a wrong reply.
 */
export function requestTypeName(request: Uint8Array): string {
  try {
    for (const f of scan(request)) {
      if (f.field !== 2 || !f.bytes) continue; // ApiRequest.message (google.protobuf.Any)
      for (const a of scan(f.bytes)) {
        if (a.field !== 1 || !a.bytes) continue; // Any.type_url
        const url = new TextDecoder().decode(a.bytes);
        return (
          url
            .slice(url.lastIndexOf("/") + 1)
            .split(".")
            .pop() ?? ""
        );
      }
    }
  } catch {
    /* not a well-formed envelope */
  }
  return "";
}

/**
 * Requests after which the project directory is copied back out of MEMFS.
 *
 * Everything whose name starts with `Save` (`SaveDocument`, `SaveCopyOfDocument`,
 * `SaveDocumentAs`, ...) plus `CloseDocument`, which is KiCad's other chance to touch the file.
 * `EndCommit` is deliberately *not* in the list: a commit changes the in-memory document and
 * leaves the file alone, so flushing there would rewrite every file in the project on every edit.
 * The two other triggers are a `DocumentSaved` event (a save KiCad started by itself, e.g. from a
 * job) and an explicit `{flush}` message.
 */
export function shouldFlushAfter(typeName: string): boolean {
  return typeName.startsWith("Save") || typeName === "CloseDocument";
}

interface Field {
  field: number;
  bytes?: Uint8Array;
}

/** Minimal protobuf field walk — length-delimited fields only, everything else skipped. */
function scan(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): number => {
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
    const key = varint();
    const wire = key & 7;
    const field = key >>> 3;
    if (wire === 0) varint();
    else if (wire === 2) {
      const len = varint();
      out.push({ field, bytes: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}
