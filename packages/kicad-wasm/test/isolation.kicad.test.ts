/**
 * Two modules, one process: the isolation property the whole "one instance per session" design
 * rests on. Each instance gets its *own* MEMFS holding a different board at a different path, and
 * the test checks that neither can see the other's document, that shutting one down leaves the
 * other answering, and that a dead instance refuses work instead of touching a freed heap.
 *
 * It also prints the process RSS delta per instance, which is the number that decides how many
 * sessions fit in a bridge process.
 *
 * Skips (with a message) unless a real build is present — `dist/kicad_api.js` after
 * `bun run --filter @fp-pcb/kicad-wasm fetch`, or `$KICAD_WASM_DIR/kicad_api.js`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { anyUnpack } from "@bufbuild/protobuf/wkt";
import {
  ApiRequestSchema,
  ApiResponseSchema,
  ApiStatusCode,
  DocumentType,
  GetOpenDocumentsResponseSchema,
  GetOpenDocumentsSchema,
  GetVersionResponseSchema,
  GetVersionSchema,
  OpenDocumentSchema,
  kiapiRegistry,
  packAny,
} from "@fp-pcb/proto";
import { createKiCadWasm, defaultModuleUrl, type KiCadWasm } from "../src/index";
import { mountPath, mountProject } from "../src/fs";

const DIST_MODULE = new URL(defaultModuleUrl()).pathname;
const ENV_MODULE = process.env.KICAD_WASM_DIR ? join(resolve(process.env.KICAD_WASM_DIR), "kicad_api.js") : null;
const MODULE = [ENV_MODULE, DIST_MODULE].find((p): p is string => !!p && existsSync(p));

/** KiCad's source tree, for the QA boards; `KICAD_SRC` overrides the sibling checkout. */
const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(import.meta.dir, "../../../../kicad");
/** Two *different* boards, so "each instance sees its own" is visible in the item counts too. */
const FIXTURES = [`${KICAD_ROOT}/qa/data/pcbnew/api_kitchen_sink.kicad_pcb`, `${KICAD_ROOT}/qa/data/pcbnew/custom_pads.kicad_pcb`];

const READY = !!MODULE && FIXTURES.every((f) => existsSync(f));
if (!READY) {
  console.log(
    `[skip] isolation test needs a wasm build at ${ENV_MODULE ?? DIST_MODULE} and the QA boards under ${KICAD_ROOT}/qa/data/pcbnew`,
  );
}

type Schema = Parameters<typeof packAny>[0];

function envelope(schema: Schema, init: object = {}): Uint8Array {
  return toBinary(
    ApiRequestSchema,
    create(ApiRequestSchema, {
      header: { clientName: "fp-pcb/isolation-test" },
      message: packAny(schema, create(schema as never, init as never) as never),
    }),
  );
}

/** Dispatch one command, asserting `AS_OK`; returns the raw response. */
function call(kicad: KiCadWasm, reqSchema: Schema, init: object = {}): { message?: unknown } {
  const res = fromBinary(ApiResponseSchema, kicad.dispatch(envelope(reqSchema, init)));
  expect(res.status?.status).toBe(ApiStatusCode.AS_OK);
  return res as { message?: unknown };
}

/** Same, with the payload unpacked into `resSchema`. */
function callFor<T extends object>(kicad: KiCadWasm, reqSchema: Schema, init: object, resSchema: Schema): T {
  const res = call(kicad, reqSchema, init);
  const unpacked = anyUnpack(res.message as never, kiapiRegistry);
  return fromBinary(resSchema as never, toBinary(resSchema as never, unpacked as never)) as T;
}

const dirs: string[] = [];
async function fixtureDir(name: string, board: string): Promise<{ dir: string; pcb: string }> {
  const dir = await mkdtemp(join(tmpdir(), `fp-pcb-iso-${name}-`));
  dirs.push(dir);
  const pcb = join(dir, `${name}.kicad_pcb`);
  await cp(board, pcb);
  return { dir, pcb };
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe.skipIf(!READY)("two wasm instances in one process", () => {
  test("keep separate MEMFS, separate documents, and separate lifetimes", async () => {
    const a = await fixtureDir("alpha", FIXTURES[0]!);
    const b = await fixtureDir("beta", FIXTURES[1]!);

    const rssBefore = process.memoryUsage.rss();
    const spawn = async (): Promise<KiCadWasm> =>
      createKiCadWasm({
        moduleUrl: `file://${MODULE}`,
        wasmUrl: `file://${MODULE!.replace(/\.js$/, ".wasm")}`,
        printErr: () => {},
      });

    const one = await spawn();
    const rssOne = process.memoryUsage.rss();
    const two = await spawn();
    const rssTwo = process.memoryUsage.rss();

    try {
      // Different content at different absolute paths: neither module has ever seen the other tree.
      if (process.env.KICAD_WASM_SHARE) {
        for (const k of [one, two]) await mountProject(k, resolve(process.env.KICAD_WASM_SHARE), k.config.share);
      }
      await mountPath(one, a.dir);
      await mountPath(two, b.dir);

      expect(() => one.FS.stat(b.pcb)).toThrow(); // beta's tree is not in alpha's file system
      expect(() => two.FS.stat(a.pcb)).toThrow();

      // Both answer GetVersion, and both say the same thing: one binary, two heaps.
      const va = callFor<{ version?: { fullVersion: string } }>(one, GetVersionSchema, {}, GetVersionResponseSchema);
      const vb = callFor<{ version?: { fullVersion: string } }>(two, GetVersionSchema, {}, GetVersionResponseSchema);
      expect(va.version?.fullVersion).toBe(vb.version!.fullVersion!);

      // Nothing is open anywhere yet.
      const openIn = (k: KiCadWasm): string[] =>
        callFor<{ documents: { identifier: { case?: string; value?: string } }[] }>(
          k,
          GetOpenDocumentsSchema,
          { type: DocumentType.DOCTYPE_PCB },
          GetOpenDocumentsResponseSchema,
        ).documents.map((d) => d.identifier.value ?? "");
      expect(openIn(one)).toEqual([]);
      expect(openIn(two)).toEqual([]);

      call(one, OpenDocumentSchema, { type: DocumentType.DOCTYPE_PCB, path: a.pcb });
      expect(openIn(one)).toEqual(["alpha.kicad_pcb"]);
      expect(openIn(two)).toEqual([]); // opening in one instance is invisible in the other

      call(two, OpenDocumentSchema, { type: DocumentType.DOCTYPE_PCB, path: b.pcb });
      expect(openIn(two)).toEqual(["beta.kicad_pcb"]);
      expect(openIn(one)).toEqual(["alpha.kicad_pcb"]); // ...and does not disturb it either

      const rssOpen = process.memoryUsage.rss();

      // Shutting one down leaves the other working, and the dead one refuses instead of crashing.
      one.shutdown();
      expect(one.isShutDown).toBe(true);
      expect(() => one.dispatch(envelope(GetVersionSchema))).toThrow();
      expect(openIn(two)).toEqual(["beta.kicad_pcb"]);
      expect(two.isShutDown).toBe(false);

      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
      console.log(
        `[isolation] RSS: ${mb(rssBefore)} before, ${mb(rssOne)} with one instance (+${mb(rssOne - rssBefore)}), ` +
          `${mb(rssTwo)} with two (+${mb(rssTwo - rssOne)} for the second), ${mb(rssOpen)} with a board open in each`,
      );
    } finally {
      one.shutdown();
      two.shutdown();
    }
  }, 300_000);
});
