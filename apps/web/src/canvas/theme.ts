// KiCad default colour theme (resources/colors/... "KiCad Default"), light and dark
// variants for the canvas. The renderer will ship the full JSON; this subset covers the
// layers the mock uses and the UI swatches in the layer panel.

import type { Theme } from '@/contracts';

const BOARD_LAYER_COLOURS: Record<string, string> = {
  BL_F_Cu: '#c83434',
  BL_In1_Cu: '#c2c200',
  BL_In2_Cu: '#c200c2',
  BL_In3_Cu: '#c20000',
  BL_In4_Cu: '#00c2c2',
  BL_B_Cu: '#4d7fc4',
  BL_F_Adhes: '#a900a9',
  BL_B_Adhes: '#0000a9',
  BL_F_Paste: '#a8a8a8',
  BL_B_Paste: '#00b7b7',
  BL_F_SilkS: '#f2eda2',
  BL_B_SilkS: '#e8b2a7',
  BL_F_Mask: '#d3a4a4',
  BL_B_Mask: '#8f6b7c',
  BL_Dwgs_User: '#c2c2c2',
  BL_Cmts_User: '#0000d0',
  BL_Eco1_User: '#008500',
  BL_Eco2_User: '#c2c200',
  BL_Edge_Cuts: '#d0d2cd',
  BL_Margin: '#ff26e2',
  BL_F_CrtYd: '#ff26e2',
  BL_B_CrtYd: '#26e9ff',
  BL_F_Fab: '#afafaf',
  BL_B_Fab: '#585d84',
  // schematic pseudo-layers
  SLT_WIRE: '#00a000',
  SLT_BUS: '#0000c0',
  SLT_GRAPHIC: '#0000c0',
};

export const DARK_THEME: Theme = {
  name: 'KiCad Default (dark)',
  layers: BOARD_LAYER_COLOURS,
  ui: {
    background: '#001023',
    grid: '#848484',
    cursor: '#ffffff',
    selection: '#ffffff',
    hover: '#ffd21f',
    highlight: '#ffbf00',
    ratsnest: '#a8b3d8',
    text: '#e5e5e5',
    pinName: '#00a0a0',
    wire: '#00a000',
    bus: '#0000c0',
    label: '#000000',
    symbolBody: '#ffffc2',
    symbolOutline: '#800000',
    sheet: '#800080',
  },
};

export const LIGHT_THEME: Theme = {
  name: 'KiCad Classic (light)',
  layers: {
    ...BOARD_LAYER_COLOURS,
    BL_F_Cu: '#c83434',
    BL_B_Cu: '#3f68b0',
    BL_F_SilkS: '#8a8240',
    BL_Edge_Cuts: '#3a3a3a',
    BL_F_Fab: '#6f6f6f',
    BL_F_CrtYd: '#c218a8',
  },
  ui: {
    background: '#ffffff',
    grid: '#c8c8c8',
    cursor: '#000000',
    selection: '#0058c8',
    hover: '#c86400',
    highlight: '#e8a000',
    ratsnest: '#7080a0',
    text: '#202020',
    pinName: '#007070',
    wire: '#00a000',
    bus: '#0000c0',
    label: '#000000',
    symbolBody: '#ffffc2',
    symbolOutline: '#800000',
    sheet: '#800080',
  },
};

export function themeFor(mode: 'light' | 'dark'): Theme {
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME;
}

export function layerColour(theme: Theme, layer: string | undefined): string {
  return (layer && theme.layers[layer]) || theme.ui.text;
}
