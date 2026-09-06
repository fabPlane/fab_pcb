import { describe, expect, test } from 'bun:test';
import {
  BUILTIN_THEMES,
  KICAD_CLASSIC_THEME,
  KICAD_DEFAULT_THEME,
  boardLayerThemeKey,
  colorToCss,
  colorToHex,
  layerColor,
  loadUserTheme,
  parseCssColor,
  themeColor,
  themeFromJson,
  themeToJson,
  uiColors,
} from '../src/core/theme.js';

describe('colour parsing', () => {
  test('rgb / rgba / hex forms', () => {
    expect(parseCssColor('rgb(200, 52, 52)')).toEqual({ r: 200, g: 52, b: 52, a: 1 });
    expect(parseCssColor('rgba(2, 255, 238, 0.400)')).toEqual({ r: 2, g: 255, b: 238, a: 0.4 });
    expect(parseCssColor('#c83434')).toEqual({ r: 200, g: 52, b: 52, a: 1 });
    expect(parseCssColor('#c8343480')).toEqual({ r: 200, g: 52, b: 52, a: 128 / 255 });
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('nonsense')).toBeUndefined();
  });

  test('round-trips through KiCad CSS format', () => {
    expect(colorToCss({ r: 200, g: 52, b: 52, a: 1 })).toBe('rgb(200, 52, 52)');
    expect(colorToCss({ r: 2, g: 255, b: 238, a: 0.4 })).toBe('rgba(2, 255, 238, 0.400)');
    expect(colorToHex({ r: 200, g: 52, b: 52, a: 1 })).toBe(0xc83434);
  });
});

describe('built-in themes (ported from builtin_color_themes.h)', () => {
  test('KiCad Default has the well-known copper colours', () => {
    const t = KICAD_DEFAULT_THEME;
    expect(t.name).toBe('KiCad Default');
    expect(t.colors['board.copper.f']).toEqual({ r: 200, g: 52, b: 52, a: 1 }); // F_Cu red
    expect(t.colors['board.copper.b']).toEqual({ r: 77, g: 127, b: 196, a: 1 }); // B_Cu blue
    expect(t.colors['board.copper.in1']).toEqual({ r: 127, g: 200, b: 127, a: 1 });
    expect(t.colors['board.background']).toEqual({ r: 0, g: 16, b: 35, a: 1 });
    expect(t.colors['board.f_silks']).toEqual({ r: 242, g: 237, b: 161, a: 1 });
    expect(t.colors['board.edge_cuts']).toEqual({ r: 208, g: 210, b: 205, a: 1 });
    expect(t.colors['board.via_hole']).toEqual({ r: 227, g: 183, b: 46, a: 1 });
    expect(t.colors['schematic.wire']).toEqual({ r: 0, g: 150, b: 0, a: 1 });
    expect(t.colors['schematic.background']).toEqual({ r: 245, g: 244, b: 239, a: 1 });
    // alpha survives the CSS round trip with 8-bit quantisation
    expect(t.colors['board.f_mask']?.a).toBeCloseTo(0.4, 2);
    expect(t.colors['board.ratsnest']?.a).toBeCloseTo(0.35, 2);
  });

  test('KiCad Classic uses the legacy palette (BGR table decoded correctly)', () => {
    const t = KICAD_CLASSIC_THEME;
    expect(t.name).toBe('KiCad Classic');
    expect(t.colors['board.copper.f']).toEqual({ r: 132, g: 0, b: 0, a: 1 }); // RED
    expect(t.colors['board.copper.b']).toEqual({ r: 0, g: 132, b: 0, a: 1 }); // GREEN
    expect(t.colors['board.edge_cuts']).toEqual({ r: 194, g: 194, b: 0, a: 1 }); // YELLOW
    expect(t.colors['board.copper.in1']).toEqual({ r: 194, g: 194, b: 0, a: 1 });
    expect(t.colors['schematic.wire']).toEqual({ r: 0, g: 132, b: 0, a: 1 });
    // missing keys fall back to the default theme
    expect(t.colors['schematic.page_limits']).toEqual(KICAD_DEFAULT_THEME.colors['schematic.page_limits']!);
  });

  test('every board layer key has a colour in the default theme', () => {
    const t = KICAD_DEFAULT_THEME;
    for (let i = 1; i <= 30; i++) expect(t.colors[`board.copper.in${i}`]).toBeDefined();
    for (let i = 1; i <= 45; i++) expect(t.colors[`board.user_${i}`]).toBeDefined();
    for (let i = 0; i < 64; i++) expect(t.colors[`gerbview.layers.${i}`]).toBeDefined();
    expect(t.colors['3d_viewer.user_9']).toEqual(t.colors['board.user_9']!);
    expect(BUILTIN_THEMES.length).toBe(2);
  });
});

describe('layer -> theme key mapping', () => {
  test('BoardLayer names map to color_settings.cpp keys', () => {
    expect(boardLayerThemeKey('BL_F_Cu')).toBe('board.copper.f');
    expect(boardLayerThemeKey('BL_B_Cu')).toBe('board.copper.b');
    expect(boardLayerThemeKey('BL_In12_Cu')).toBe('board.copper.in12');
    expect(boardLayerThemeKey('BL_F_SilkS')).toBe('board.f_silks');
    expect(boardLayerThemeKey('BL_Edge_Cuts')).toBe('board.edge_cuts');
    expect(boardLayerThemeKey('BL_Dwgs_User')).toBe('board.dwgs_user');
    expect(boardLayerThemeKey('BL_User_17')).toBe('board.user_17');
    expect(boardLayerThemeKey('board.via_hole')).toBe('board.via_hole');
    expect(boardLayerThemeKey('BL_Rescue')).toBeUndefined();
  });

  test('layerColor resolves inner layers and falls back to looping colours', () => {
    expect(layerColor(KICAD_DEFAULT_THEME, 'BL_F_Cu')).toEqual({ r: 200, g: 52, b: 52, a: 1 });
    expect(layerColor(KICAD_DEFAULT_THEME, 'BL_In3_Cu')).toEqual({ r: 79, g: 203, b: 203, a: 1 });
    const bare = themeFromJson({ meta: { name: 'bare' }, board: { copper: { f: 'rgb(1, 2, 3)' } } });
    expect(themeColor(bare, 'board.copper.f')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    // missing keys use the built-in default, not white
    expect(themeColor(bare, 'board.copper.in2')).toEqual(KICAD_DEFAULT_THEME.colors['board.copper.in2']!);
    expect(themeColor(bare, 'totally.unknown')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
});

describe('user theme loading', () => {
  test('parses KiCad user JSON layout and merges over defaults', () => {
    const json = {
      meta: { name: 'My Theme', version: 6 },
      board: { copper: { f: '#ff0000', b: 'rgba(0, 0, 255, 0.5)' }, background: 'rgb(10, 10, 10)' },
      schematic: { override_item_colors: true, wire: 'rgb(1, 1, 1)' },
    };
    const t = loadUserTheme(json);
    expect(t.name).toBe('My Theme');
    expect(t.overrideSchItemColors).toBe(true);
    expect(t.colors['board.copper.f']).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(t.colors['board.copper.b']).toEqual({ r: 0, g: 0, b: 255, a: 0.5 });
    expect(t.colors['schematic.wire']).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(t.colors['board.f_silks']).toEqual(KICAD_DEFAULT_THEME.colors['board.f_silks']!);
    // JSON string input works too
    expect(loadUserTheme(JSON.stringify(json)).colors['board.background']).toEqual({ r: 10, g: 10, b: 10, a: 1 });
  });

  test('themeToJson writes KiCad layout', () => {
    const out = themeToJson(KICAD_DEFAULT_THEME) as { board: { copper: { f: string } }; meta: { name: string } };
    expect(out.board.copper.f).toBe('rgb(200, 52, 52)');
    expect(out.meta.name).toBe('KiCad Default');
  });

  test('uiColors resolves overlay colours', () => {
    const ui = uiColors(KICAD_DEFAULT_THEME);
    expect(ui.background).toEqual({ r: 0, g: 16, b: 35, a: 1 });
    expect(ui.selection).toEqual({ r: 4, g: 255, b: 67, a: 1 });
    expect(uiColors(KICAD_DEFAULT_THEME, 'schematic').background).toEqual({ r: 245, g: 244, b: 239, a: 1 });
  });
});
