#!/usr/bin/env bun
/**
 * Download a nightly build of the fork's headless `kicad-cli` from its GitHub Releases
 * (TensorFleet/kicad, produced by .github/workflows/nightly.yml there; layout and manifest in
 * tools/nightly/README.md of the fork) and print the path of the executable.  No dependencies,
 * so it doubles as the reference for any other consumer (fabdesk) that pulls the same builds.
 *
 *   KICAD_CLI="$(bun tooling/kicad-cli/fetch.ts)" bun run test:integration
 *   bun tooling/kicad-cli/fetch.ts --tag nightly-20260910-0c45443da6     # pin a build
 *   bun tooling/kicad-cli/fetch.ts --platform windows-x86_64 --dir /tmp/kc
 *
 * Options
 *   --tag <tag>        release tag: `nightly` (default, rolling) or a dated nightly-<date>-<sha10>
 *   --platform <p>     linux-x86_64 | macos-arm64 | macos-x86_64 | windows-x86_64 (default: this machine)
 *   --dir <dir>        where builds are unpacked (default: <repo>/.kicad-cli); each build gets its
 *                      own <dir>/<build tag>/<platform>/ and is reused when already complete
 *   --repo <owner/name>  default TensorFleet/kicad
 *   --check            only print what the release carries; download nothing
 *
 * The repository is private: GITHUB_TOKEN or GH_TOKEN (contents:read) is required.  The path
 * goes to stdout, everything else to stderr, so the output can be captured directly.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ManifestAsset {
  file: string;
  url: string;
  sha256: string;
  size: number;
  entrypoint: string;
  commit: string;
  version: string;
  tag: string;
  date: string;
}

export interface Manifest {
  schema: number;
  repo: string;
  release: string;
  tag: string;
  commit: string;
  version: string;
  date: string;
  assets: Record<string, ManifestAsset>;
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export const PLATFORMS = ["linux-x86_64", "macos-arm64", "macos-x86_64", "windows-x86_64"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The nightly platform name for a Node/Bun `process.platform` + `process.arch` pair. */
export function platformName(platform: string = process.platform, arch: string = process.arch): Platform {
  const os = { linux: "linux", darwin: "macos", win32: "windows" }[platform];
  const cpu = { x64: "x86_64", arm64: "arm64" }[arch];
  const name = os && cpu ? `${os}-${cpu}` : undefined;
  if (!name || !(PLATFORMS as readonly string[]).includes(name)) {
    throw new Error(`no nightly kicad-cli build for ${platform}/${arch} (have: ${PLATFORMS.join(", ")})`);
  }
  return name as Platform;
}

/** The manifest entry for a platform, or a clear error naming what the release does carry. */
export function pickAsset(manifest: Manifest, platform: Platform): ManifestAsset {
  if (manifest.schema !== 1) throw new Error(`unsupported manifest schema ${manifest.schema} (this tool knows 1)`);
  const asset = manifest.assets[platform];
  if (!asset) {
    const have = Object.keys(manifest.assets).join(", ") || "none";
    throw new Error(`release ${manifest.release} has no ${platform} build (platforms: ${have})`);
  }
  return asset;
}

/** Directory a build is unpacked into: one per build tag and platform, so pins never collide. */
export function installDir(base: string, asset: ManifestAsset, platform: Platform): string {
  return join(base, asset.tag, platform);
}

function parseArgs(argv: string[]) {
  const opts = {
    tag: "nightly",
    platform: undefined as string | undefined,
    dir: undefined as string | undefined,
    repo: "TensorFleet/kicad",
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--tag") opts.tag = next();
    else if (a === "--platform") opts.platform = next();
    else if (a === "--dir") opts.dir = next();
    else if (a === "--repo") opts.repo = next();
    else if (a === "--check") opts.check = true;
    else if (a === "-h" || a === "--help") {
      console.error(HELP);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const HELP = `usage: bun tooling/kicad-cli/fetch.ts [--tag nightly|nightly-<date>-<sha10>] [--platform <p>] [--dir <dir>] [--repo owner/name] [--check]
prints the path of the kicad-cli executable; needs GITHUB_TOKEN or GH_TOKEN`;

const log = (msg: string) => console.error(`kicad-cli fetch: ${msg}`);

function token(): string {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!t) throw new Error("GITHUB_TOKEN or GH_TOKEN is required (the kicad fork is a private repository)");
  return t;
}

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Download a release asset.  GitHub answers the asset URL with a redirect to object storage that
 * must be followed WITHOUT the Authorization header (the storage rejects a request carrying both
 * its signed query and a bearer token), so the redirect is handled by hand.
 */
async function downloadAsset(asset: ReleaseAsset, dest: string): Promise<string> {
  const first = await fetch(asset.url, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/octet-stream" },
    redirect: "manual",
  });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error(`${asset.url}: redirect without Location`);
    res = await fetch(location, { headers: { Accept: "application/octet-stream" } });
  }
  if (!res.ok || !res.body) throw new Error(`${asset.name}: HTTP ${res.status}`);

  const hash = createHash("sha256");
  const writer = Bun.file(dest).writer();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    writer.write(value);
  }
  await writer.end();
  return hash.digest("hex");
}

async function unpack(archive: string, into: string): Promise<void> {
  // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz; bsdtar also reads .zip, and every
  // Windows since 10 1803 ships it as tar.exe.
  const proc = Bun.spawn(["tar", "-xf", archive, "-C", into], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`tar failed unpacking ${archive}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const platform = (opts.platform as Platform | undefined) ?? platformName();
  if (!(PLATFORMS as readonly string[]).includes(platform)) throw new Error(`unknown platform ${platform} (have: ${PLATFORMS.join(", ")})`);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const base = resolve(opts.dir ?? join(repoRoot, ".kicad-cli"));

  const release = await api<Release>(`https://api.github.com/repos/${opts.repo}/releases/tags/${opts.tag}`);
  const manifestAsset = release.assets.find((a) => a.name === "manifest.json");
  if (!manifestAsset) throw new Error(`release ${opts.tag} of ${opts.repo} has no manifest.json (not a nightly release?)`);

  await mkdir(base, { recursive: true });
  const manifestPath = join(base, `manifest-${opts.tag}.json`);
  await downloadAsset(manifestAsset, manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const asset = pickAsset(manifest, platform);
  log(`${opts.repo}@${opts.tag}: ${platform} is ${asset.tag} (${asset.version}, commit ${asset.commit.slice(0, 10)})`);

  if (opts.check) {
    for (const [p, a] of Object.entries(manifest.assets)) log(`  ${p.padEnd(15)} ${a.tag}  ${a.version}  ${(a.size / 1e6).toFixed(0)} MB`);
    return;
  }

  const dir = installDir(base, asset, platform);
  const entrypoint = join(dir, ...asset.entrypoint.split("/"));
  const marker = join(dir, ".complete");
  if (existsSync(marker) && (await readFile(marker, "utf8")).trim() === asset.sha256 && existsSync(entrypoint)) {
    log(`already unpacked in ${dir}`);
    console.log(entrypoint);
    return;
  }

  const archiveAsset = release.assets.find((a) => a.name === asset.file);
  if (!archiveAsset) throw new Error(`release ${opts.tag} lists ${asset.file} in manifest.json but has no such asset`);

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const archive = join(base, asset.file);
  log(`downloading ${asset.file} (${(asset.size / 1e6).toFixed(0)} MB)`);
  const sha256 = await downloadAsset(archiveAsset, archive);
  if (sha256 !== asset.sha256) {
    await rm(archive, { force: true });
    throw new Error(`${asset.file}: sha256 ${sha256} does not match the manifest's ${asset.sha256}`);
  }
  log(`unpacking into ${dir}`);
  const staging = `${dir}.unpacking`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await unpack(archive, staging);
  await rm(archive, { force: true });
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  if (!existsSync(entrypoint)) throw new Error(`${asset.file} did not contain ${asset.entrypoint}`);
  await writeFile(marker, `${asset.sha256}\n`);
  console.log(entrypoint);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
