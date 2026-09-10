#!/usr/bin/env bun
/**
 * Puts the Emscripten build of KiCad's API core into `dist/`, where `createKiCadWasm()` looks for it
 * by default. Two modes:
 *
 *   local   copy from a build tree (`$KICAD_WASM_DIR`, else `$KICAD_SRC/build/wasm/host`, else
 *           `../../../kicad/build/wasm/host` next to the repo). The default when that exists.
 *
 *             bun run --filter @fp-pcb/kicad-wasm fetch
 *             KICAD_WASM_DIR=/path/to/build/wasm/host bun run fetch
 *
 *   release  download the tarball the KiCad fork's `wasm-release` workflow attaches to an
 *            alignment tag, verify its SHA256SUMS, and unpack it. No toolchain needed.
 *
 *             bun run --filter @fp-pcb/kicad-wasm fetch:release
 *             KICAD_WASM_RELEASE=fp-pcb/2026-09-09-wasm bun run fetch
 *             KICAD_WASM_RELEASE_FILE=/path/to/kicad-wasm-*.tar.gz bun run fetch
 *
 * The release tag defaults to `packages/proto/KICAD_TAG`, i.e. the fork tag the generated bindings
 * came from. The asset is `kicad-wasm-<tag with / replaced by ->.tar.gz` (release asset names cannot
 * contain a slash); `kicad/tools/wasm/package.sh` builds it and this reads it back.
 *
 * `TensorFleet/kicad` is public, so the download needs no credentials. `GITHUB_TOKEN` or `GH_TOKEN`
 * is used against the releases API when set (it lifts the rate limit, which matters on CI runners
 * that share an IP, and is what a private fork would need); an authenticated `gh` is the fallback
 * if the unauthenticated request cannot reach the API at all.
 *
 * `kicad_api.js` and `kicad_api.wasm` are required; `kicad_api.data` (an Emscripten
 * `--preload-file` bundle, e.g. KiCad's share tree) and `kicad_api.worker.js` are taken when
 * present, along with the `kicad-wasm.json` manifest recording which fork commit and toolchain
 * produced the module.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG, "../..");
const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(PKG, "../../../kicad");
const SRC = resolve(process.env.KICAD_WASM_DIR ?? join(KICAD_ROOT, "build/wasm/host"));
const DIST = join(PKG, "dist");

const REQUIRED = ["kicad_api.js", "kicad_api.wasm"];
const OPTIONAL = ["kicad_api.data", "kicad_api.worker.js", "kicad_api.js.map", "kicad_api.wasm.map"];
const MANIFEST = "kicad-wasm.json";

/** TensorFleet/kicad; override for a different fork remote. */
const RELEASE_REPO = process.env.KICAD_WASM_REPO ?? "TensorFleet/kicad";
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

const argv = process.argv.slice(2);
const argRelease = argv.find((a) => a === "--release" || a.startsWith("--release="));
const argFile = argv.find((a) => a.startsWith("--file="))?.slice("--file=".length);

const releaseFile = argFile ?? process.env.KICAD_WASM_RELEASE_FILE;
const releaseTagArg = argRelease?.startsWith("--release=") ? argRelease.slice("--release=".length) : undefined;
const releaseTagEnv = process.env.KICAD_WASM_RELEASE;

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
const assetName = (tag: string) => `kicad-wasm-${tag.replaceAll("/", "-")}.tar.gz`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function defaultTag(): Promise<string> {
  const file = join(REPO_ROOT, "packages/proto/KICAD_TAG");
  if (!existsSync(file)) fail("no tag given and packages/proto/KICAD_TAG does not exist (use --release=<tag>)");
  const tag = (await readFile(file, "utf8")).trim();
  if (!tag) fail("packages/proto/KICAD_TAG is empty (use --release=<tag>)");
  return tag;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return hash.digest("hex");
}

function run(cmd: string[], cwd?: string) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

// --------------------------------------------------------------------------------- download
type Asset = { name: string; url: string; size: number };

/**
 * Thrown instead of exiting when the API refused in a way an authenticated `gh` might not: no
 * credentials plus 401/403/404 is exactly what a private repository looks like from the outside.
 * `fromRelease()` catches this one and retries through `gh`; every other failure still exits.
 */
class MaybeNeedsAuth extends Error {}

async function downloadFromApi(tag: string, token: string | undefined, into: string): Promise<string> {
  const auth: Record<string, string> = {
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fp-pcb-kicad-wasm-fetch",
  };
  // TensorFleet/kicad is public, so a token is optional here; when one is set it lifts the API rate
  // limit (which matters on CI runners that share an IP) and is what a private fork would need.
  if (token) auth.Authorization = `Bearer ${token}`;
  // Unauthenticated, these are indistinguishable from "the repository is private", so they are worth
  // a second attempt through `gh` rather than an immediate exit.
  const deniable = (status: number) => !token && (status === 401 || status === 403 || status === 404);

  // Tag names contain a slash (fp-pcb/<date>-<name>); the API takes the rest of the path as the tag.
  const relUrl = `${API}/repos/${RELEASE_REPO}/releases/tags/${tag}`;
  const rel = await fetch(relUrl, { headers: { ...auth, Accept: "application/vnd.github+json" } });
  if (deniable(rel.status)) throw new MaybeNeedsAuth(`GET ${relUrl} -> ${rel.status} ${rel.statusText}`);
  if (rel.status === 404) {
    fail(`no release ${tag} in ${RELEASE_REPO} (or this token cannot see it).
Cut one by pushing the tag: the fork's .github/workflows/wasm-release.yml builds and attaches the asset.`);
  }
  if (!rel.ok) fail(`GET ${relUrl} -> ${rel.status} ${rel.statusText}`);

  const release = (await rel.json()) as { assets?: Asset[] };
  const want = assetName(tag);
  const asset = release.assets?.find((a) => a.name === want);
  if (!asset) {
    const names = (release.assets ?? []).map((a) => a.name).join(", ") || "(none)";
    fail(`release ${tag} has no asset ${want}. It has: ${names}`);
  }

  console.log(`  downloading ${want} (${mib(asset.size)}) from ${RELEASE_REPO}`);
  // The asset API URL plus this Accept serves the bytes for a public and a private release alike;
  // for a private one the browser_download_url would need a session cookie.
  const bin = await fetch(asset.url, { headers: { ...auth, Accept: "application/octet-stream" } });
  if (deniable(bin.status)) throw new MaybeNeedsAuth(`GET ${asset.url} -> ${bin.status} ${bin.statusText}`);
  if (!bin.ok) fail(`GET ${asset.url} -> ${bin.status} ${bin.statusText}`);

  const path = join(into, want);
  await writeFile(path, Buffer.from(await bin.arrayBuffer()));
  return path;
}

function downloadWithGh(tag: string, into: string): string {
  const want = assetName(tag);
  console.log(`  gh release download ${tag} --repo ${RELEASE_REPO} --pattern ${want}`);
  const p = run(["gh", "release", "download", tag, "--repo", RELEASE_REPO, "--pattern", want, "--dir", into]);
  if (!p.ok) fail(`gh release download failed:\n${p.err.trim()}`);
  const path = join(into, want);
  if (!existsSync(path)) fail(`gh did not produce ${path}`);
  return path;
}

/** Unpack a tarball into `into` and check every file against its SHA256SUMS entry. */
async function unpackVerified(tarball: string, into: string) {
  const t = run(["tar", "-xzf", tarball, "-C", into]);
  if (!t.ok) fail(`tar -xzf ${tarball} failed:\n${t.err.trim()}`);

  const sums = join(into, "SHA256SUMS");
  if (!existsSync(sums)) fail(`${tarball} has no SHA256SUMS`);

  const lines = (await readFile(sums, "utf8")).split("\n").filter((l) => l.trim());
  if (lines.length === 0) fail("SHA256SUMS is empty");

  for (const line of lines) {
    const want = line.slice(0, 64);
    const name = line.slice(64).trim();
    const path = join(into, name);
    if (!existsSync(path)) fail(`SHA256SUMS lists ${name}, which is not in the tarball`);
    const got = await sha256(path);
    if (got !== want) fail(`checksum mismatch for ${name}\n  expected ${want}\n  got      ${got}`);
  }
  console.log(`  verified ${lines.length} files against SHA256SUMS`);

  const missing = REQUIRED.filter((f) => !existsSync(join(into, f)));
  if (missing.length > 0) fail(`${tarball} is missing ${missing.join(", ")}`);
}

async function install(from: string, names: string[]) {
  await mkdir(DIST, { recursive: true });
  let total = 0;
  for (const name of names) {
    const path = join(from, name);
    if (!existsSync(path)) continue;
    await copyFile(path, join(DIST, name));
    const { size } = await stat(path);
    total += size;
    console.log(`  ${name.padEnd(22)} ${mib(size)}`);
  }
  return total;
}

// --------------------------------------------------------------------------------- modes
async function fromRelease() {
  const staging = join(tmpdir(), `kicad-wasm-fetch-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    let tarball: string;
    let tag = releaseTagArg ?? releaseTagEnv ?? "";

    if (releaseFile) {
      tarball = resolve(releaseFile);
      if (!existsSync(tarball)) fail(`${tarball} does not exist`);
      console.log(`release: ${tarball} (local file)`);
    } else {
      if (!tag) tag = await defaultTag();
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      console.log(`release: ${tag} from ${RELEASE_REPO}${token ? "" : " (unauthenticated)"}`);
      // The plain API path works with or without a token; `gh` is the fallback for someone who has
      // it authenticated but no token in the environment (and the way a private fork would be read).
      try {
        tarball = await downloadFromApi(tag, token, staging);
      } catch (err) {
        if (!(err instanceof MaybeNeedsAuth)) throw err;
        if (!run(["gh", "--version"]).ok) {
          fail(`${err.message}
${RELEASE_REPO} is public, so this should have worked; if it has been made private again, set GITHUB_TOKEN
(or GH_TOKEN) to a token that can read it, or install and authenticate the gh CLI.
A local tarball works too: KICAD_WASM_RELEASE_FILE=/path/to/${assetName(tag)}`);
        }
        console.log(`  unauthenticated download failed (${err.message}); trying gh`);
        tarball = downloadWithGh(tag, staging);
      }
    }

    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked, { recursive: true });
    await unpackVerified(tarball, unpacked);

    const total = await install(unpacked, [...REQUIRED, ...OPTIONAL, MANIFEST]);
    const manifest = join(unpacked, MANIFEST);
    if (existsSync(manifest)) {
      const m = JSON.parse(await readFile(manifest, "utf8")) as {
        tag?: string;
        commit?: string;
        toolchain?: { emscripten?: string };
      };
      console.log(`  built from ${m.tag} (${m.commit?.slice(0, 12)}), emscripten ${m.toolchain?.emscripten}`);
    }
    console.log(`unpacked ${mib(total)} into ${DIST}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function fromBuildDir() {
  const missing = REQUIRED.filter((f) => !existsSync(join(SRC, f)));
  if (missing.length > 0) fail(`${SRC} is missing ${missing.join(", ")}`);
  console.log(`local: ${SRC}`);
  const total = await install(SRC, [...REQUIRED, ...OPTIONAL, MANIFEST]);
  console.log(`copied ${mib(total)} from ${SRC} to ${DIST}`);
}

// --------------------------------------------------------------------------------- main
// An explicit release request wins; otherwise a local build tree is preferred over the network.
if (releaseFile || releaseTagArg !== undefined || releaseTagEnv || argRelease) {
  await fromRelease();
} else if (existsSync(SRC)) {
  await fromBuildDir();
} else {
  fail(`${SRC} does not exist.
Either build the wasm host (see docs/08-wasm.md) and point KICAD_WASM_DIR at the output, or take a
released build:  bun run --filter @fp-pcb/kicad-wasm fetch:release`);
}
