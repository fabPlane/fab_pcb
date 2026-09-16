/**
 * The loader against `mock-module.ts`: config marshalling, the event callback, heap copies around
 * `kiapi_dispatch`, error reporting and the MEMFS helpers.
 */
import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ApiRequestSchema, ApiResponseSchema, ApiStatusCode, EmptySchema, PingSchema, packAny } from "@fp-pcb/proto";
import { mkdtemp, mkdir, writeFile as hostWriteFile, readFile as hostReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiCadWasmError, createKiCadWasm } from "../src/index";
import { exists, exportDir, listFiles, mountProject, readTextFile, writeFile } from "../src/fs";
import { createMockFactory } from "./mock-module";

const PING_REQUEST = toBinary(
  ApiRequestSchema,
  create(ApiRequestSchema, {
    header: { clientName: "fp-pcb/kicad-wasm" },
    message: packAny(PingSchema, create(PingSchema)),
  }),
);

const PING_RESPONSE = toBinary(
  ApiResponseSchema,
  create(ApiResponseSchema, {
    header: { kicadToken: "wasm-token" },
    status: { status: ApiStatusCode.AS_OK },
    message: packAny(EmptySchema, create(EmptySchema)),
  }),
);

/** A module that answers the canned `Ping` and nothing else. */
const pingFactory = (extra: Parameters<typeof createMockFactory>[0] = {}) =>
  createMockFactory({
    reply: (req) => (equalBytes(req, PING_REQUEST) ? PING_RESPONSE : null),
    ...extra,
  });

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

describe("createKiCadWasm", () => {
  test("passes the config to kiapi_init and creates home/share in MEMFS", async () => {
    const factory = pingFactory();
    const kicad = await createKiCadWasm({
      module: factory,
      home: "/home/kicad",
      share: "/kicad/share",
      env: { KICAD10_SYMBOL_DIR: "/kicad/share/symbols" },
      token: "wasm-token",
    });
    const cfg = JSON.parse((kicad.module as unknown as { initConfig: string }).initConfig);
    expect(cfg).toEqual({
      home: "/home/kicad",
      share: "/kicad/share",
      env: { KICAD10_SYMBOL_DIR: "/kicad/share/symbols" },
      preload: "",
      token: "wasm-token",
      publishEvents: true,
    });
    expect(exists(kicad, "/home/kicad")).toBe(true);
    expect(exists(kicad, "/kicad/share")).toBe(true);
    kicad.shutdown();
  });

  test("dispatch round-trips the ApiRequest/ApiResponse bytes and frees the reply", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory() });
    const reply = kicad.dispatch(PING_REQUEST);
    const res = fromBinary(ApiResponseSchema, reply);
    expect(res.status?.status).toBe(ApiStatusCode.AS_OK);
    expect(res.header?.kicadToken).toBe("wasm-token");
    const m = kicad.module as unknown as { freedReplies: number[]; liveAllocations(): number; requests: Uint8Array[] };
    expect(m.freedReplies.length).toBe(1);
    expect(m.liveAllocations()).toBe(0); // request buffer, out-length cell and reply all released
    expect(m.requests.length).toBe(1);
    kicad.shutdown();
  });

  test("survives a heap that grows during the dispatch", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory({ growHeapOnDispatch: true }) });
    const res = fromBinary(ApiResponseSchema, kicad.dispatch(PING_REQUEST));
    expect(res.status?.status).toBe(ApiStatusCode.AS_OK);
    kicad.shutdown();
  });

  test("reports kiapi_last_error when the dispatch returns null", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory() });
    const err = (() => {
      try {
        kicad.dispatch(new Uint8Array([1, 2, 3]));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(KiCadWasmError);
    expect(err!.message).toContain("kiapi_dispatch returned null");
    expect(err!.message).toContain("no handler for this request");
    kicad.shutdown();
  });

  test("throws with the module's error when kiapi_init fails", async () => {
    const err = (await createKiCadWasm({
      module: createMockFactory({ initResult: 2, lastError: "no share directory at /kicad/share" }),
    }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(KiCadWasmError);
    expect(err.message).toContain("kiapi_init returned 2");
    expect(err.message).toContain("no share directory");
  });

  test("delivers events from Module.__kiapiEvent to onEvent listeners and the option callback", async () => {
    const fromOption: string[] = [];
    const kicad = await createKiCadWasm({
      module: pingFactory({ eventsPerDispatch: () => [new TextEncoder().encode("event-1")] }),
      onEvent: (b) => fromOption.push(new TextDecoder().decode(b)),
    });
    const seen: string[] = [];
    const off = kicad.onEvent((b) => seen.push(new TextDecoder().decode(b)));
    kicad.dispatch(PING_REQUEST);
    expect(seen).toEqual(["event-1"]);
    expect(fromOption).toEqual(["event-1"]);
    off();
    kicad.dispatch(PING_REQUEST);
    expect(seen.length).toBe(1);
    expect(fromOption.length).toBe(2);
    kicad.shutdown();
  });

  test("accepts exports without the leading underscore and rejects a module missing them", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory({ exportWithoutUnderscore: true }) });
    expect(fromBinary(ApiResponseSchema, kicad.dispatch(PING_REQUEST)).status?.status).toBe(ApiStatusCode.AS_OK);
    kicad.shutdown();

    const err = (await createKiCadWasm({ module: async () => ({ HEAPU8: new Uint8Array(8) }) as never }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(KiCadWasmError);
    expect(err.message).toContain("does not export");
  });

  test("shutdown() calls kiapi_shutdown once and refuses later dispatches", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory() });
    kicad.shutdown();
    kicad.shutdown();
    expect((kicad.module as unknown as { shutdowns: number }).shutdowns).toBe(1);
    expect(kicad.isShutDown).toBe(true);
    expect(() => kicad.dispatch(PING_REQUEST)).toThrow(/shut down/);
  });

  test("a missing dist/kicad_api.js gives an actionable error", async () => {
    const err = (await createKiCadWasm({ moduleUrl: "file:///nonexistent/kicad_api.js" }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(KiCadWasmError);
    expect(err.message).toContain("bun run --filter @fp-pcb/kicad-wasm fetch");
  });
});

describe("MEMFS helpers", () => {
  test("mountProject copies a host tree in at the same absolute path", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory() });
    const dir = await mkdtemp(join(tmpdir(), "fp-pcb-wasm-fs-"));
    await hostWriteFile(join(dir, "board.kicad_pcb"), "(kicad_pcb)");
    await mkdir(join(dir, "libs"), { recursive: true });
    await hostWriteFile(join(dir, "libs", "R.kicad_mod"), "(module R)");

    const r = await mountProject(kicad, dir);
    expect(r.files).toBe(2);
    expect(r.memfsDir).toBe(dir);
    expect(readTextFile(kicad, join(dir, "board.kicad_pcb"))).toBe("(kicad_pcb)");
    expect(readTextFile(kicad, join(dir, "libs/R.kicad_mod"))).toBe("(module R)");
    expect(listFiles(kicad, dir)).toEqual([join(dir, "board.kicad_pcb"), join(dir, "libs/R.kicad_mod")]);

    // ... and back out again, which is how a job's output files leave MEMFS
    writeFile(kicad, join(dir, "out/report.txt"), "drc: 0 violations");
    const outDir = await mkdtemp(join(tmpdir(), "fp-pcb-wasm-out-"));
    expect(await exportDir(kicad, join(dir, "out"), outDir)).toBe(1);
    expect(await hostReadFile(join(outDir, "report.txt"), "utf8")).toBe("drc: 0 violations");
    kicad.shutdown();
  });

  test("mountProject honours a filter and a different MEMFS destination", async () => {
    const kicad = await createKiCadWasm({ module: pingFactory() });
    const dir = await mkdtemp(join(tmpdir(), "fp-pcb-wasm-filter-"));
    await hostWriteFile(join(dir, "keep.kicad_sym"), "(symbol)");
    await hostWriteFile(join(dir, "skip.log"), "noise");
    const r = await mountProject(kicad, dir, "/kicad/share/symbols", { filter: (rel) => !rel.endsWith(".log") });
    expect(r.files).toBe(1);
    expect(listFiles(kicad, "/kicad/share/symbols")).toEqual(["/kicad/share/symbols/keep.kicad_sym"]);
    kicad.shutdown();
  });
});
