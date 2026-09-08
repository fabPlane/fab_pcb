/**
 * MEMFS helpers: getting a project (and the library fixtures it points at) into the module's file
 * system and getting job outputs back out. Bun/Node only — they read the host file system.
 *
 * The wasm build has no access to the host disk, so anything KiCad must open has to be copied in
 * first. Mounting a host directory at *the same absolute path* inside MEMFS keeps every path in a
 * `.kicad_pro`, an `fp-lib-table` or a test fixture valid without rewriting it, which is what the
 * conformance suite relies on.
 */
import { readdir, readFile as hostReadFile, rm as hostRm, stat } from "node:fs/promises";
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

// ---------------------------------------------------------------------------- two-way mirroring

/**
 * Keeps one directory identical on the host and inside MEMFS.
 *
 * The wasm module has no host file system, so a caller that wants to *drive* KiCad the way a test
 * or a bridge session does — write a file on the host, ask KiCad to open it, then look at what
 * KiCad wrote — has to move the bytes across in both directions at every request boundary.
 * `DirMirror` does that with a signature (size + mtime) per file, so a request that changes
 * nothing costs one directory walk on each side and no copying. Directories are mirrored as
 * entries in their own right: `CreateLibrary` makes an empty `foo.pretty/`, and a caller that only
 * copied files would never see it appear.
 *
 * The two directions are deliberately asymmetric in who wins: `pushToMemfs()` treats the host as
 * the truth (it is what the test just wrote), `pullToHost()` treats MEMFS as the truth (it is what
 * KiCad just wrote). Both mirror deletions. That is only consistent because they are called in
 * that order around every request, which leaves the two sides equal at each boundary.
 */
/** Signature standing for "this entry is a directory". */
const DIR = "dir";

/** Entries that were in `known` and are not in `now`, children before their parents. */
function deepestFirst(known: Map<string, string>, now: Map<string, string>): string[] {
  return [...known.keys()].filter((rel) => !now.has(rel)).sort((a, b) => b.split("/").length - a.split("/").length);
}

export class DirMirror {
  /** Signature of every entry as last seen on the host, keyed by path relative to `dir`; a
   * directory's signature is the constant `DIR`. */
  private readonly host = new Map<string, string>();
  /** Same, as last seen in MEMFS. */
  private readonly mem = new Map<string, string>();

  constructor(
    private readonly instance: HasFS,
    readonly dir: string,
    private readonly memfsDir: string = dir,
  ) {}

  /** Record both sides as they are, copying nothing — call it right after the initial mount. */
  async prime(): Promise<void> {
    for (const [rel, sig] of await this.hostFiles()) this.host.set(rel, sig);
    for (const [rel, sig] of this.memfsFiles()) this.mem.set(rel, sig);
  }

  /** Host → MEMFS, including deletions. Returns how many entries were written and removed. */
  async pushToMemfs(): Promise<{ written: number; removed: number }> {
    const fs = this.instance.FS;
    const now = await this.hostFiles();
    let written = 0;
    let removed = 0;
    for (const [rel, sig] of now) {
      if (this.host.get(rel) === sig) continue;
      const memfsPath = posix.join(this.memfsDir, rel);
      if (sig === DIR) {
        mkdirTree(fs, memfsPath);
        this.host.set(rel, sig);
        this.mem.set(rel, sig);
        written++;
        continue;
      }
      const data = await hostReadFile(join(this.dir, rel));
      mkdirTree(fs, posix.dirname(memfsPath));
      fs.writeFile(memfsPath, new Uint8Array(data));
      this.host.set(rel, sig);
      this.mem.set(rel, this.memfsSig(memfsPath) ?? sig);
      written++;
    }
    for (const rel of deepestFirst(this.host, now)) {
      const wasDir = this.host.get(rel) === DIR;
      this.host.delete(rel);
      this.mem.delete(rel);
      try {
        if (wasDir) fs.rmdir?.(posix.join(this.memfsDir, rel));
        else fs.unlink(posix.join(this.memfsDir, rel));
        removed++;
      } catch {
        /* already gone, or a directory the module still has entries in */
      }
    }
    return { written, removed };
  }

  /** MEMFS → host, including deletions. Returns how many entries were written and removed. */
  async pullToHost(): Promise<{ written: number; removed: number }> {
    const now = this.memfsFiles();
    let written = 0;
    let removed = 0;
    for (const [rel, sig] of now) {
      if (this.mem.get(rel) === sig) continue;
      const hostPath = join(this.dir, rel);
      if (sig === DIR) {
        await mkdir(hostPath, { recursive: true });
        this.mem.set(rel, sig);
        this.host.set(rel, sig);
        written++;
        continue;
      }
      await mkdir(dirname(hostPath), { recursive: true });
      await hostWriteFile(hostPath, readFile(this.instance, posix.join(this.memfsDir, rel)));
      this.mem.set(rel, sig);
      this.host.set(rel, (await this.hostSig(hostPath)) ?? sig);
      written++;
    }
    for (const rel of deepestFirst(this.mem, now)) {
      const wasDir = this.mem.get(rel) === DIR;
      this.mem.delete(rel);
      this.host.delete(rel);
      try {
        await hostRm(join(this.dir, rel), { force: true, recursive: wasDir });
        removed++;
      } catch {
        /* already gone */
      }
    }
    return { written, removed };
  }

  private async hostFiles(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      // A directory removed under us just contributes nothing.
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.set(childRel, DIR);
          await walk(child, childRel);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          const sig = await this.hostSig(child);
          if (sig) out.set(childRel, sig);
        }
      }
    };
    await walk(this.dir, "");
    return out;
  }

  private async hostSig(path: string): Promise<string | null> {
    try {
      const st = await stat(path);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private memfsFiles(): Map<string, string> {
    const fs = this.instance.FS;
    const out = new Map<string, string>();
    const walk = (dir: string, rel: string): void => {
      let entries: string[];
      try {
        entries = fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === "." || name === "..") continue;
        const childRel = rel ? `${rel}/${name}` : name;
        const child = posix.join(dir, name);
        let mode: number;
        try {
          mode = fs.stat(child).mode;
        } catch {
          continue;
        }
        if (fs.isDir(mode)) {
          out.set(childRel, DIR);
          walk(child, childRel);
        } else {
          const sig = this.memfsSig(child);
          if (sig) out.set(childRel, sig);
        }
      }
    };
    walk(this.memfsDir, "");
    return out;
  }

  private memfsSig(path: string): string | null {
    try {
      const st = this.instance.FS.stat(path) as { size: number; mtime?: Date | number };
      const mtime = st.mtime instanceof Date ? st.mtime.getTime() : (st.mtime ?? 0);
      return `${st.size}:${mtime}`;
    } catch {
      return null;
    }
  }
}
