#!/usr/bin/env bun
/**
 * Downloads the Freerouting release jar into packages/router/vendor (git-ignored) and, with
 * `--jdk`, a Temurin JDK 25 next to it (Freerouting >= 2.2 is compiled for Java 25; macOS/Linux
 * system JDKs are usually older).
 *
 *   bun run bench/fetch-freerouting.ts            # jar only
 *   bun run bench/fetch-freerouting.ts --jdk      # jar + vendor/jdk
 *   FREEROUTING_VERSION=2.4.1 bun run bench/fetch-freerouting.ts
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FREEROUTING_VERSION, VENDOR_DIR } from "../src/freerouting";

const version = process.env.FREEROUTING_VERSION ?? FREEROUTING_VERSION;
const jar = join(VENDOR_DIR, `freerouting-${version}.jar`);
await mkdir(VENDOR_DIR, { recursive: true });

if (existsSync(jar)) console.log(`have ${jar}`);
else {
  const url = `https://github.com/freerouting/freerouting/releases/download/v${version}/freerouting-${version}.jar`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await Bun.write(jar, await res.arrayBuffer());
  console.log(`wrote ${jar} (${(Bun.file(jar).size / 1e6).toFixed(1)} MB)`);
}

if (process.argv.includes("--jdk")) {
  const jdk = join(VENDOR_DIR, "jdk");
  const java = process.platform === "darwin" ? join(jdk, "Contents", "Home", "bin", "java") : join(jdk, "bin", "java");
  if (existsSync(java)) console.log(`have ${java}`);
  else {
    const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";
    const arch = process.arch === "arm64" ? "aarch64" : "x64";
    const url = `https://api.adoptium.net/v3/binary/latest/25/ga/${os}/${arch}/jdk/hotspot/normal/eclipse?project=jdk`;
    console.log(`downloading Temurin 25 from ${url}`);
    const tgz = join(VENDOR_DIR, "jdk25.tar.gz");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await Bun.write(tgz, await res.arrayBuffer());
    await rm(jdk, { recursive: true, force: true });
    await mkdir(jdk, { recursive: true });
    const tar = Bun.spawn(["tar", "-xzf", tgz, "-C", jdk, "--strip-components=1"], { stdio: ["ignore", "inherit", "inherit"] });
    if ((await tar.exited) !== 0) throw new Error("tar failed");
    await rm(tgz, { force: true });
    console.log(`wrote ${java}`);
  }
}
