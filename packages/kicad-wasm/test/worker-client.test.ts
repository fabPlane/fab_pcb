/**
 * The Worker protocol, end to end without a Worker: `createKiCadWasmInWorker()` on one side,
 * `serveKiCadWasm()` on the other, joined by `inProcessWorker()` and pointed at the JS mock of the
 * `kiapi_*` ABI. Everything a browser adds on top of that — the thread, the bundler's URL for
 * `worker.ts` — is what `apps/web` exercises by hand against the real module.
 */
import { describe, expect, test } from "bun:test";
import { createKiCadWasmInWorker } from "../src/worker-client";
import { ABORT_REQUEST, MOCK_ENTRY_URL, SAVED_EVENT, inProcessWorker, respond } from "./kicad-mock-entry";
import { WASM_ABORT_ERROR_NAME } from "../src/worker-protocol";
import { create, toBinary } from "@bufbuild/protobuf";
import { ApiRequestSchema, PingSchema, packAny } from "@fp-pcb/proto";

const PING = toBinary(ApiRequestSchema, create(ApiRequestSchema, { message: packAny(PingSchema, create(PingSchema)) }));
const bytes = (text: string) => new TextEncoder().encode(text);

function start(files?: { path: string; bytes: Uint8Array }[]) {
  return createKiCadWasmInWorker({ moduleUrl: MOCK_ENTRY_URL, createWorker: inProcessWorker, files, startTimeoutMs: 10_000 });
}

describe("the module in a worker", () => {
  test("starts, dispatches and shuts down", async () => {
    const wasm = await start();
    expect(wasm.state).toBe("running");
    expect(wasm.isShutDown).toBe(false);

    const reply = await wasm.dispatchAsync(PING);
    expect(reply).toEqual(respond(PING));
    // The caller's request bytes survive the transfer (the client sends a copy).
    expect(PING.length).toBeGreaterThan(0);

    await wasm.shutdown();
    expect(wasm.isShutDown).toBe(true);
    await expect(wasm.dispatchAsync(PING)).rejects.toThrow(/not running/);
  });

  test("cannot be dispatched synchronously, and says why", async () => {
    const wasm = await start();
    expect(() => wasm.dispatch(PING)).toThrow(/dispatchAsync/);
    await wasm.shutdown();
  });

  test("carries the module's event frames back", async () => {
    const wasm = await start();
    const seen: Uint8Array[] = [];
    const off = wasm.onEvent((b) => void seen.push(b));
    await wasm.dispatchAsync(PING); // the mock publishes one DocumentSaved per Ping
    // The event is posted from inside the dispatch; it lands on the next turn of the loop.
    await new Promise((r) => setTimeout(r, 10));
    off();
    expect(seen.map((b) => [...b])).toEqual([[...SAVED_EVENT]]);
    await wasm.shutdown();
  });

  test("answers the file operations the app needs, over messages", async () => {
    const wasm = await start([{ path: "/project/seeded.kicad_pro", bytes: bytes("{}") }]);
    // Seeded from inside the module factory, i.e. before kiapi_init would have read `preload`.
    expect(await wasm.exists("/project/seeded.kicad_pro")).toBe(true);

    expect(await wasm.writeFiles([{ path: "/project/demo.kicad_pcb", bytes: bytes("(kicad_pcb)") }])).toBe(1);
    expect(await wasm.exists("/project/demo.kicad_pcb")).toBe(true);
    expect(await wasm.exists("/project/missing.kicad_pcb")).toBe(false);
    expect(await wasm.stat("/project/demo.kicad_pcb")).toEqual({ kind: "file", size: 11 });
    expect(await wasm.stat("/project")).toMatchObject({ kind: "dir" });
    expect(await wasm.stat("/project/missing.kicad_pcb")).toBeNull();
    expect(await wasm.listFiles("/project")).toEqual(["/project/demo.kicad_pcb", "/project/seeded.kicad_pro"]);
    expect(new TextDecoder().decode(await wasm.readFile("/project/demo.kicad_pcb"))).toBe("(kicad_pcb)");

    await wasm.mkdir("/project/out/gerbers");
    expect(await wasm.stat("/project/out/gerbers")).toMatchObject({ kind: "dir" });
    await expect(wasm.readFile("/project/missing")).rejects.toThrow();
    await wasm.shutdown();
  });

  test("keeps the caller's bytes: an import can be replayed into the next module", async () => {
    const wasm = await start();
    const file = { path: "/project/keep.kicad_pcb", bytes: bytes("(kicad_pcb)") };
    await wasm.writeFiles([file]);
    // A transfer list would have neutered this, which is how a replay silently writes 0 bytes.
    expect(file.bytes.byteLength).toBe(11);
    await wasm.writeFiles([file]);
    expect(await wasm.stat(file.path)).toEqual({ kind: "file", size: 11 });
    await wasm.shutdown();
  });

  test("reports an abort as fatal, so the transport can close instead of waiting", async () => {
    const wasm = await start();
    const err = await wasm.dispatchAsync(ABORT_REQUEST).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.name).toBe(WASM_ABORT_ERROR_NAME);
    expect(err?.message).toMatch(/abort/);
    // The worker said `failed` with it: the client is done, not merely one request.
    expect(wasm.state).toBe("failed");
    expect(wasm.isShutDown).toBe(true);
    await wasm.shutdown();
  });

  test("fails to start when the module URL has no factory", async () => {
    await expect(createKiCadWasmInWorker({ moduleUrl: "", createWorker: inProcessWorker, startTimeoutMs: 5000 })).rejects.toThrow(
      /moduleUrl/,
    );
  });
});
