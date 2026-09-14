/**
 * A mock of `kicad_api.js` that answers the real KiCad envelope, plus the wiring to run
 * `worker-core.ts` in the test process.
 *
 * The default export is what `import(moduleUrl)` must find: the Emscripten factory. That is the
 * whole point of the file — the worker resolves its module by URL, so a test that wants to exercise
 * the worker end to end needs a URL to point at, and `import.meta.url` of this file is one
 * (`MOCK_ENTRY_URL`). Bun transpiles it on import; a browser never sees it.
 *
 * `inProcessWorker()` is the other half: a `Worker`-shaped object whose messages go to a
 * `serveKiCadWasm` port in this same process, so `worker-client.ts` can be driven with no real
 * thread and no bundler.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { anyUnpack } from "@bufbuild/protobuf/wkt";
import {
  ApiRequestSchema,
  ApiResponseSchema,
  ApiStatusCode,
  EmptySchema,
  EventSchema,
  GetOpenDocumentsResponseSchema,
  GetVersionResponseSchema,
  kiapiRegistry,
  packAny,
} from "@fp-pcb/proto";
import { createMockFactory } from "./mock-module";
import { serveKiCadWasm } from "../src/worker-core";
import type { KiCadWasmWorkerLike, KiCadWasmWorkerPort } from "../src/worker-protocol";

/** The token this mock reports, i.e. what a client connecting to it ends up holding. */
export const MOCK_TOKEN = "wasm-token-0000-0000-0000-000000000000";

/** One `DocumentSaved` frame, published from inside every `Ping` dispatch. */
export const SAVED_EVENT = toBinary(EventSchema, create(EventSchema, { sequence: 7n, kind: { case: "documentSaved", value: {} } }));

/** A request whose payload is exactly this makes the mock abort the way Emscripten does. */
export const ABORT_REQUEST = new Uint8Array([0xde, 0xad]);

/** The whole server, synchronous, because `kiapi_dispatch` is. */
export function respond(request: Uint8Array): Uint8Array {
  if (request.length === ABORT_REQUEST.length && request.every((b, i) => b === ABORT_REQUEST[i])) {
    // What a headless GUI stub reaching `___trap()` looks like from JavaScript.
    throw new WebAssembly.RuntimeError("abort(native code called abort())");
  }
  const envelope = fromBinary(ApiRequestSchema, request);
  const any = envelope.message;
  const name = any ? any.typeUrl.slice(any.typeUrl.lastIndexOf("/") + 1) : "";
  if (any) anyUnpack(any, kiapiRegistry); // the same decode the real server does
  const message =
    name === "kiapi.common.commands.GetVersion"
      ? packAny(
          GetVersionResponseSchema,
          create(GetVersionResponseSchema, { version: { major: 10, minor: 99, patch: 0, fullVersion: "10.99.0-wasm" } }),
        )
      : name === "kiapi.board.commands.GetOpenDocuments"
        ? packAny(GetOpenDocumentsResponseSchema, create(GetOpenDocumentsResponseSchema, { documents: [] }))
        : packAny(EmptySchema, create(EmptySchema));
  return toBinary(
    ApiResponseSchema,
    create(ApiResponseSchema, { header: { kicadToken: MOCK_TOKEN }, status: { status: ApiStatusCode.AS_OK }, message }),
  );
}

function eventsPerDispatch(req: Uint8Array): Uint8Array[] {
  try {
    return fromBinary(ApiRequestSchema, req).message?.typeUrl.endsWith("Ping") ? [SAVED_EVENT] : [];
  } catch {
    return [];
  }
}

/** `import(MOCK_ENTRY_URL)` gives a module whose default export is this factory. */
export default createMockFactory({ reply: respond, eventsPerDispatch });

/** What a worker's `moduleUrl` has to be pointed at to load the mock above. */
export const MOCK_ENTRY_URL = import.meta.url;

export interface InProcessWorker extends KiCadWasmWorkerLike {
  readonly terminated: boolean;
}

/**
 * A `Worker`-shaped object wired to a `serveKiCadWasm()` port in this process. Messages cross on a
 * microtask, so the ordering the client relies on (one dispatch at a time, events after their
 * reply) is exercised; transfer lists are ignored, which only means nothing is neutered.
 */
export function inProcessWorker(): InProcessWorker {
  let terminated = false;
  const port: KiCadWasmWorkerPort = {
    onmessage: null,
    postMessage(message: unknown) {
      if (terminated) return;
      queueMicrotask(() => worker.onmessage?.({ data: message } as unknown as MessageEvent));
    },
    close() {
      terminated = true;
    },
  };
  const worker: InProcessWorker = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown) {
      if (terminated) return;
      queueMicrotask(() => port.onmessage?.({ data: message } as unknown as MessageEvent));
    },
    terminate() {
      terminated = true;
    },
    get terminated() {
      return terminated;
    },
  };
  serveKiCadWasm(port);
  return worker;
}
