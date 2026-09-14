/**
 * A store-only ZIP writer, about sixty lines and no dependency.
 *
 * Wasm mode is the only caller: KiCad writes into the module's MEMFS, which dies with the tab, so
 * "Download project" reads the files back and hands the browser one archive. A project is a dozen
 * small text files — deflate would save bandwidth that never leaves the machine, and every library
 * that implements it is larger than the saving. So entries are stored (method 0), which every
 * unzip, Finder and Explorer included, reads.
 *
 * Deliberately not implemented: Zip64 (an entry or an archive over 4 GiB), encryption, and the
 * data-descriptor form. `zipStore()` throws rather than writing an archive that claims a size it
 * does not have.
 */

/** 4 GiB - 1: the largest size the classic (non-Zip64) headers can express. */
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, the only timestamp the classic headers carry (two-second resolution). */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

export interface ZipEntry {
  /** Path inside the archive, `/`-separated and relative (leading slashes are dropped). */
  path: string;
  bytes: Uint8Array;
  /** Defaults to now. */
  modified?: Date;
}

/**
 * Build the archive. Entry order is preserved, and duplicate paths are the caller's problem (a zip
 * may legally hold them; most tools show the last).
 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const utf8 = new TextEncoder();
  const files = entries.map((e) => {
    const name = utf8.encode(e.path.replace(/^\/+/, '').replaceAll('\\', '/'));
    if (e.bytes.length > MAX_SIZE) throw new Error(`${e.path} is too large for a non-Zip64 archive`);
    return { name, bytes: e.bytes, crc: crc32(e.bytes), ...dosDateTime(e.modified ?? new Date()) };
  });

  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.bytes.length, 0);
  const centralSize = files.reduce((n, f) => n + 46 + f.name.length, 0);
  if (localSize + centralSize + 22 > MAX_SIZE) throw new Error('the archive is too large for a non-Zip64 zip');

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => (view.setUint16(at, v, true), (at += 2));
  const u32 = (v: number) => (view.setUint32(at, v >>> 0, true), (at += 4));
  const raw = (b: Uint8Array) => (out.set(b, at), (at += b.length));

  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(at);
    u32(0x04034b50); // local file header
    u16(20); // version needed: 2.0
    u16(0x0800); // flags: the name is UTF-8
    u16(0); // method: stored
    u16(f.time);
    u16(f.date);
    u32(f.crc);
    u32(f.bytes.length); // compressed == uncompressed, because stored
    u32(f.bytes.length);
    u16(f.name.length);
    u16(0); // no extra field
    raw(f.name);
    raw(f.bytes);
  }

  const centralAt = at;
  for (const [i, f] of files.entries()) {
    u32(0x02014b50); // central directory header
    u16(20); // version made by
    u16(20); // version needed
    u16(0x0800);
    u16(0);
    u16(f.time);
    u16(f.date);
    u32(f.crc);
    u32(f.bytes.length);
    u32(f.bytes.length);
    u16(f.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0o100644 << 16); // external attributes: a regular file, rw-r--r--
    u32(offsets[i]!);
    raw(f.name);
  }

  // Read before the trailer is written: `at` moves as it goes.
  const centralBytes = at - centralAt;
  u32(0x06054b50); // end of central directory
  u16(0); // this disk
  u16(0); // the disk the central directory starts on
  u16(files.length);
  u16(files.length);
  u32(centralBytes);
  u32(centralAt);
  u16(0); // comment length
  return out;
}
