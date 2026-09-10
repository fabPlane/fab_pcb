#!/usr/bin/env bun
/** Copy a headless KiCad.app build and make its non-system dylib closure relocatable. */
import { chmod, cp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const [appArg, outputArg, sourceArg] = process.argv.slice(2);
if (!appArg || !outputArg || !sourceArg) {
  console.error("usage: stage-macos.ts <KiCad.app> <runtime-output-dir> <KiCad-source-dir>");
  process.exit(2);
}

const sourceApp = resolve(appArg);
const output = resolve(outputArg);
const source = resolve(sourceArg);
const app = join(output, "KiCad.app");
const frameworks = join(app, "Contents", "Frameworks");
const sharedSupport = join(app, "Contents", "SharedSupport");
if (!(await stat(sourceApp).catch(() => null))?.isDirectory()) throw new Error(`KiCad.app not found: ${sourceApp}`);
if (!(await stat(source).catch(() => null))?.isDirectory()) throw new Error(`KiCad source not found: ${source}`);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(sourceApp, app, { recursive: true, preserveTimestamps: true });
await mkdir(frameworks, { recursive: true });

// The build tree does not populate SharedSupport. Match KiCad's macOS bundle
// assembly so the CLI can locate its schemas and project template at runtime.
await mkdir(sharedSupport, { recursive: true });
await cp(join(source, "api", "schemas"), join(sharedSupport, "schemas"), {
  recursive: true,
  preserveTimestamps: true,
});
await cp(join(source, "resources", "project_template"), join(sharedSupport, "template"), {
  recursive: true,
  preserveTimestamps: true,
});

const sourceByStagedPath = new Map<string, string>();
for (const file of await machoFiles(app)) sourceByStagedPath.set(file, file);

// Copy the complete Homebrew/local dependency closure. System libraries remain external.
let changed = true;
while (changed) {
  changed = false;
  for (const [file, original] of [...sourceByStagedPath]) {
    for (const dependency of dependencies(original)) {
      const source = await resolveDependency(dependency, original);
      if (!source || isSystem(source) || source.startsWith(`${app}/`)) continue;
      const canonical = await realpath(source).catch(() => source);
      // Keep the filename used by the Mach-O install name. Homebrew often exposes
      // an unversioned/major-version symlink whose real target has a different
      // basename; copying only the target name leaves the original install name
      // with nothing to rewrite to in the staged Frameworks directory.
      const destination = join(frameworks, basename(source));
      if (!sourceByStagedPath.has(destination)) {
        await cp(canonical, destination, { preserveTimestamps: true });
        await chmod(destination, 0o755);
        sourceByStagedPath.set(destination, canonical);
        changed = true;
      }
    }
  }
}

const staged = await machoFiles(app);
const includedByName = new Map(staged.map((file) => [basename(file), file]));
for (const file of staged) {
  const original = sourceByStagedPath.get(file) ?? file;
  for (const dependency of dependencies(file)) {
    if (dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/")) continue;
    const resolved = await resolveDependency(dependency, original);
    const included = includedByName.get(basename(resolved ?? dependency));
    if (!included || dependency.startsWith("@loader_path/")) continue;
    const rel = relative(dirname(file), included).replaceAll("\\", "/");
    run("install_name_tool", ["-change", dependency, `@loader_path/${rel}`, file]);
  }
  if (file.startsWith(`${frameworks}/`) && /\.(?:dylib|so)(?:\.|$)/.test(file)) {
    run("install_name_tool", ["-id", `@rpath/${basename(file)}`, file]);
  }
}

const cli = join(app, "Contents", "MacOS", "kicad-cli");
const pcbnew = join(app, "Contents", "PlugIns", "_pcbnew.kiface");
const eeschema = join(app, "Contents", "PlugIns", "_eeschema.kiface");
for (const required of [cli, pcbnew, eeschema]) {
  if (!(await stat(required).catch(() => null))?.isFile()) throw new Error(`staged KiCad file missing: ${required}`);
}
for (const required of [join(sharedSupport, "schemas"), join(sharedSupport, "template")]) {
  if (!(await stat(required).catch(() => null))?.isDirectory()) throw new Error(`staged KiCad data missing: ${required}`);
}
const version = run(cli, ["version"]);
console.log(`Staged relocatable KiCad runtime: ${app} (${version.trim()})`);

async function machoFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && run("file", ["-b", path], true).includes("Mach-O")) result.push(path);
    }
  }
  await visit(root);
  return result;
}

function dependencies(file: string): string[] {
  return run("otool", ["-L", file])
    .split("\n")
    .slice(1)
    .map((line) => /^\s*(\S+)\s+\(compatibility version/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
}

async function resolveDependency(dependency: string, loader: string): Promise<string | null> {
  if (dependency.startsWith("@loader_path/")) return resolve(dirname(loader), dependency.slice("@loader_path/".length));
  if (dependency.startsWith("@executable_path/") || dependency.startsWith("@rpath/")) {
    const name = basename(dependency);
    for (const candidate of [join(dirname(loader), name), join(frameworks, name), `/opt/homebrew/lib/${name}`, `/usr/local/lib/${name}`]) {
      if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
    }
    return null;
  }
  return dependency.startsWith("/") ? dependency : null;
}

function isSystem(path: string): boolean {
  return path.startsWith("/System/Library/") || path.startsWith("/usr/lib/");
}

function run(command: string, args: string[], allowFailure = false): string {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}
