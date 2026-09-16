#!/usr/bin/env bun
/**
 * Drift check: regenerates the protobuf-es output into a scratch directory and fails if it
 * differs from the committed src/gen, or if KICAD_COMMIT does not match the checkout's HEAD.
 *
 *   bun run check            (exit 1 on drift; run `bun run gen` to update)
 */
import { join, relative } from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generate, writeIndex, kicadSrc, kicadCommit, GEN_DIR, PKG_DIR } from "./gen.js";

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)));
  }
  return out.sort();
}

const src = kicadSrc();
const tmp = await mkdtemp(join(tmpdir(), "fp-pcb-proto-"));
let problems = 0;
try {
  await generate(tmp, src);
  await writeIndex(tmp);
  const fresh = join(tmp, "src", "gen");
  const [a, b] = await Promise.all([listFiles(GEN_DIR), listFiles(fresh)]);
  for (const f of b)
    if (!a.includes(f)) {
      console.error(`missing in src/gen: ${f}`);
      problems++;
    }
  for (const f of a)
    if (!b.includes(f)) {
      console.error(`stale in src/gen (not generated any more): ${f}`);
      problems++;
    }
  for (const f of a) {
    if (!b.includes(f)) continue;
    const [x, y] = await Promise.all([readFile(join(GEN_DIR, f), "utf8"), readFile(join(fresh, f), "utf8")]);
    if (x !== y) {
      console.error(`differs: src/gen/${f}`);
      problems++;
    }
  }
  const pinned = (await readFile(join(PKG_DIR, "KICAD_COMMIT"), "utf8").catch(() => "")).trim();
  const head = kicadCommit(src);
  if (pinned !== head) {
    console.error(`KICAD_COMMIT is ${pinned || "(missing)"} but ${src} is at ${head}`);
    problems++;
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
if (problems) {
  console.error(`\n${problems} drift problem(s); run \`bun run gen\` in packages/proto`);
  process.exit(1);
}
console.log("src/gen and KICAD_COMMIT are up to date");
