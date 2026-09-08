#!/usr/bin/env bun
/** Static packaging gate: make sure the complete bridge dependency graph compiles for every desktop target. */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { targetSpec } from "./bundle-lib";

const targets = ["linux-x64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
const output = await mkdtemp(join(tmpdir(), "fp-pcb-bridge-targets-"));
try {
  for (const target of targets) {
    const spec = targetSpec(target);
    const outfile = join(output, `${target}${target.startsWith("windows") ? ".exe" : ""}`);
    const proc = Bun.spawn(
      [
        "bun",
        "build",
        resolve(import.meta.dir, "../bridge/src/main.ts"),
        "--compile",
        `--target=${spec.bunTarget}`,
        `--outfile=${outfile}`,
      ],
      { cwd: resolve(import.meta.dir, "../.."), stdout: "inherit", stderr: "inherit" },
    );
    if (await proc.exited) throw new Error(`bridge compilation failed for ${target} (${spec.bunTarget})`);
    const size = (await stat(outfile)).size;
    if (size === 0) throw new Error(`bridge compilation produced an empty executable for ${target}`);
    console.log(`${target}: ${(size / 1024 / 1024).toFixed(1)} MiB`);
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
