/**
 * Generates themes/kicad-default.json and themes/kicad-classic.json from the KiCad
 * source tree (a faithful port of the built-in colour themes).
 *
 * Sources:
 *   common/settings/builtin_color_themes.h   s_defaultTheme / s_classicTheme (layer id -> COLOR4D)
 *   common/settings/color_settings.cpp       CLR( "json.key", LAYER_ID ) mapping
 *   common/gal/color4d.cpp                   colorRefs() legacy named colour table (stored B,G,R!)
 *
 * Usage: bun run scripts/gen-themes.ts [path-to-kicad-src]
 *   (defaults to $KICAD_SRC or ../../../kicad relative to this package)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kicadSrc = resolve(process.argv[2] ?? process.env.KICAD_SRC ?? resolve(here, '../../../../kicad'));
const outDir = resolve(here, '../themes');

const themesHeader = readFileSync(resolve(kicadSrc, 'common/settings/builtin_color_themes.h'), 'utf8');
const colorSettings = readFileSync(resolve(kicadSrc, 'common/settings/color_settings.cpp'), 'utf8');
const color4d = readFileSync(resolve(kicadSrc, 'common/gal/color4d.cpp'), 'utf8');

type Rgba = { r: number; g: number; b: number; a: number };

// ---------------------------------------------------------------------------
// 1. Legacy named colours. NOTE: StructColors is { m_Blue, m_Green, m_Red, ... }.
// ---------------------------------------------------------------------------
const named = new Map<string, Rgba>();
{
  const table = color4d.slice(color4d.indexOf('s_ColorRefs[NBCOLORS]'));
  const re = /\{\s*(\d+),\s*(\d+),\s*(\d+),\s*([A-Z]+),/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(table))) {
    named.set(m[4]!, { b: +m[1]!, g: +m[2]!, r: +m[3]!, a: 1 });
  }
  if (named.size < 30) throw new Error('failed to parse colorRefs()');
}
named.set('UNSPECIFIED_COLOR', { r: 0, g: 0, b: 0, a: 0 });

// ---------------------------------------------------------------------------
// 2. Parse a theme map from the header.
// ---------------------------------------------------------------------------
function stripMacIfdefs(src: string): string {
  // keep the #else branch (generic, non-mac values)
  return src.replace(/#ifdef __WXMAC__[\s\S]*?#else([\s\S]*?)#endif/g, '$1');
}

function parseColor(expr: string): Rgba {
  expr = expr.trim();
  let m = /^CSS_COLOR\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(expr);
  if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: +m[4]! };
  m = /^COLOR4D\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/.exec(expr);
  if (m) return { r: Math.round(+m[1]! * 255), g: Math.round(+m[2]! * 255), b: Math.round(+m[3]! * 255), a: +m[4]! };
  m = /^COLOR4D\(\s*([A-Z_]+)\s*\)(?:\.WithAlpha\(\s*([\d.]+)\s*\))?$/.exec(expr);
  if (m) {
    const base = named.get(m[1]!);
    if (!base) throw new Error(`unknown named colour ${m[1]}`);
    return { ...base, a: m[2] !== undefined ? +m[2] : base.a };
  }
  throw new Error(`cannot parse colour expression: ${expr}`);
}

function parseThemeMap(name: string): Map<string, Rgba> {
  const start = themesHeader.indexOf(`s_${name} =`);
  if (start < 0) throw new Error(`theme ${name} not found`);
  const end = themesHeader.indexOf('};', start);
  const body = stripMacIfdefs(themesHeader.slice(start, end));
  const out = new Map<string, Rgba>();
  const re = /\{\s*([A-Za-z_0-9]+(?:\s*\+\s*\d+)?)\s*,\s*((?:CSS_COLOR|COLOR4D)\([^)]*\)(?:\.WithAlpha\([^)]*\))?)\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const key = m[1]!.replace(/\s+/g, '');
    out.set(key, parseColor(m[2]!));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. JSON key -> layer id mapping from color_settings.cpp
// ---------------------------------------------------------------------------
const keyToLayer: Array<[string, string]> = [];
{
  const re = /CLR\(\s*"([^"]+)"\s*,\s*([A-Za-z_0-9]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(colorSettings))) keyToLayer.push([m[1]!, m[2]!]);
  if (keyToLayer.length < 100) throw new Error('failed to parse CLR() table');
}
const GERBER_DRAWLAYERS_COUNT = 64; // layer_ids.h
for (let i = 0; i < GERBER_DRAWLAYERS_COUNT; i++) {
  keyToLayer.push([`gerbview.layers.${i}`, i === 0 ? 'GERBVIEW_LAYER_ID_START' : `GERBVIEW_LAYER_ID_START+${i}`]);
}
// 3d_viewer.user_N default to the matching PCB User_N colour; fab/courtyard likewise
for (let i = 1; i <= 45; i++) keyToLayer.push([`3d_viewer.user_${i}`, `User_${i}`]);
keyToLayer.push(
  ['3d_viewer.f_fab', 'F_Fab'],
  ['3d_viewer.b_fab', 'B_Fab'],
  ['3d_viewer.f_courtyard', 'F_CrtYd'],
  ['3d_viewer.b_courtyard', 'B_CrtYd'],
);

// ---------------------------------------------------------------------------
// 4. Emit in KiCad's own JSON layout (nested objects, CSS colour strings)
// ---------------------------------------------------------------------------
function toCss(c: Rgba): string {
  // mirrors COLOR4D::ToCSSString(): alpha quantised to 8 bits then printed with 3 decimals
  const a8 = Math.round(c.a * 255);
  if (a8 === 255) return `rgb(${c.r}, ${c.g}, ${c.b})`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(a8 / 255).toFixed(3)})`;
}

function emit(displayName: string, file: string, colours: Map<string, Rgba>, requireAll: boolean) {
  const root: Record<string, unknown> = { meta: { name: displayName, version: 6 } };
  let count = 0;
  for (const [key, layer] of keyToLayer) {
    const c = colours.get(layer);
    if (!c) {
      if (requireAll) throw new Error(`theme ${displayName} lacks ${layer} for ${key}`);
      continue;
    }
    const parts = key.split('.');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      node[p] ??= {};
      node = node[p] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = toCss(c);
    count++;
  }
  const sorted = sortKeys(root);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, file), JSON.stringify(sorted, null, 2) + '\n');
  console.log(`${file}: ${count} colours`);
}

function sortKeys(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

emit('KiCad Default', 'kicad-default.json', parseThemeMap('defaultTheme'), true);
emit('KiCad Classic', 'kicad-classic.json', parseThemeMap('classicTheme'), false);
