// Enum option tables for the schema-driven properties panel. The generated proto
// package will supply these from descriptors; until then the subsets the mock uses.

export const BOARD_LAYERS = [
  'BL_F_Cu',
  'BL_In1_Cu',
  'BL_In2_Cu',
  'BL_B_Cu',
  'BL_F_Adhes',
  'BL_B_Adhes',
  'BL_F_Paste',
  'BL_B_Paste',
  'BL_F_SilkS',
  'BL_B_SilkS',
  'BL_F_Mask',
  'BL_B_Mask',
  'BL_Dwgs_User',
  'BL_Cmts_User',
  'BL_Eco1_User',
  'BL_Eco2_User',
  'BL_Edge_Cuts',
  'BL_Margin',
  'BL_F_CrtYd',
  'BL_B_CrtYd',
  'BL_F_Fab',
  'BL_B_Fab',
] as const;

export type BoardLayerId = (typeof BOARD_LAYERS)[number];

export const LAYER_DISPLAY_NAMES: Record<string, string> = {
  BL_F_Cu: 'F.Cu',
  BL_In1_Cu: 'In1.Cu',
  BL_In2_Cu: 'In2.Cu',
  BL_B_Cu: 'B.Cu',
  BL_F_Adhes: 'F.Adhesive',
  BL_B_Adhes: 'B.Adhesive',
  BL_F_Paste: 'F.Paste',
  BL_B_Paste: 'B.Paste',
  BL_F_SilkS: 'F.Silkscreen',
  BL_B_SilkS: 'B.Silkscreen',
  BL_F_Mask: 'F.Mask',
  BL_B_Mask: 'B.Mask',
  BL_Dwgs_User: 'User.Drawings',
  BL_Cmts_User: 'User.Comments',
  BL_Eco1_User: 'User.Eco1',
  BL_Eco2_User: 'User.Eco2',
  BL_Edge_Cuts: 'Edge.Cuts',
  BL_Margin: 'Margin',
  BL_F_CrtYd: 'F.Courtyard',
  BL_B_CrtYd: 'B.Courtyard',
  BL_F_Fab: 'F.Fab',
  BL_B_Fab: 'B.Fab',
};

export function layerDisplayName(id: string): string {
  return LAYER_DISPLAY_NAMES[id] ?? id.replace(/^BL_/, '').replace(/_/g, '.');
}

export function isCopperLayer(id: string): boolean {
  return id.endsWith('_Cu');
}

/** Enum name prefix -> allowed values. Keys are the proto enum prefixes. */
export const ENUM_OPTIONS: Record<string, readonly string[]> = {
  BL: BOARD_LAYERS,
  LS: ['LS_UNLOCKED', 'LS_LOCKED'],
  SLT: ['SLT_WIRE', 'SLT_BUS', 'SLT_GRAPHIC'],
  SLSH: ['SLSH_INPUT', 'SLSH_OUTPUT', 'SLSH_BIDI', 'SLSH_TRISTATE', 'SLSH_PASSIVE', 'SLSH_DOT', 'SLSH_CIRCLE', 'SLSH_DIAMOND', 'SLSH_RECTANGLE'],
  SSO: ['SSO_0', 'SSO_90', 'SSO_180', 'SSO_270'],
  SST: ['SST_NORMAL', 'SST_GLOBAL_POWER', 'SST_LOCAL_POWER'],
  PT: ['PT_PTH', 'PT_SMD', 'PT_EDGE_CONNECTOR', 'PT_NPTH'],
  PSS: ['PSS_CIRCLE', 'PSS_RECTANGLE', 'PSS_OVAL', 'PSS_TRAPEZOID', 'PSS_ROUNDRECT', 'PSS_CHAMFEREDRECT', 'PSS_CUSTOM'],
  ZT: ['ZT_COPPER', 'ZT_GRAPHICAL', 'ZT_RULE_AREA', 'ZT_TEARDROP'],
  ZCS: ['ZCS_INHERITED', 'ZCS_NONE', 'ZCS_THERMAL', 'ZCS_FULL', 'ZCS_PTH_THERMAL'],
  ZFM: ['ZFM_SOLID', 'ZFM_HATCHED'],
  VT: ['VT_THROUGH', 'VT_BLIND_BURIED', 'VT_MICRO'],
  SLS: ['SLS_DEFAULT', 'SLS_SOLID', 'SLS_DASH', 'SLS_DOT', 'SLS_DASHDOT', 'SLS_DASHDOTDOT'],
  LES: ['LES_NONE', 'LES_ARROW', 'LES_CIRCLE', 'LES_SQUARE', 'LES_ARROW_OPEN'],
  EPT: [
    'EPT_INPUT',
    'EPT_OUTPUT',
    'EPT_BIDIRECTIONAL',
    'EPT_TRISTATE',
    'EPT_PASSIVE',
    'EPT_FREE',
    'EPT_UNSPECIFIED',
    'EPT_POWER_IN',
    'EPT_POWER_OUT',
    'EPT_OPEN_COLLECTOR',
    'EPT_OPEN_EMITTER',
    'EPT_NO_CONNECT',
  ],
  FMS: ['FMS_THROUGH_HOLE', 'FMS_SMD', 'FMS_UNSPECIFIED'],
  HJ: ['HJ_LEFT', 'HJ_CENTER', 'HJ_RIGHT'],
  VJ: ['VJ_TOP', 'VJ_CENTER', 'VJ_BOTTOM'],
};

export function enumOptionsFor(value: string): readonly string[] | null {
  const m = /^([A-Z]{2,5})_/.exec(value);
  if (!m) return null;
  return ENUM_OPTIONS[m[1]!] ?? null;
}

export function enumLabel(value: string): string {
  const idx = value.indexOf('_');
  const body = idx >= 0 ? value.slice(idx + 1) : value;
  return body
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
