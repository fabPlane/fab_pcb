/**
 * `/files` — list/read/write inside a configurable workspace root, for the UI's project browser.
 *
 *   GET  /files/list?path=<rel>            -> { path, absolutePath, entries: [{name, kind, size, mtime}] }
 *   GET  /files/stat?path=<rel>            -> { path, absolutePath, kind, size, mtime }
 *   GET  /files/read?path=<rel>            -> file bytes (text/plain for KiCad files)
 *   PUT  /files/write?path=<rel>           -> writes the request body; 204
 *   POST /files/mkdir?path=<rel>           -> 204
 *
 * `path` is relative to the workspace root; absolute paths are accepted only if they lie inside it.
 * Symlinks are resolved and must stay inside the root.
 */
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BridgeConfig } from "./config";

export class FilesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TEXT_EXT = new Set([
  ".kicad_pro",
  ".kicad_pcb",
  ".kicad_sch",
  ".kicad_sym",
  ".kicad_mod",
  ".kicad_wks",
  ".kicad_dru",
  ".kicad_prl",
  ".json",
  ".txt",
  ".md",
  ".csv",
  ".lib",
  ".dcm",
  ".net",
  ".gbr",
  ".drl",
  ".svg",
]);

export function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (TEXT_EXT.has(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/**
 * Resolve `requested` against `root` and verify it cannot escape (lexically and via symlinks of the
 * deepest existing ancestor). Returns the absolute path.
 */
export async function realRoot(root: string): Promise<string> {
  return realpath(root).catch(() => resolve(root));
}

export async function resolveInRoot(root: string, requested: string | null): Promise<string> {
  const rootAbs = resolve(root);
  const rootReal = await realRoot(root);
  let target: string;
  if (requested && isAbsolute(requested)) {
    // absolute paths may be spelled through either the configured root or its realpath
    const r = resolve(requested);
    if (inside(rootAbs, r)) target = resolve(rootReal, relative(rootAbs, r) || ".");
    else if (inside(rootReal, r)) target = r;
    else throw new FilesError(403, `path escapes the workspace root: ${requested}`);
  } else {
    target = resolve(rootReal, requested && requested !== "" ? requested : ".");
  }
  if (!inside(rootReal, target)) throw new FilesError(403, `path escapes the workspace root: ${requested}`);
  // resolve symlinks of the deepest existing ancestor
  let probe = target;
  let missing: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      const rebuilt = missing.length ? resolve(real, ...missing) : real;
      if (!inside(rootReal, rebuilt)) throw new FilesError(403, `path escapes the workspace root via symlink: ${requested}`);
      return rebuilt;
    } catch (e) {
      if (e instanceof FilesError) throw e;
      const parent = dirname(probe);
      if (parent === probe) throw new FilesError(400, `cannot resolve ${requested}`);
      missing = [basename(probe), ...missing];
      probe = parent;
    }
  }
}

function inside(root: string, p: string): boolean {
  if (p === root) return true;
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

export async function handleFiles(req: Request, url: URL, cfg: BridgeConfig, headers: HeadersInit): Promise<Response> {
  const op = url.pathname.replace(/^\/files\/?/, "") || "list";
  const requested = url.searchParams.get("path");
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
  try {
    const abs = await resolveInRoot(cfg.workspaceRoot, requested);
    const rel = relative(await realRoot(cfg.workspaceRoot), abs) || ".";
    switch (op) {
      case "list": {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        const st = await stat(abs).catch(() => null);
        if (!st) return json({ error: `not found: ${rel}` }, 404);
        if (!st.isDirectory()) return json({ error: `not a directory: ${rel}` }, 400);
        const names = await readdir(abs);
        const entries = [];
        for (const name of names.sort()) {
          if (name.startsWith(".")) continue;
          const s = await stat(resolve(abs, name)).catch(() => null);
          if (!s) continue;
          entries.push({ name, kind: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString() });
        }
        return json({ path: rel, absolutePath: abs, entries });
      }
      case "stat": {
        const s = await stat(abs).catch(() => null);
        if (!s) return json({ error: `not found: ${rel}` }, 404);
        return json({ path: rel, absolutePath: abs, kind: s.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtime.toISOString() });
      }
      case "read": {
        if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
        const s = await stat(abs).catch(() => null);
        if (!s || !s.isFile()) return json({ error: `not a file: ${rel}` }, 404);
        return new Response(Bun.file(abs), {
          headers: { ...headers, "content-type": contentTypeFor(abs), "x-file-path": abs },
        });
      }
      case "write": {
        if (req.method !== "PUT" && req.method !== "POST") return json({ error: "method not allowed" }, 405);
        const s = await stat(abs).catch(() => null);
        if (s?.isDirectory()) return json({ error: `is a directory: ${rel}` }, 400);
        await mkdir(dirname(abs), { recursive: true });
        const bytes = new Uint8Array(await req.arrayBuffer());
        await Bun.write(abs, bytes);
        return json({ path: rel, absolutePath: abs, size: bytes.length });
      }
      case "mkdir": {
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        await mkdir(abs, { recursive: true });
        return json({ path: rel, absolutePath: abs });
      }
      default:
        return json({ error: `unknown files operation: ${op}` }, 404);
    }
  } catch (e) {
    if (e instanceof FilesError) return json({ error: e.message }, e.status);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
