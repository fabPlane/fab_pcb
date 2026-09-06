#!/usr/bin/env bun
/**
 * Regenerates src/gen from the KiCad proto sources with buf + protoc-gen-es, and records the
 * KiCad commit the protos came from in KICAD_COMMIT.
 *
 *   bun run gen                       # uses ../../../kicad (the sibling checkout)
 *   KICAD_SRC=/path/to/kicad bun run gen
 *   KICAD_WORKTREE=1 bun run gen      # generate from the working tree instead of git HEAD
 *
 * By default the protos are exported from the checkout's git HEAD (`git archive`), so the output is
 * exactly what KICAD_COMMIT says even when the working tree carries uncommitted API patches.
 *
 * Exported as a function so check.ts can generate into a scratch directory for drift detection.
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export const PKG_DIR = dirname(fileURLToPath(import.meta.url));
export const GEN_DIR = join(PKG_DIR, "src", "gen");

export function kicadSrc(): string {
  const dir = resolve(process.env.KICAD_SRC ?? join(PKG_DIR, "..", "..", "..", "kicad"));
  if (!existsSync(join(dir, "api", "proto", "common", "envelope.proto"))) {
    throw new Error(`KiCad checkout not found at ${dir} (set KICAD_SRC); expected api/proto/common/envelope.proto`);
  }
  return dir;
}

export function kicadCommit(src: string): string {
  const r = Bun.spawnSync(["git", "-C", src, "rev-parse", "HEAD"]);
  if (r.exitCode !== 0) throw new Error(`git rev-parse failed in ${src}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export function useWorktree(): boolean {
  return process.env.KICAD_WORKTREE === "1";
}

/** True if api/proto in the checkout has uncommitted changes. */
export function protosDirty(src: string): boolean {
  const r = Bun.spawnSync(["git", "-C", src, "status", "--porcelain", "--", "api/proto"]);
  return r.exitCode === 0 && r.stdout.toString().trim().length > 0;
}

/**
 * Returns the directory holding `api/proto` to generate from: the working tree when KICAD_WORKTREE=1,
 * otherwise a scratch export of git HEAD (call `cleanup` when done).
 */
export async function protoSource(src: string): Promise<{ protoDir: string; cleanup: () => Promise<void> }> {
  if (useWorktree()) return { protoDir: join(src, "api", "proto"), cleanup: async () => {} };
  const tmp = await mkdtemp(join(tmpdir(), "kicad-proto-head-"));
  const tar = join(tmp, "proto.tar");
  const a = Bun.spawnSync(["git", "-C", src, "archive", "--format=tar", "-o", tar, "HEAD", "api/proto"]);
  if (a.exitCode !== 0) throw new Error(`git archive failed: ${a.stderr.toString()}`);
  const x = Bun.spawnSync(["tar", "-xf", tar, "-C", tmp]);
  if (x.exitCode !== 0) throw new Error(`tar failed: ${x.stderr.toString()}`);
  return { protoDir: join(tmp, "api", "proto"), cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

/** Runs `buf generate` for the KiCad protos; `outDir` is the base directory for plugin outputs. */
export async function generate(outDir: string, src = kicadSrc()): Promise<void> {
  const { protoDir, cleanup } = await protoSource(src);
  try {
    await runBuf(protoDir, outDir);
  } finally {
    await cleanup();
  }
}

async function runBuf(protoDir: string, outDir: string): Promise<void> {
  const binDir = join(PKG_DIR, "node_modules", ".bin");
  const rootBin = join(PKG_DIR, "..", "..", "node_modules", ".bin");
  const env = { ...process.env, PATH: `${binDir}:${rootBin}:${process.env.PATH ?? ""}` };
  const buf = [binDir, rootBin].map((d) => join(d, "buf")).find((p) => existsSync(p)) ?? "buf";
  const args = [buf, "generate", protoDir, "--template", join(PKG_DIR, "buf.gen.yaml"), "--output", outDir];
  const proc = Bun.spawn(args, { cwd: PKG_DIR, env, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`buf generate failed with exit code ${code}`);
}

/** Converts "board/board_types_pb.ts" to its `file_board_board_types` descriptor export name. */
function fileConst(rel: string): string {
  return "file_" + rel.replace(/_pb\.ts$/, "").replace(/[/.-]/g, "_");
}

/** Short unique namespace identifier for a generated module: "board/board_types_pb.ts" -> "board_types". */
function nsIdent(rel: string): string {
  return rel.replace(/_pb\.ts$/, "").split("/").pop()!;
}

/**
 * Writes `<outDir>/src/gen/index.ts`: a flat re-export of every generated module plus one namespace per
 * module and the `kiapiFiles` descriptor list. Message/enum names that collide across packages
 * (e.g. kiapi.board.types.Group vs kiapi.schematic.types.Group) are re-exported with a package prefix
 * (BoardGroup, SchematicGroup) so the flat namespace stays unambiguous; the per-module namespaces
 * (`board_types.Group`) always carry the original names.
 */
export async function writeIndex(outDir: string): Promise<void> {
  const genDir = join(outDir, "src", "gen");
  const files = (await readdir(genDir, { recursive: true }))
    .map(String)
    .filter((f) => f.endsWith("_pb.ts"))
    .sort();
  if (files.length === 0) throw new Error(`no generated files in ${genDir}`);

  type Exp = { name: string; kind: "value" | "type" };
  const perFile = new Map<string, { pkg: string; exports: Exp[] }>();
  const owners = new Map<string, string[]>();
  for (const f of files) {
    const text = await readFile(join(genDir, f), "utf8");
    const pkg = /@generated from file \S+ \(package ([\w.]+)/.exec(text)?.[1] ?? "";
    const exports: Exp[] = [];
    for (const m of text.matchAll(/^export (const|type|enum|function|declare const) (\w+)/gm)) {
      const name = m[2]!;
      exports.push({ name, kind: m[1] === "type" ? "type" : "value" });
      (owners.get(name) ?? owners.set(name, []).get(name)!).push(f);
    }
    perFile.set(f, { pkg, exports });
  }
  const collisions = new Set([...owners].filter(([, o]) => o.length > 1).map(([n]) => n));
  // e.g. kiapi.board.types -> "Board", kiapi.schematic.types -> "Schematic", kiapi.common.commands -> "CommonCommands"
  const prefixFor = (pkg: string) =>
    pkg.replace(/^kiapi\./, "").split(".").filter((s) => s !== "types")
      .map((s) => s[0]!.toUpperCase() + s.slice(1)).join("");

  const lines: string[] = [
    "// @generated by packages/proto/gen.ts -- do not edit; run `bun run gen`.",
    "// Flat re-exports of every generated module, one namespace per module, and the descriptor list.",
    "",
  ];
  for (const f of files) {
    const { pkg, exports } = perFile.get(f)!;
    const mod = "./" + f.replace(/\.ts$/, ".js");
    const clash = exports.filter((e) => collisions.has(e.name));
    if (clash.length === 0) {
      lines.push(`export * from "${mod}";`);
      continue;
    }
    const prefix = prefixFor(pkg);
    const spec = (e: Exp) => (collisions.has(e.name) ? `${e.name} as ${prefix}${e.name}` : e.name);
    const values = exports.filter((e) => e.kind === "value").map(spec);
    const types = exports.filter((e) => e.kind === "type").map(spec);
    lines.push(`// ${pkg}: ${clash.map((e) => e.name).join(", ")} collide with another package and are prefixed "${prefix}"`);
    if (values.length) lines.push(`export { ${values.join(", ")} } from "${mod}";`);
    if (types.length) lines.push(`export type { ${types.join(", ")} } from "${mod}";`);
  }
  lines.push("");
  for (const f of files) lines.push(`export * as ${nsIdent(f)} from "./${f.replace(/\.ts$/, ".js")}";`);
  lines.push("");
  lines.push(`import type { GenFile } from "@bufbuild/protobuf/codegenv2";`);
  for (const f of files) lines.push(`import { ${fileConst(f)} } from "./${f.replace(/\.ts$/, ".js")}";`);
  lines.push("");
  lines.push("/** Every generated kiapi file descriptor, in path order. */");
  lines.push("export const kiapiFiles: readonly GenFile[] = [");
  for (const f of files) lines.push(`  ${fileConst(f)},`);
  lines.push("];");
  lines.push("");
  await writeFile(join(genDir, "index.ts"), lines.join("\n"));
}

if (import.meta.main) {
  const src = kicadSrc();
  const commit = kicadCommit(src);
  const mode = useWorktree() ? "working tree" : "git HEAD";
  console.log(`generating from ${src}/api/proto @ ${mode} (KiCad ${commit.slice(0, 10)}) -> ${GEN_DIR}`);
  if (protosDirty(src)) {
    console.warn(
      useWorktree()
        ? "warning: api/proto has uncommitted changes; output will not match KICAD_COMMIT"
        : "note: api/proto has uncommitted changes in the working tree; they are ignored (set KICAD_WORKTREE=1 to include them)",
    );
  }
  await generate(PKG_DIR, src);
  await writeIndex(PKG_DIR);
  await writeFile(join(PKG_DIR, "KICAD_COMMIT"), commit + "\n");
  console.log("wrote src/gen/index.ts and KICAD_COMMIT");
}
