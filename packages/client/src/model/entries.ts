/**
 * Normalisation for mapping-shaped arguments.
 *
 * Several commands take "a mapping from X to Y". The obvious implementation,
 *
 *     Array.isArray(x) ? x : Object.entries(x)
 *
 * silently does the wrong thing for a `Map`: `Array.isArray` is false and `Object.entries` on a
 * `Map` is `[]`, so the call succeeds and sends nothing. Depending on the command that is a
 * no-op, a wizard run with every parameter left at its default, or — with a replace-style merge
 * mode — the deletion of everything that was there. Nothing throws, so it looks like it worked.
 *
 * `toEntries` accepts the three shapes callers actually reach for, and rejects everything else
 * loudly instead of quietly reading it as empty.
 */

/** A mapping: a `Map`, a plain object, or an iterable of `[key, value]` pairs. */
export type EntryMapLike<V> = ReadonlyMap<string, V> | Readonly<Record<string, V>> | Iterable<readonly [string, V]>;

const SHAPES = "a Map, a plain object, or an array of [key, value] pairs";

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const t = typeof value;
  if (t !== "object") return `a ${t}`;
  const name = (value as object).constructor?.name;
  return name && name !== "Object" ? `a ${name}` : "an object";
}

function pair<V>(entry: unknown, index: number, what: string): [string, V] {
  if (!Array.isArray(entry) || entry.length !== 2) {
    throw new TypeError(`${what}: entry ${index} must be a [key, value] pair, got ${describe(entry)}`);
  }
  const [key, value] = entry as [unknown, V];
  if (typeof key !== "string") {
    throw new TypeError(`${what}: entry ${index} has a ${typeof key} key; keys must be strings`);
  }
  return [key, value];
}

/**
 * `[key, value]` pairs from a `Map`, a plain object or an iterable of pairs.
 *
 * @param input the caller's mapping argument
 * @param what  what to call it in error messages, e.g. `assignFootprints(assignments)`
 * @throws TypeError for `null`, `undefined`, primitives, and iterables that do not yield pairs
 */
export function toEntries<V>(input: EntryMapLike<V>, what: string): Array<[string, V]> {
  if (input === null || input === undefined) {
    throw new TypeError(`${what}: expected ${SHAPES}, got ${input === null ? "null" : "undefined"}`);
  }
  if (input instanceof Map) return [...input];
  if (typeof input !== "object") {
    throw new TypeError(`${what}: expected ${SHAPES}, got ${describe(input)}`);
  }
  // arrays and other iterables (generators, `map.entries()`) must yield pairs
  if (Symbol.iterator in input) {
    return [...(input as Iterable<readonly [string, V]>)].map((entry, i) => pair<V>(entry, i, what));
  }
  return Object.entries(input as Record<string, V>);
}

/** `toEntries` as a plain object, for proto map fields. */
export function toRecord<V>(input: EntryMapLike<V>, what: string): Record<string, V> {
  return Object.fromEntries(toEntries(input, what));
}
