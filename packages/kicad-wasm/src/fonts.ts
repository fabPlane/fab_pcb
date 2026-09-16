/**
 * Outline fonts for the wasm module. Bun/Node only — this reads the host file system.
 *
 * KiCad's fontconfig wrapper is replaced in the headless build by a manifest reader
 * (`common/font/fontconfig_manifest.cpp`). It looks at `KICAD_FONTS_DIR` — set from the host
 * config's `fonts`, which defaults to `/kicad/fonts` in a wasm build — and expects either a
 * folder of font files or, better, a `manifest.json`:
 *
 * ```json
 * { "default": "Carlito",
 *   "fonts": [ { "family": "Carlito", "style": "Regular", "bold": false, "italic": false,
 *                "file": "Carlito-Regular.ttf" } ] }
 * ```
 *
 * Without one, every text item that names an outline font falls back to KiCad's stroke font, so
 * `GetTextAsShapes`, plots and text-height DRC rules all come back with the wrong geometry.
 *
 * The module is normally built with the two Carlito faces already preloaded at `/kicad/fonts`
 * (`KICAD_WASM_PRELOAD_FONTS`); `mountFonts()` is for adding to that, or for a module built
 * without the bundle.
 */
import { readdir, readFile as hostReadFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { mkdirTree, type HasFS } from "./fs";

/** Where the wasm build looks for fonts unless the host config says otherwise. */
export const DEFAULT_FONTS_DIR = "/kicad/fonts";

/** One face, as the manifest records it. */
export interface FontManifestEntry {
  family: string;
  style: string;
  bold: boolean;
  italic: boolean;
  /** File name relative to the manifest's own directory. */
  file: string;
}

export interface FontManifest {
  /** Family to fall back to when a board names a font that is not here. */
  default?: string;
  fonts: FontManifestEntry[];
}

export interface MountFontsResult {
  /** Directory the fonts now live at inside MEMFS. */
  memfsDir: string;
  /** The manifest that was written (or copied) alongside them. */
  manifest: FontManifest;
  files: number;
  bytes: number;
}

const FONT_EXTENSIONS = [".ttf", ".otf"];

function isFontFile(name: string): boolean {
  const lower = name.toLowerCase();
  return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function styleIsBold(style: string): boolean {
  const s = style.toLowerCase();
  if (/thin|light|regular|roman|book/.test(s)) return false;
  return /bold|heavy|black|thick|dark|semibold|demibold/.test(s);
}

function styleIsItalic(style: string): boolean {
  return /italic|oblique|slant/.test(style.toLowerCase());
}

// ------------------------------------------------------------------------ the sfnt name table

/**
 * Read name IDs 1 (family) and 2 (subfamily) out of a TrueType/OpenType file.
 *
 * Only enough of the sfnt container to find the `name` table and walk its records; a collection
 * (`ttcf`) or anything unparseable comes back as `null` and the caller falls back to the file
 * name. Windows (platform 3) records are UTF-16BE, Macintosh (platform 1) ones are single-byte.
 */
export function readFontNames(data: Uint8Array): { family: string; style: string } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12) return null;

  const tag = view.getUint32(0);
  // 0x00010000 = TrueType outlines, "OTTO" = CFF outlines, "true"/"typ1" = legacy Apple.
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565 && tag !== 0x74797031) return null;

  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > data.byteLength) return null;
    if (view.getUint32(rec) === 0x6e616d65 /* "name" */) {
      nameOffset = view.getUint32(rec + 8);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + 6 > data.byteLength) return null;

  const count = view.getUint16(nameOffset + 2);
  const stringOffset = nameOffset + view.getUint16(nameOffset + 4);

  // Best record per name ID: prefer Windows/Unicode over Macintosh, and the English entries.
  const best = new Map<number, { score: number; text: string }>();

  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + i * 12;
    if (rec + 12 > data.byteLength) break;
    const platformId = view.getUint16(rec);
    const languageId = view.getUint16(rec + 4);
    const nameId = view.getUint16(rec + 6);
    if (nameId !== 1 && nameId !== 2) continue;

    const length = view.getUint16(rec + 8);
    const offset = stringOffset + view.getUint16(rec + 10);
    if (offset + length > data.byteLength) continue;

    const bytes = data.subarray(offset, offset + length);
    let text: string;
    if (platformId === 3 || platformId === 0) {
      let out = "";
      for (let j = 0; j + 1 < bytes.length; j += 2) out += String.fromCharCode((bytes[j]! << 8) | bytes[j + 1]!);
      text = out;
    } else {
      text = new TextDecoder("latin1").decode(bytes);
    }
    text = text.replace(/\0/g, "").trim();
    if (!text) continue;

    // Windows English (3/0x409) is the one KiCad's FreeType path reports as family_name.
    const score = (platformId === 3 ? 2 : 1) + (languageId === 0x409 || languageId === 0 ? 1 : 0);
    const prev = best.get(nameId);
    if (!prev || score > prev.score) best.set(nameId, { score, text });
  }

  const family = best.get(1)?.text;
  if (!family) return null;
  return { family, style: best.get(2)?.text ?? "Regular" };
}

/** `Carlito-Bold.ttf` -> family `Carlito`, style `Bold`. The fallback when there is no name table. */
function namesFromFileName(name: string): { family: string; style: string } {
  const stem = name.replace(/\.[^.]+$/, "");
  const dash = stem.indexOf("-");
  if (dash <= 0) return { family: stem, style: "Regular" };
  return { family: stem.slice(0, dash), style: stem.slice(dash + 1) || "Regular" };
}

// ---------------------------------------------------------------------------------- manifests

export interface BuildManifestOptions {
  /** Family the module falls back to. Default: the family of the first regular face found. */
  defaultFamily?: string;
}

/**
 * Describe every font file in a host directory. Reads each file to get the family and style the
 * way KiCad's FreeType path does, rather than trusting the file name.
 */
export async function buildFontManifest(hostDir: string, opts: BuildManifestOptions = {}): Promise<FontManifest> {
  const entries: FontManifestEntry[] = [];

  for (const name of (await readdir(hostDir)).sort()) {
    if (!isFontFile(name)) continue;
    const data = await hostReadFile(join(hostDir, name)).catch(() => null);
    if (!data) continue;
    const names = readFontNames(new Uint8Array(data)) ?? namesFromFileName(name);
    entries.push({
      family: names.family,
      style: names.style,
      bold: styleIsBold(names.style),
      italic: styleIsItalic(names.style),
      file: name,
    });
  }

  const defaultFamily = opts.defaultFamily ?? entries.find((e) => !e.bold && !e.italic)?.family ?? entries[0]?.family;
  return defaultFamily ? { default: defaultFamily, fonts: entries } : { fonts: entries };
}

export interface MountFontsOptions extends BuildManifestOptions {
  /**
   * Use the host directory's own `manifest.json` when it has one, instead of rebuilding it.
   * Default `true`.
   */
  useExistingManifest?: boolean;
}

/**
 * Copy a host directory of font files into MEMFS and leave a `manifest.json` beside them.
 *
 * `memfsDir` defaults to `/kicad/fonts`, which is where the module looks with no extra config.
 * To mount somewhere else, pass the path through to `createKiCadWasm()`:
 *
 * ```ts
 * const dir = "/fonts";
 * const kicad = await createKiCadWasm({ env: fontsEnv(dir) });
 * await mountFonts(kicad, "./assets/fonts", dir);
 * ```
 */
export async function mountFonts(
  instance: HasFS,
  hostDir: string,
  memfsDir: string = DEFAULT_FONTS_DIR,
  opts: MountFontsOptions = {},
): Promise<MountFontsResult> {
  const fs = instance.FS;
  mkdirTree(fs, memfsDir);

  let manifest: FontManifest | null = null;

  if (opts.useExistingManifest !== false) {
    const existing = await hostReadFile(join(hostDir, "manifest.json"), "utf8").catch(() => null);
    if (existing !== null) {
      try {
        const parsed = JSON.parse(existing) as FontManifest;
        if (Array.isArray(parsed.fonts)) manifest = parsed;
      } catch {
        /* a broken manifest is no better than none; rebuild it */
      }
    }
  }

  manifest ??= await buildFontManifest(hostDir, opts);

  let files = 0;
  let bytes = 0;

  for (const name of await readdir(hostDir)) {
    if (!isFontFile(name)) continue;
    const st = await stat(join(hostDir, name));
    if (!st.isFile()) continue;
    const data = await hostReadFile(join(hostDir, name));
    fs.writeFile(posix.join(memfsDir, name), new Uint8Array(data));
    files++;
    bytes += data.byteLength;
  }

  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFile(posix.join(memfsDir, "manifest.json"), new TextEncoder().encode(text));

  return { memfsDir, manifest, files, bytes };
}

/**
 * The environment override for a fonts directory other than `/kicad/fonts`. Pass it as
 * `createKiCadWasm({ env: fontsEnv(dir) })`; the host applies `env` after its own `fonts`
 * default, so this wins.
 */
export function fontsEnv(memfsDir: string): Record<string, string> {
  return { KICAD_FONTS_DIR: memfsDir };
}
