/** Pinned, checksummed downloads shared by the benchmark fetcher and native bundle assembly. */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FREEROUTING_VERSION } from "./freerouting";

export const JDK_VERSION = "25.0.4.1+1";
export const JAR_SHA256 = "251101c3eeac22d7e7dfcf6796603279e5d1000283eb82d8f093780f7afc6aa9";
const targets: Record<string, { asset: string; sha256: string }> = {
  "linux-x64": {
    asset: "OpenJDK25U-jdk_x64_linux_hotspot_25.0.4.1_1.tar.gz",
    sha256: "dbb698396d478e7fa2b1e50f4103324b2a99b90569ee27c33f2261f9215cf41e",
  },
  "darwin-x64": {
    asset: "OpenJDK25U-jdk_x64_mac_hotspot_25.0.4.1_1.tar.gz",
    sha256: "e6229d9504f7922053ab31821b9e6bee8761daf7b026a3476d1a027563009880",
  },
  "darwin-arm64": {
    asset: "OpenJDK25U-jdk_aarch64_mac_hotspot_25.0.4.1_1.tar.gz",
    sha256: "61979887f7506a24a57439ff99adb8b3a7fc89977d9cfe3b8984f58a981b7b9d",
  },
  "windows-x64": {
    asset: "OpenJDK25U-jdk_x64_windows_hotspot_25.0.4.1_1.zip",
    sha256: "00c847d804f4a78e9f04f2683faf14fed898535b177b7fc704486cb0284e9283",
  },
};
export function freeroutingDownloadSpec(target: string) {
  const spec = targets[target];
  if (!spec) throw new Error(`unsupported Freerouting target ${target}`);
  if (!/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error(`invalid checksum for ${target}`);
  return spec;
}

export async function checkedDownload(url: string, path: string, expected: string): Promise<void> {
  const cached = Bun.file(path);
  if (await cached.exists()) {
    if (
      createHash("sha256")
        .update(new Uint8Array(await cached.arrayBuffer()))
        .digest("hex") === expected
    )
      return;
    throw new Error(`checksum mismatch for cached ${path}`);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== expected) throw new Error(`checksum mismatch from ${url}`);
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, bytes);
}

export async function fetchFreerouting(cache: string, target: string, withJdk = true) {
  const spec = freeroutingDownloadSpec(target);
  const jar = join(cache, `freerouting-${FREEROUTING_VERSION}.jar`);
  await checkedDownload(
    `https://github.com/freerouting/freerouting/releases/download/v${FREEROUTING_VERSION}/freerouting-${FREEROUTING_VERSION}.jar`,
    jar,
    JAR_SHA256,
  );
  const jdk = join(cache, `jdk-${target}-${JDK_VERSION}`);
  const jdkHome = target.startsWith("darwin") ? join(jdk, "Contents", "Home") : jdk;
  if (withJdk) {
    const archive = join(cache, spec.asset);
    await checkedDownload(
      `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/${spec.asset}`,
      archive,
      spec.sha256,
    );
    if (!(await stat(join(jdkHome, "release")).catch(() => null))) {
      const scratch = await mkdtemp(join(cache, "extract-"));
      try {
        if (target.startsWith("windows")) await command(["tar", "-xf", archive, "-C", scratch]);
        else await command(["tar", "-xzf", archive, "-C", scratch]);
        const entries = await readdir(scratch, { withFileTypes: true });
        const root = entries.find((entry) => entry.isDirectory());
        if (!root) throw new Error(`no JDK directory in ${archive}`);
        await cp(join(scratch, root.name), jdk, { recursive: true, dereference: true });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  }
  return { jar, jdkHome };
}

async function command(args: string[], cwd?: string): Promise<string> {
  const result = Bun.spawn(args, { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  if (code) throw new Error(`${args[0]} exited ${code}: ${stderr}`);
  return stdout.trim();
}

/** Fat jars contain dependency module-info classes; analyze extracted class files as a classpath. */
export async function trimFreeroutingRuntime(jar: string, jdkHome: string, output: string, target: string) {
  const suffix = target.startsWith("windows") ? ".exe" : "";
  const scratch = await mkdtemp(join(tmpdir(), "freerouting-jdeps-"));
  try {
    await command([join(jdkHome, "bin", `jar${suffix}`), "--extract", "--file", jar], scratch);
    const removeDescriptors = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await removeDescriptors(path);
        else if (entry.name === "module-info.class") await rm(path);
      }
    };
    await removeDescriptors(scratch);
    const dependencies = await command([
      join(jdkHome, "bin", `jdeps${suffix}`),
      "--ignore-missing-deps",
      "--multi-release",
      "25",
      "--print-module-deps",
      scratch,
    ]);
    // Service/reflection dependencies are invisible to jdeps (TLS, ZIP and logging providers).
    const modules = [...new Set([...dependencies.split(","), "jdk.crypto.ec", "jdk.zipfs", "jdk.unsupported", "java.naming"])].sort();
    await command([
      join(jdkHome, "bin", `jlink${suffix}`),
      "--add-modules",
      modules.join(","),
      "--strip-debug",
      "--no-header-files",
      "--no-man-pages",
      "--compress=zip-6",
      "--output",
      output,
    ]);
    return modules;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
