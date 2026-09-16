/**
 * Integration check against a real wasm build: `Ping` and `GetVersion` straight through
 * `kiapi_dispatch`, no transport and no client in between.
 *
 * It skips (with a message) unless a build is present — `dist/kicad_api.js` after
 * `bun run --filter @fp-pcb/kicad-wasm fetch`, or `$KICAD_WASM_DIR/kicad_api.js`. Set
 * `KICAD_WASM_SHARE` to mount KiCad's share tree at `/kicad/share` when the build has no
 * `--preload-file` bundle.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { anyUnpack } from "@bufbuild/protobuf/wkt";
import {
  ApiRequestSchema,
  ApiResponseSchema,
  ApiStatusCode,
  GetVersionSchema,
  GetVersionResponseSchema,
  PingSchema,
  kiapiRegistry,
  packAny,
} from "@fp-pcb/proto";
import { createKiCadWasm, defaultModuleUrl, type KiCadWasm } from "../src/index";
import { mountProject } from "../src/fs";

const DIST_MODULE = new URL(defaultModuleUrl()).pathname;
const ENV_MODULE = process.env.KICAD_WASM_DIR ? join(resolve(process.env.KICAD_WASM_DIR), "kicad_api.js") : null;
const MODULE = [ENV_MODULE, DIST_MODULE].find((p): p is string => !!p && existsSync(p));

if (!MODULE) {
  console.log(
    `[skip] no KiCad wasm build at ${ENV_MODULE ?? DIST_MODULE} ` +
      `(build it, then 'bun run --filter @fp-pcb/kicad-wasm fetch', or set KICAD_WASM_DIR)`,
  );
}

function envelope(schema: Parameters<typeof packAny>[0], message: object): Uint8Array {
  return toBinary(
    ApiRequestSchema,
    create(ApiRequestSchema, { header: { clientName: "fp-pcb/kicad-wasm-test" }, message: packAny(schema, message as never) }),
  );
}

describe.skipIf(!MODULE)("kicad wasm module", () => {
  test("answers Ping and GetVersion", async () => {
    const kicad: KiCadWasm = await createKiCadWasm({
      moduleUrl: `file://${MODULE}`,
      wasmUrl: `file://${MODULE!.replace(/\.js$/, ".wasm")}`,
      printErr: (line) => console.error(`[kicad-wasm] ${line}`),
    });
    try {
      if (process.env.KICAD_WASM_SHARE) await mountProject(kicad, resolve(process.env.KICAD_WASM_SHARE), kicad.config.share);

      const ping = fromBinary(ApiResponseSchema, kicad.dispatch(envelope(PingSchema, create(PingSchema))));
      expect(ping.status?.status).toBe(ApiStatusCode.AS_OK);
      expect(ping.header?.kicadToken.length ?? 0).toBeGreaterThan(0);

      const versionRes = fromBinary(ApiResponseSchema, kicad.dispatch(envelope(GetVersionSchema, create(GetVersionSchema))));
      expect(versionRes.status?.status).toBe(ApiStatusCode.AS_OK);
      const version = anyUnpack(versionRes.message!, kiapiRegistry);
      const v = fromBinary(GetVersionResponseSchema, toBinary(GetVersionResponseSchema, version as never));
      expect(v.version?.major).toBeGreaterThanOrEqual(10);
      console.log(`[kicad-wasm] ${v.version?.fullVersion}`);
    } finally {
      kicad.shutdown();
    }
  }, 120_000);
});
