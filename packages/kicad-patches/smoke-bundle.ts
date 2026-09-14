#!/usr/bin/env bun
/** Native smoke for a completed backend bundle. */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { validateRelocatableSymlinks } from "./bundle-lib";

interface Manifest {
  format: 1;
  target: string;
  kicadCli: string;
  stockData: string;
  bridge: string;
  footprints: string;
  symbols: string;
  jsAutorouter?: string;
  libraryPaths?: string[];
  environment?: Record<string, string>;
}

const manifestArg = process.argv[2];
const expectedTarget = process.argv[3];
if (!manifestArg || !expectedTarget) {
  console.error("usage: smoke-bundle.ts <bundle.json> <expected-target>");
  process.exit(2);
}
const manifestPath = resolve(manifestArg);
const root = dirname(manifestPath);
await validateRelocatableSymlinks(root);
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
if (manifest.format !== 1) throw new Error(`unsupported bundle format ${String(manifest.format)}`);
if (manifest.target !== expectedTarget) throw new Error(`bundle target ${manifest.target} != ${expectedTarget}`);

const paths = {
  cli: resolve(root, manifest.kicadCli),
  stockData: resolve(root, manifest.stockData),
  bridge: resolve(root, manifest.bridge),
  footprints: resolve(root, manifest.footprints),
  symbols: resolve(root, manifest.symbols),
};
for (const [label, path] of Object.entries(paths)) {
  if (!(await stat(path).catch(() => null))) throw new Error(`${label} missing: ${path}`);
}
const workspace = await mkdtemp(join(tmpdir(), "fp-pcb-bundle-smoke-"));
const libraryPaths = (manifest.libraryPaths ?? []).map((path) => resolve(root, path));
const env = {
  ...process.env,
  ...(manifest.environment ?? {}),
  ...(libraryPaths.length ? { LD_LIBRARY_PATH: [...libraryPaths, process.env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter) } : {}),
  PORT: "4020",
  HOST: "127.0.0.1",
  KICAD_CLI: paths.cli,
  KICAD_STOCK_DATA_HOME: paths.stockData,
  KICAD_FOOTPRINT_DIR: paths.footprints,
  KICAD_SYMBOL_DIR: paths.symbols,
  WORKSPACE_ROOT: workspace,
  ...(manifest.jsAutorouter ? { JS_AUTOROUTER_MODULE: resolve(root, manifest.jsAutorouter) } : {}),
};
const version = Bun.spawnSync([paths.cli, "version"], { env, stdout: "pipe", stderr: "pipe" });
if (version.exitCode !== 0) throw new Error(`kicad-cli version failed: ${version.stderr.toString().trim()}`);

const bridge = Bun.spawn([paths.bridge], { env, stdout: "inherit", stderr: "inherit" });
try {
  let health: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (bridge.exitCode !== null) throw new Error(`bridge exited with code ${bridge.exitCode}`);
    try {
      const response = await fetch("http://127.0.0.1:4020/health");
      if (response.ok) {
        health = (await response.json()) as Record<string, unknown>;
        break;
      }
    } catch {}
    await Bun.sleep(200);
  }
  if (!health) throw new Error("bridge did not become healthy within 60 seconds");
  if (health.ok !== true || health.kicadCliExists !== true) throw new Error(`unhealthy bridge: ${JSON.stringify(health)}`);
  if (resolve(String(health.workspaceRoot)) !== resolve(workspace)) {
    throw new Error(`bridge workspace ${String(health.workspaceRoot)} != ${workspace}`);
  }
  console.log(`Native ${expectedTarget} bundle smoke passed: ${version.stdout.toString().trim()}`);
} finally {
  bridge.kill();
  await Promise.race([bridge.exited, Bun.sleep(3_000)]);
  if (bridge.exitCode === null) bridge.kill(9);
}
