/**
 * A browser implementation of the three `node:path` functions `@fp-pcb/kicad-wasm`'s MEMFS helpers
 * use, aliased in by `vite.config.ts` (Vite's own `node:` externals export nothing, so `posix.join`
 * would be `undefined` at runtime).
 *
 * Unlike the `node:fs/promises` stub next door these have to *work*: MEMFS paths are POSIX paths,
 * and `writeFile` / `listFiles` build them with `posix.dirname` and `posix.join`. Only the POSIX
 * flavour exists — a tab has no drive letters and no host file system to be compatible with.
 */

/** POSIX `path.join`, with `.` and `..` resolved and duplicate slashes collapsed. */
export function join(...parts: string[]): string {
  const joined = parts.filter((p) => p.length > 0).join('/');
  if (joined === '') return '.';
  const absolute = joined.startsWith('/');
  const out: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else if (segment !== '..' || !absolute) out.push(segment);
  }
  const path = out.join('/');
  return absolute ? `/${path}` : path || '.';
}

/** POSIX `path.dirname`. */
export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return '.';
  if (cut === 0) return '/';
  return trimmed.slice(0, cut);
}

/** POSIX `path.basename`. */
export function basename(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export const posix = { join, dirname, basename };

export default { join, dirname, basename, posix };
