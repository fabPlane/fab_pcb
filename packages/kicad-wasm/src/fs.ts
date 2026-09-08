/**
 * MEMFS helpers: getting a project (and the library fixtures it points at) into the module's file
 * system and getting job outputs back out. Bun/Node only — they read the host file system.
 *
 * The wasm build has no access to the host disk, so anything KiCad must open has to be copied in
 * first. Mounting a host directory at *the same absolute path* inside MEMFS keeps every path in a
 * `.kicad_pro`, an `fp-lib-table` or a test fixture valid without rewriting it, which is what the
 * conformance suite relies on.
 */
import { readdir, readFile as hostReadFile, stat } from "node:fs/promises";
import { mkdir, writeFile as hostWriteFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { KiCadWasmFS } from "./index";

/** Create `path` and every missing parent in MEMFS. Existing directories are left alone. */
export function mkdirTree(fs: KiCadWasmFS, path: string): void {
  if (!path || path === "/") return;
  if (typeof fs.mkdirTree === "function") {
    try {
      fs.mkdirTree(path);
      return;
    } catch {
      /* fall through to the manual walk */
    }
  }
  let cur = "";
  for (const part of path.split("/")) {
    if (!part) continue;
    cur += `/${part}`;
    try {
      fs.mkdir(cur);
    } catch {
      /* already there */
    }
  }
}

/** The part of `KiCadWasm` these helpers need (so a bare `{ FS }` works too). */
export interface HasFS {
  readonly FS: KiCadWasmFS;
}

export interface MountResult {
  files: number;
  bytes: number;
  /** Directory the tree now lives at inside MEMFS. */
  memfsDir: string;
}

export interface MountOptions {
  /** Skip entries whose path relative to `hostDir` returns `false`. */
  filter?: (relPath: string, isDir: boolean) => boolean;
  /** Do not descend into directories (copy the top-level files only). */
  shallow?: boolean;
}

/**
 * Copy a host directory into MEMFS, recursively. `memfsDir` defaults to `hostDir`, i.e. the tree
 * appears under the same absolute path it has on the host.
 */
export async function mountProject(
  instance: HasFS,
  hostDir: string,
  memfsDir: string = hostDir,
  opts: MountOptions = {},
): Promise<MountResult> {
  const fs = instance.FS;
  mkdirTree(fs, memfsDir);
  let files = 0;
  let bytes = 0;

  const walk = async (hostPath: string, memfsPath: string, rel: string): Promise<void> => {
    for (const entry of await readdir(hostPath, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (opts.filter && !opts.filter(childRel, isDir)) continue;
      const childHost = join(hostPath, entry.name);
      const childMemfs = posix.join(memfsPath, entry.name);
      if (isDir) {
        if (opts.shallow) continue;
        mkdirTree(fs, childMemfs);
        await walk(childHost, childMemfs, childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const data = await hostReadFile(childHost);
        fs.writeFile(childMemfs, new Uint8Array(data));
        files++;
        bytes += data.byteLength;
      }
    }
  };

  await walk(hostDir, memfsDir, "");
  return { files, bytes, memfsDir };
}

/** Copy a single host file into MEMFS (parents created on the way). */
export async function mountFile(instance: HasFS, hostPath: string, memfsPath: string = hostPath): Promise<number> {
  const data = await hostReadFile(hostPath);
  mkdirTree(instance.FS, posix.dirname(memfsPath));
  instance.FS.writeFile(memfsPath, new Uint8Array(data));
  return data.byteLength;
}

/** Copy `hostPath` into MEMFS if it is a file, or mount it as a tree if it is a directory. */
export async function mountPath(instance: HasFS, hostPath: string, memfsPath: string = hostPath): Promise<MountResult> {
  const st = await stat(hostPath);
  if (st.isDirectory()) return mountProject(instance, hostPath, memfsPath);
  const bytes = await mountFile(instance, hostPath, memfsPath);
  return { files: 1, bytes, memfsDir: posix.dirname(memfsPath) };
}

/** Write bytes (or text) into MEMFS, creating parent directories. */
export function writeFile(instance: HasFS, path: string, data: Uint8Array | string): void {
  mkdirTree(instance.FS, posix.dirname(path));
  instance.FS.writeFile(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
}

/** Read a MEMFS file as bytes. */
export function readFile(instance: HasFS, path: string): Uint8Array {
  return instance.FS.readFile(path, { encoding: "binary" });
}

/** Read a MEMFS file as UTF-8 text. */
export function readTextFile(instance: HasFS, path: string): string {
  return new TextDecoder().decode(readFile(instance, path));
}

/** True if `path` exists in MEMFS. */
export function exists(instance: HasFS, path: string): boolean {
  try {
    instance.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `memfsDir`, as absolute MEMFS paths. */
export function listFiles(instance: HasFS, memfsDir: string): string[] {
  const fs = instance.FS;
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      const path = posix.join(dir, name);
      let st: { mode: number };
      try {
        st = fs.stat(path);
      } catch {
        continue;
      }
      if (fs.isDir(st.mode)) walk(path);
      else out.push(path);
    }
  };
  walk(memfsDir);
  return out.sort();
}

/** Copy a MEMFS tree back to the host — for job outputs the module wrote into memory. */
export async function exportDir(instance: HasFS, memfsDir: string, hostDir: string): Promise<number> {
  let files = 0;
  for (const path of listFiles(instance, memfsDir)) {
    const rel = path.slice(memfsDir.length).replace(/^\//, "");
    const target = join(hostDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await hostWriteFile(target, readFile(instance, path));
    files++;
  }
  return files;
}
