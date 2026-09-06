// Structural patches over plain objects (the shape used by the schema-driven properties
// panel and by the command service's undo records).

export type PatchPath = (string | number)[];

export interface Patch {
  path: PatchPath;
  value: unknown; // `undefined` deletes the key / array slot
}

export function getPath(obj: unknown, path: PatchPath): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Returns a new object with the patch applied; untouched branches are shared. */
export function applyPatch<T>(obj: T, patch: Patch): T {
  return setPath(obj, patch.path, patch.value) as T;
}

export function applyPatches<T>(obj: T, patches: Patch[]): T {
  return patches.reduce((acc, p) => applyPatch(acc, p), obj);
}

function setPath(obj: unknown, path: PatchPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string | number, ...PatchPath];
  const isIndex = typeof head === 'number';
  const base: unknown = obj ?? (isIndex ? [] : {});
  if (Array.isArray(base)) {
    const copy = base.slice();
    if (rest.length === 0 && value === undefined) copy.splice(head as number, 1);
    else copy[head as number] = setPath(copy[head as number], rest, value);
    return copy;
  }
  const rec = { ...(base as Record<string, unknown>) };
  if (rest.length === 0 && value === undefined) delete rec[String(head)];
  else rec[String(head)] = setPath(rec[String(head)], rest, value);
  return rec;
}

/** Builds the inverse of `patch` against `before`, so that applying it to the patched object restores `before`. */
export function inversePatch(before: unknown, patch: Patch): Patch {
  return { path: patch.path, value: structuredCloneSafe(getPath(before, patch.path)) };
}

export function structuredCloneSafe<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
