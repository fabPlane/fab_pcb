// Canvas colour themes: the renderer's KiCad Default JSON (dark board background) for the
// app's dark mode and a light variant (white board background, KiCad's schematic colours
// are light already) for light mode. The Settings dialog can pin the canvas to one of the
// renderer's built-in themes instead (`CANVAS_THEMES`, persisted as `uiStore.canvasTheme`).
// `mockPalette` flattens a theme into the CSS colours the Canvas2D mock host and the
// layer-panel swatches use.

import { KICAD_CLASSIC_THEME, KICAD_DEFAULT_THEME, colorToCss, layerColor, mergeThemes, themeColor, uiColors, type Theme, type ThemeColor } from '@kicad-web/renderer';
import { useUiStore, type CanvasThemeId } from '@/state/uiStore';

const c = (r: number, g: number, b: number, a = 1): ThemeColor => ({ r, g, b, a });

export const DARK_THEME: Theme = mergeThemes(KICAD_DEFAULT_THEME, {
  name: 'KiCad Default (dark)',
  colors: {
    'schematic.background': c(20, 24, 33),
    'schematic.grid': c(70, 76, 90),
    'schematic.cursor': c(255, 255, 255),
    'schematic.note': c(220, 220, 220),
    'schematic.sheet_background': c(0, 0, 0, 0),
    'schematic.note_background': c(0, 0, 0, 0),
  },
  overrideSchItemColors: false,
});

export const LIGHT_THEME: Theme = mergeThemes(KICAD_DEFAULT_THEME, {
  name: 'KiCad Default (light)',
  colors: {
    'board.background': c(250, 250, 252),
    'board.grid': c(190, 190, 196),
    'board.grid_axes': c(120, 120, 130),
    'board.cursor': c(0, 0, 0),
    'board.worksheet': c(90, 90, 120),
    'board.aux_items': c(60, 60, 60),
    'board.anchor': c(0, 0, 200),
    'board.copper.f': c(200, 52, 52),
    'board.copper.b': c(63, 104, 176),
    'board.edge_cuts': c(58, 58, 58),
    'board.silkscreen_top': c(138, 130, 64),
    'board.silkscreen_bottom': c(150, 90, 70),
    'board.fab_top': c(111, 111, 111),
    'board.courtyard_top': c(194, 24, 168),
    'board.user_drawings': c(90, 90, 90),
    'board.user_comments': c(0, 0, 208),
  },
  overrideSchItemColors: false,
});

/** Choices offered by Settings → Appearance → Canvas colours. */
export const CANVAS_THEMES: readonly { id: CanvasThemeId; label: string; description: string }[] = [
  { id: 'auto', label: 'Follow UI theme', description: 'KiCad Default on a dark UI, its light variant on a light UI' },
  { id: 'kicad-default', label: KICAD_DEFAULT_THEME.name, description: 'KiCad’s stock colours regardless of the UI theme' },
  { id: 'kicad-classic', label: KICAD_CLASSIC_THEME.name, description: 'The pre-6.0 KiCad palette, black background' },
];

/**
 * Themes read from KiCad (`GetColorTheme`). `themeFor` is synchronous — the canvases call it on
 * every repaint — so a server theme is registered once it has been fetched and looked up here;
 * an unregistered `server:<name>` falls back to the UI theme until the fetch lands.
 */
const serverThemes = new Map<string, Theme>();

/** Makes a theme fetched from KiCad available to `themeFor('...', 'server:<name>')`. */
export function registerServerTheme(name: string, theme: Theme): void {
  serverThemes.set(name, theme);
}

export function serverThemeId(name: string): CanvasThemeId {
  return `server:${name}`;
}

/** The theme name behind a `server:<name>` id, or undefined for the built-ins. */
export function serverThemeName(id: CanvasThemeId): string | undefined {
  return id.startsWith('server:') ? id.slice('server:'.length) : undefined;
}

/**
 * Canvas theme for the resolved UI theme. `canvas` defaults to the persisted choice; 'auto'
 * follows the UI theme, the others pin a built-in or a theme read from KiCad.
 */
export function themeFor(mode: 'light' | 'dark', canvas: CanvasThemeId = useUiStore.getState().canvasTheme): Theme {
  switch (canvas) {
    case 'kicad-default':
      return KICAD_DEFAULT_THEME;
    case 'kicad-classic':
      return KICAD_CLASSIC_THEME;
    default: {
      const name = serverThemeName(canvas);
      const server = name !== undefined ? serverThemes.get(name) : undefined;
      if (server) return server;
      return mode === 'dark' ? DARK_THEME : LIGHT_THEME;
    }
  }
}

/** Theme key for the schematic pseudo layers the mock/layer panel use. */
const SCH_LAYER_KEYS: Record<string, string> = {
  SLT_WIRE: 'schematic.wire',
  SLT_BUS: 'schematic.bus',
  SLT_GRAPHIC: 'schematic.note',
};

/** CSS colour of a render-model layer (`BL_*` board layer or `SLT_*` pseudo layer). */
export function layerColour(theme: Theme, layer: string | undefined): string {
  if (!layer) return colorToCss(themeColor(theme, 'board.aux_items'));
  const sch = SCH_LAYER_KEYS[layer] ?? (layer.startsWith('schematic.') ? layer : undefined);
  if (sch) return colorToCss(themeColor(theme, sch));
  return colorToCss(layerColor(theme, layer));
}

export interface MockPalette {
  layers: (layer: string | undefined) => string;
  ui: {
    background: string;
    grid: string;
    cursor: string;
    selection: string;
    hover: string;
    highlight: string;
    ratsnest: string;
    text: string;
    pinName: string;
    wire: string;
    bus: string;
    label: string;
    symbolBody: string;
    symbolOutline: string;
    sheet: string;
  };
}

/** Flattened CSS palette for the Canvas2D mock host. */
export function mockPalette(theme: Theme, kind: 'board' | 'schematic' | 'footprint' | 'symbol'): MockPalette {
  const ui = uiColors(theme, kind === 'schematic' || kind === 'symbol' ? 'schematic' : 'board');
  const key = (k: string) => colorToCss(themeColor(theme, k));
  return {
    layers: (layer) => layerColour(theme, layer),
    ui: {
      background: colorToCss(ui.background),
      grid: colorToCss(ui.grid),
      cursor: colorToCss(ui.cursor),
      selection: colorToCss(ui.selection),
      hover: colorToCss(ui.hover),
      highlight: key('board.ratsnest'),
      ratsnest: colorToCss(ui.ratsnest),
      text: kind === 'schematic' ? key('schematic.note') : key('board.aux_items'),
      pinName: key('schematic.pin_name'),
      wire: key('schematic.wire'),
      bus: key('schematic.bus'),
      label: key('schematic.label_local'),
      symbolBody: key('schematic.component_body'),
      symbolOutline: key('schematic.component_outline'),
      sheet: key('schematic.sheet'),
    },
  };
}
