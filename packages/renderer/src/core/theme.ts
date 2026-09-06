/**
 * KiCad colour themes.
 *
 * A Theme is a flat map from KiCad's JSON colour keys ("board.copper.f", "schematic.wire",
 * "board.via_hole", ...) to RGBA colours, exactly the keys produced by COLOR_SETTINGS in
 * common/settings/color_settings.cpp. The built-in themes are generated from the KiCad
 * sources by scripts/gen-themes.ts into ../../themes/*.json, in the same layout KiCad
 * writes user themes (~/.config/kicad/<ver>/colors/*.json), so the same loader reads both.
 */
import kicadDefaultJson from '../../themes/kicad-default.json';
import kicadClassicJson from '../../themes/kicad-classic.json';

export interface ThemeColor {
  /** 0..255 */
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export interface Theme {
  name: string;
  /** flat "a.b.c" keys as in color_settings.cpp */
  colors: Record<string, ThemeColor>;
  overrideSchItemColors: boolean;
}

export const WHITE: ThemeColor = { r: 255, g: 255, b: 255, a: 1 };
export const TRANSPARENT: ThemeColor = { r: 0, g: 0, b: 0, a: 0 };

// ---------------------------------------------------------------------------
// Colour parsing / formatting (mirrors COLOR4D::SetFromWxString / SetFromHexString / ToCSSString)
// ---------------------------------------------------------------------------

export function parseCssColor(s: string): ThemeColor | undefined {
  const str = s.trim();
  let m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(str);
  if (m) return { r: clamp255(+m[1]!), g: clamp255(+m[2]!), b: clamp255(+m[3]!), a: m[4] !== undefined ? clamp01(+m[4]) : 1 };
  m = /^#([0-9a-f]{3,8})$/i.exec(str);
  if (m) {
    const h = m[1]!;
    if (h.length === 3 || h.length === 4) {
      const v = h.split('').map((c) => parseInt(c + c, 16));
      return { r: v[0]!, g: v[1]!, b: v[2]!, a: h.length === 4 ? v[3]! / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = parseInt(h, 16);
      if (h.length === 8) return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: (n & 255) / 255 };
      return { r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255, a: 1 };
    }
  }
  const named = CSS_NAMED[str.toLowerCase()];
  if (named) return { ...named };
  return undefined;
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const CSS_NAMED: Record<string, ThemeColor> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

export function colorToCss(c: ThemeColor): string {
  const a8 = Math.round(c.a * 255);
  if (a8 === 255) return `rgb(${c.r}, ${c.g}, ${c.b})`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(a8 / 255).toFixed(3)})`;
}

/** 0xRRGGBB for Pixi tints. */
export const colorToHex = (c: ThemeColor): number => (c.r << 16) | (c.g << 8) | c.b;

export function colorWithAlpha(c: ThemeColor, a: number): ThemeColor {
  return { r: c.r, g: c.g, b: c.b, a };
}

export function mixColors(a: ThemeColor, b: ThemeColor, t: number): ThemeColor {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
    a: a.a + (b.a - a.a) * t,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a theme from KiCad's colour JSON (nested objects with CSS colour strings). Unknown
 * or unparsable entries are skipped. Accepts an already-parsed object or a JSON string.
 */
export function themeFromJson(json: unknown, fallbackName = 'Untitled'): Theme {
  const obj = (typeof json === 'string' ? JSON.parse(json) : json) as Record<string, unknown>;
  const colors: Record<string, ThemeColor> = {};
  const walk = (node: unknown, prefix: string): void => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') {
        const c = parseCssColor(v);
        if (c) colors[key] = c;
      } else if (v && typeof v === 'object') {
        walk(v, key);
      }
    }
  };
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'meta') continue;
    if (k === 'schematic' && v && typeof v === 'object') {
      // "schematic.override_item_colors" is a bool, not a colour
      walk(v, k);
      continue;
    }
    walk(v, k);
  }
  const meta = obj.meta as { name?: string } | undefined;
  const sch = obj.schematic as { override_item_colors?: boolean } | undefined;
  return { name: meta?.name ?? fallbackName, colors, overrideSchItemColors: !!sch?.override_item_colors };
}

/** Serialise back to KiCad's nested JSON layout. */
export function themeToJson(theme: Theme): Record<string, unknown> {
  const root: Record<string, unknown> = { meta: { name: theme.name, version: 6 } };
  for (const [key, c] of Object.entries(theme.colors)) {
    const parts = key.split('.');
    let node = root;
    for (const p of parts.slice(0, -1)) {
      node[p] ??= {};
      node = node[p] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = colorToCss(c);
  }
  (root.schematic as Record<string, unknown>).override_item_colors = theme.overrideSchItemColors;
  return root;
}

/** `over` wins; missing keys come from `base` (KiCad fills missing colours with the defaults). */
export function mergeThemes(base: Theme, over: Theme): Theme {
  return { name: over.name, colors: { ...base.colors, ...over.colors }, overrideSchItemColors: over.overrideSchItemColors };
}

export const KICAD_DEFAULT_THEME: Theme = themeFromJson(kicadDefaultJson, 'KiCad Default');
export const KICAD_CLASSIC_THEME: Theme = mergeThemes(KICAD_DEFAULT_THEME, themeFromJson(kicadClassicJson, 'KiCad Classic'));
export const BUILTIN_THEMES: readonly Theme[] = [KICAD_DEFAULT_THEME, KICAD_CLASSIC_THEME];

/** Load a user theme (e.g. ~/.config/kicad/10.0/colors/user.json) on top of the default theme. */
export function loadUserTheme(json: unknown): Theme {
  return mergeThemes(KICAD_DEFAULT_THEME, themeFromJson(json, 'User'));
}

// ---------------------------------------------------------------------------
// Layer -> colour
// ---------------------------------------------------------------------------

/** s_copperColors in builtin_color_themes.h, used for copper layers without an explicit colour. */
export const COPPER_LOOP_COLORS: readonly ThemeColor[] = [
  { r: 237, g: 124, b: 51, a: 1 },
  { r: 91, g: 195, b: 235, a: 1 },
  { r: 247, g: 111, b: 142, a: 1 },
  { r: 167, g: 165, b: 198, a: 1 },
  { r: 40, g: 204, b: 217, a: 1 },
  { r: 232, g: 178, b: 167, a: 1 },
  { r: 242, g: 237, b: 161, a: 1 },
];

/** s_userColors, used for user layers without an explicit colour. */
export const USER_LOOP_COLORS: readonly ThemeColor[] = [
  { r: 89, g: 148, b: 220, a: 1 },
  { r: 180, g: 219, b: 210, a: 1 },
  { r: 216, g: 200, b: 82, a: 1 },
  { r: 194, g: 194, b: 194, a: 1 },
];

/**
 * Theme key for a kiapi BoardLayer name: BL_F_Cu -> board.copper.f, BL_In3_Cu ->
 * board.copper.in3, BL_F_SilkS -> board.f_silks, BL_User_7 -> board.user_7. Keys that already
 * contain a dot are returned unchanged. Returns undefined for layers without a colour
 * (BL_UNKNOWN, BL_Rescue, ...).
 */
export function boardLayerThemeKey(layer: string): string | undefined {
  if (layer.includes('.')) return layer;
  const name = layer.startsWith('BL_') ? layer.slice(3) : layer;
  if (name === 'F_Cu') return 'board.copper.f';
  if (name === 'B_Cu') return 'board.copper.b';
  const inner = /^In(\d+)_Cu$/.exec(name);
  if (inner) return `board.copper.in${inner[1]}`;
  if (/^(UNKNOWN|UNDEFINED|UNSELECTED|Rescue)$/.test(name)) return undefined;
  return `board.${name.toLowerCase()}`;
}

/** GAL-only layers that have no JSON key in color_settings.cpp (values from builtin_color_themes.h). */
export const NON_SERIALISED_COLORS: Readonly<Record<string, ThemeColor>> = Object.freeze({
  'board.select_overlay': { r: 4, g: 255, b: 67, a: 1 },
  'board.gp_overlay': { r: 255, g: 255, b: 255, a: 1 },
});

/** Colour for a theme key with KiCad's fallbacks; never undefined. */
export function themeColor(theme: Theme, key: string): ThemeColor {
  const c = theme.colors[key] ?? KICAD_DEFAULT_THEME.colors[key] ?? NON_SERIALISED_COLORS[key];
  if (c) return c;
  const inner = /^board\.copper\.in(\d+)$/.exec(key);
  if (inner) return COPPER_LOOP_COLORS[(+inner[1]! + 3) % COPPER_LOOP_COLORS.length]!;
  const user = /^board\.user_(\d+)$/.exec(key);
  if (user) return USER_LOOP_COLORS[(+user[1]! + 52) % USER_LOOP_COLORS.length]!;
  return WHITE;
}

/** Colour for a render-model layer id (BoardLayer name or theme key). */
export function layerColor(theme: Theme, layer: string): ThemeColor {
  const key = boardLayerThemeKey(layer);
  if (!key) return WHITE;
  return themeColor(theme, key);
}

/** Colours the overlays need, resolved with fallbacks. */
export interface UiColors {
  background: ThemeColor;
  grid: ThemeColor;
  gridAxes: ThemeColor;
  cursor: ThemeColor;
  selection: ThemeColor;
  hover: ThemeColor;
  shadow: ThemeColor;
  ratsnest: ThemeColor;
  anchor: ThemeColor;
  auxItems: ThemeColor;
  drcError: ThemeColor;
  drcWarning: ThemeColor;
  drcExclusion: ThemeColor;
  padNetNames: ThemeColor;
  trackNetNames: ThemeColor;
  viaNetNames: ThemeColor;
}

export function uiColors(theme: Theme, kind: 'board' | 'schematic' = 'board'): UiColors {
  if (kind === 'schematic') {
    return {
      background: themeColor(theme, 'schematic.background'),
      grid: themeColor(theme, 'schematic.grid'),
      gridAxes: themeColor(theme, 'schematic.grid_axes'),
      cursor: themeColor(theme, 'schematic.cursor'),
      selection: themeColor(theme, 'schematic.brightened'),
      hover: themeColor(theme, 'schematic.hovered'),
      shadow: themeColor(theme, 'schematic.shadow'),
      ratsnest: themeColor(theme, 'board.ratsnest'),
      anchor: themeColor(theme, 'schematic.anchor'),
      auxItems: themeColor(theme, 'schematic.aux_items'),
      drcError: themeColor(theme, 'schematic.erc_error'),
      drcWarning: themeColor(theme, 'schematic.erc_warning'),
      drcExclusion: themeColor(theme, 'schematic.erc_exclusion'),
      padNetNames: themeColor(theme, 'board.pad_net_names'),
      trackNetNames: themeColor(theme, 'board.track_net_names'),
      viaNetNames: themeColor(theme, 'board.via_net_names'),
    };
  }
  return {
    background: themeColor(theme, 'board.background'),
    grid: themeColor(theme, 'board.grid'),
    gridAxes: themeColor(theme, 'board.grid_axes'),
    cursor: themeColor(theme, 'board.cursor'),
    selection: themeColor(theme, 'board.select_overlay'),
    hover: themeColor(theme, 'board.drc_highlighted'),
    shadow: themeColor(theme, 'board.locked_shadow'),
    ratsnest: themeColor(theme, 'board.ratsnest'),
    anchor: themeColor(theme, 'board.anchor'),
    auxItems: themeColor(theme, 'board.aux_items'),
    drcError: themeColor(theme, 'board.drc_error'),
    drcWarning: themeColor(theme, 'board.drc_warning'),
    drcExclusion: themeColor(theme, 'board.drc_exclusion'),
    padNetNames: themeColor(theme, 'board.pad_net_names'),
    trackNetNames: themeColor(theme, 'board.track_net_names'),
    viaNetNames: themeColor(theme, 'board.via_net_names'),
  };
}
