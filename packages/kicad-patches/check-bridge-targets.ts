#!/usr/bin/env bun
/** Package every desktop bridge target and execute the embedded worker on the current platform. */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { targetSpec } from "./bundle-lib";
import { bridgeCompileCommand } from "./compile-bridge";

const targets = ["linux-x64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
const output = await mkdtemp(join(tmpdir(), "fp-pcb-bridge-targets-"));
try {
  for (const target of targets) {
    const spec = targetSpec(target);
    const outfile = join(output, `${target}${target.startsWith("windows") ? ".exe" : ""}`);
    const proc = Bun.spawn(bridgeCompileCommand(resolve(import.meta.dir, "../bridge/src/main.ts"), outfile, spec.bunTarget), {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await proc.exited) throw new Error(`bridge compilation failed for ${target} (${spec.bunTarget})`);
    const size = (await stat(outfile)).size;
    if (size === 0) throw new Error(`bridge compilation produced an empty executable for ${target}`);
    console.log(`${target}: ${(size / 1024 / 1024).toFixed(1)} MiB`);
  }
  const smoke = join(output, `router-worker-smoke${process.platform === "win32" ? ".exe" : ""}`);
  const fixtures = resolve(import.meta.dir, "../router/test/fixtures");
  const build = Bun.spawn(bridgeCompileCommand(join(fixtures, "compiled-solver-client.ts"), smoke), {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await build.exited) throw new Error("compiled solver worker smoke build failed");
  // Run outside the checkout so an omitted worker cannot be rescued by a source file on disk.
  const run = Bun.spawn([smoke, pathToFileURL(join(fixtures, "blocking-solver.ts")).href], {
    cwd: output,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await run.exited) throw new Error("compiled solver worker smoke test failed");
} finally {
  await rm(output, { recursive: true, force: true });
}
