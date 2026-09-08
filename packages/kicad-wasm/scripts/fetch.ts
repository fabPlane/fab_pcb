#!/usr/bin/env bun
/**
 * Copies the Emscripten build of KiCad's API core into `dist/`, where `createKiCadWasm()` looks for
 * it by default:
 *
 *   bun run --filter @fp-pcb/kicad-wasm fetch
 *   KICAD_WASM_DIR=/path/to/build/wasm/host bun run fetch
 *
 * Source directory: `$KICAD_WASM_DIR`, else `$KICAD_SRC/build/wasm/host`, else
 * `../../../kicad/build/wasm/host` next to the repo. `kicad_api.js` and `kicad_api.wasm` are
 * required; `kicad_api.data` (an Emscripten `--preload-file` bundle, e.g. KiCad's share tree) and
 * `kicad_api.worker.js` are copied when present.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(PKG, "../../../kicad");
const SRC = resolve(process.env.KICAD_WASM_DIR ?? join(KICAD_ROOT, "build/wasm/host"));
const DIST = join(PKG, "dist");

const REQUIRED = ["kicad_api.js", "kicad_api.wasm"];
const OPTIONAL = ["kicad_api.data", "kicad_api.worker.js", "kicad_api.js.map", "kicad_api.wasm.map"];

if (!existsSync(SRC)) {
  console.error(`error: ${SRC} does not exist.
Build the wasm host first (see docs/08-wasm.md) or point KICAD_WASM_DIR at the build output.`);
  process.exit(1);
}

const missing = REQUIRED.filter((f) => !existsSync(join(SRC, f)));
if (missing.length > 0) {
  console.error(`error: ${SRC} is missing ${missing.join(", ")}`);
  process.exit(1);
}

await mkdir(DIST, { recursive: true });
let total = 0;
for (const name of [...REQUIRED, ...OPTIONAL]) {
  const from = join(SRC, name);
  if (!existsSync(from)) continue;
  await copyFile(from, join(DIST, name));
  const { size } = await stat(from);
  total += size;
  console.log(`  ${name.padEnd(22)} ${(size / 1024 / 1024).toFixed(2)} MiB`);
}
console.log(`copied ${(total / 1024 / 1024).toFixed(2)} MiB from ${SRC} to ${DIST}`);
