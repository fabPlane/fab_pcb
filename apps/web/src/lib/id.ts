/** KIID-shaped UUIDs (36-char form, as in kiapi.common.types.KIID.value). */
export function newKiid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for very old environments.
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

let counter = 0;
/** Deterministic, hex-only ids for mock fixtures so tests are stable and KIID detection works. */
export function mockKiid(tag: string): string {
  counter += 1;
  let h = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193) >>> 0;
  const head = h.toString(16).padStart(8, '0');
  const n = counter.toString(16).padStart(12, '0');
  return `${head}-0000-4000-8000-${n}`;
}
