#!/usr/bin/env bun
/** Assemble a relocatable FabPlane PCB backend: fork runtime, bridge executable, and libraries. */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { targetSpec, validateLibraryDirectory } from "./bundle-lib";

const [target, runtimeArg, footprintsArg, symbolsArg, outputArg] = process.argv.slice(2);
if (!target || !runtimeArg || !footprintsArg || !symbolsArg || !outputArg) {
  console.error("usage: bundle.ts <linux-x64|darwin-x64|darwin-arm64|windows-x64> <kicad-runtime-dir> <footprints-dir> <symbols-dir> <output-dir>");
  process.exit(2);
}
const spec = targetSpec(target);
const runtime = resolve(runtimeArg);
const footprints = resolve(footprintsArg);
const symbols = resolve(symbolsArg);
const output = resolve(outputArg);
await validateLibraryDirectory("footprint", footprints);
await validateLibraryDirectory("symbol", symbols);
if (!(await stat(runtime).catch(() => null))?.isDirectory()) throw new Error(`KiCad runtime directory not found: ${runtime}`);

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "bin"), { recursive: true });
await cp(runtime, join(output, "kicad"), { recursive: true, preserveTimestamps: true });
await cp(footprints, join(output, "libraries", "footprints"), { recursive: true, preserveTimestamps: true });
await cp(symbols, join(output, "libraries", "symbols"), { recursive: true, preserveTimestamps: true });

const bridge = join(output, "bin", spec.bridgeName);
const build = Bun.spawn([
  "bun", "build", join(import.meta.dir, "..", "bridge", "src", "main.ts"), "--compile", `--target=${spec.bunTarget}`, `--outfile=${bridge}`,
], { cwd: resolve(import.meta.dir, "../.."), stdout: "inherit", stderr: "inherit" });
if (await build.exited) throw new Error(`bridge compilation failed for ${spec.bunTarget}`);

const cli = await findFile(join(output, "kicad"), spec.kicadCliName);
if (!cli) throw new Error(`${spec.kicadCliName} is absent from ${runtime}`);
const relativeCli = cli.slice(output.length + 1).replaceAll("\\", "/");
await Bun.write(join(output, "bundle.json"), JSON.stringify({
  format: 1,
  target,
  kicadCli: relativeCli,
  bridge: `bin/${spec.bridgeName}`,
  footprints: "libraries/footprints",
  symbols: "libraries/symbols",
  environment: { KICAD_SOCKET_TRANSPORT: spec.socketTransport },
}, null, 2) + "\n");
console.log(`FabPlane PCB bundle: ${output} (${basename(cli)}, ${await countLibraries(footprints, ".pretty")} footprint libraries, ${await countLibraries(symbols, ".kicad_sym")} symbol libraries)`);

async function findFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    }
  }
  return null;
}

async function countLibraries(root: string, suffix: string): Promise<number> {
  return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.name.endsWith(suffix)).length;
}
