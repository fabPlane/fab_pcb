/**
 * kiapi BoardLayer enum (api/proto/board/board_types.proto), copper/technical layer
 * classification, theme keys and the pcbnew draw order (pcbnew/pcb_draw_panel_gal.cpp
 * GAL_LAYER_ORDER + PCB_DRAW_PANEL_GAL::SetTopLayer).
 */
import { boardLayerThemeKey } from '../core/theme.js';

/** BoardLayer enum values (name -> number), verbatim from board_types.proto. */
export const BOARD_LAYER_ENUM: Readonly<Record<string, number>> = Object.freeze({
  BL_UNKNOWN: 0,
  BL_UNDEFINED: 1,
  BL_UNSELECTED: 2,
  BL_F_Cu: 3,
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`BL_In${i + 1}_Cu`, 4 + i])),
  BL_B_Cu: 34,
  BL_B_Adhes: 35,
  BL_F_Adhes: 36,
  BL_B_Paste: 37,
  BL_F_Paste: 38,
  BL_B_SilkS: 39,
  BL_F_SilkS: 40,
  BL_B_Mask: 41,
  BL_F_Mask: 42,
  BL_Dwgs_User: 43,
  BL_Cmts_User: 44,
  BL_Eco1_User: 45,
  BL_Eco2_User: 46,
  BL_Edge_Cuts: 47,
  BL_Margin: 48,
  BL_B_CrtYd: 49,
  BL_F_CrtYd: 50,
  BL_B_Fab: 51,
  BL_F_Fab: 52,
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`BL_User_${i + 1}`, 53 + i])),
  BL_Rescue: 62,
  ...Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`BL_User_${i + 10}`, 63 + i])),
});

const ENUM_TO_NAME: string[] = [];
for (const [k, v] of Object.entries(BOARD_LAYER_ENUM)) ENUM_TO_NAME[v] = k;

/** Normalise a layer given as enum number, enum name, or KiCad short name (F.Cu / F_Cu). */
export function boardLayerName(v: number | string | bigint | undefined | null): string {
  if (v === undefined || v === null) return 'BL_UNKNOWN';
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number') return ENUM_TO_NAME[v] ?? 'BL_UNKNOWN';
  if (v.startsWith('BL_')) return v;
  const norm = `BL_${v.replace(/\./g, '_')}`;
  return norm in BOARD_LAYER_ENUM ? norm : v;
}

export const boardLayerEnum = (name: string): number => BOARD_LAYER_ENUM[boardLayerName(name)] ?? 0;

export const isCopperLayer = (l: string): boolean => /^BL_(F_Cu|B_Cu|In\d+_Cu)$/.test(l);
export const isInnerCopper = (l: string): boolean => /^BL_In\d+_Cu$/.test(l);
export const isFrontLayer = (l: string): boolean => /^BL_F_/.test(l);
export const isBackLayer = (l: string): boolean => /^BL_B_/.test(l);
export const isUserLayer = (l: string): boolean => /^BL_(User_\d+|Dwgs_User|Cmts_User|Eco1_User|Eco2_User|Edge_Cuts|Margin)$/.test(l);

/** F_x <-> B_x; other layers unchanged. */
export function flipLayer(l: string): string {
  if (l.startsWith('BL_F_')) return `BL_B_${l.slice(5)}`;
  if (l.startsWith('BL_B_')) return `BL_F_${l.slice(5)}`;
  return l;
}

/** Copper layers of an n-layer board, front to back: F_Cu, In1..In(n-2), B_Cu. */
export function copperLayerList(copperCount = 2): string[] {
  const n = Math.max(2, Math.min(32, copperCount));
  const out = ['BL_F_Cu'];
  for (let i = 1; i <= n - 2; i++) out.push(`BL_In${i}_Cu`);
  out.push('BL_B_Cu');
  return out;
}

export const ALL_COPPER_LAYERS: readonly string[] = copperLayerList(32);

/** Theme key for a board layer (`BL_F_Cu` -> `board.copper.f`). */
export const layerThemeKey = (l: string): string | undefined => boardLayerThemeKey(l);

/** Pseudo-layers the board adapter emits besides BoardLayer names (keys are theme keys). */
export const PSEUDO_LAYERS = Object.freeze({
  viaHole: 'board.via_hole',
  viaHoleWalls: 'board.via_hole_walls',
  padPlatedHole: 'board.pad_plated_hole',
  padHoleWalls: 'board.pad_plated_hole', // KiCad shares the plated-hole colour for hole walls
  nonPlatedHole: 'board.plated_hole',
  anchor: 'board.anchor',
  auxItems: 'board.aux_items',
  points: 'board.points',
  gridItems: 'board.grid_items',
  ratsnest: 'board.ratsnest',
  drcError: 'board.drc_error',
  drcWarning: 'board.drc_warning',
  drcExclusion: 'board.drc_exclusion',
  /** pad numbers (coloured like `board.pad_net_names`; KiCad has no separate key) */
  padNumbers: 'board.pad_numbers',
  padNetNames: 'board.pad_net_names',
  trackNetNames: 'board.track_net_names',
  viaNetNames: 'board.via_net_names',
});

/** Zoom-gated label layers emitted with `BoardAdapterContext.labels` (see BoardCanvasHost.setLabelOptions). */
export const LABEL_LAYERS: readonly string[] = Object.freeze([PSEUDO_LAYERS.padNumbers, PSEUDO_LAYERS.padNetNames, PSEUDO_LAYERS.trackNetNames, PSEUDO_LAYERS.viaNetNames]);

const FRONT_TECH = ['BL_F_Cu', 'BL_F_Mask', 'BL_F_SilkS', 'BL_F_Paste', 'BL_F_Adhes', 'BL_F_CrtYd', 'BL_F_Fab'];
const BACK_TECH = ['BL_B_Cu', 'BL_B_Mask', 'BL_B_SilkS', 'BL_B_Paste', 'BL_B_Adhes', 'BL_B_CrtYd', 'BL_B_Fab'];
const USER_TOP = ['BL_Dwgs_User', 'BL_Cmts_User', 'BL_Eco1_User', 'BL_Eco2_User', 'BL_Edge_Cuts', 'BL_Margin', ...Array.from({ length: 45 }, (_, i) => `BL_User_${i + 1}`)];
const HOLES = [PSEUDO_LAYERS.viaHole, PSEUDO_LAYERS.viaHoleWalls, PSEUDO_LAYERS.padPlatedHole, PSEUDO_LAYERS.nonPlatedHole];
const ALWAYS_TOP = [
  PSEUDO_LAYERS.trackNetNames,
  PSEUDO_LAYERS.viaNetNames,
  PSEUDO_LAYERS.padNetNames,
  PSEUDO_LAYERS.padNumbers,
  PSEUDO_LAYERS.gridItems,
  PSEUDO_LAYERS.ratsnest,
  PSEUDO_LAYERS.anchor,
  PSEUDO_LAYERS.points,
  PSEUDO_LAYERS.auxItems,
  PSEUDO_LAYERS.drcExclusion,
  PSEUDO_LAYERS.drcWarning,
  PSEUDO_LAYERS.drcError,
];

export interface DrawOrderOptions {
  /** copper layers of the board, front to back (default 2-layer) */
  copperLayers?: readonly string[];
  /** currently active layer; brought to the front like pcbnew's SetTopLayer */
  activeLayer?: string;
  /** view from the back: back side on top, inner layers reversed */
  flipped?: boolean;
}

/**
 * Draw order, bottom-most first. Mirrors GAL_LAYER_ORDER (reversed) for a front view:
 *   B tech < B_Cu < In30..In1 < F_Cu < F tech < holes < user/drawing layers < markers.
 * The active layer (and, for front/back layers, the whole board side) is moved just below the
 * hole and user layers, as pcbnew does.
 */
export function boardDrawOrder(opts: DrawOrderOptions = {}): string[] {
  const copper = [...(opts.copperLayers ?? copperLayerList(2))];
  const inner = copper.filter(isInnerCopper);
  const flipped = !!opts.flipped;

  const frontGroup = [...FRONT_TECH];
  const backGroup = [...BACK_TECH];
  const innerTopFirst = flipped ? [...inner].reverse() : inner; // draw order wants nearest-viewer last

  // bottom -> top for a front view: back tech (reversed so B_Cu is above B_Fab), B_Cu, inner (In30..In1), F_Cu, F tech
  let stack: string[];
  if (!flipped) {
    stack = [...[...backGroup].reverse(), ...[...innerTopFirst].reverse(), ...frontGroup];
  } else {
    stack = [...[...frontGroup].reverse(), ...[...innerTopFirst].reverse(), ...backGroup];
  }

  // active layer handling (PCB_DRAW_PANEL_GAL::SetTopLayer)
  const active = opts.activeLayer;
  if (active && isCopperLayer(active)) {
    // the whole board side (or the single inner layer) goes above the copper/tech stack, keeping its own order
    const raise = isFrontLayer(active) ? frontGroup : isBackLayer(active) ? backGroup : [active];
    stack = [...stack.filter((l) => !raise.includes(l)), ...raise];
  } else if (active && (isFrontLayer(active) || isBackLayer(active))) {
    const raise = (isFrontLayer(active) ? frontGroup : backGroup).filter((l) => l !== active);
    stack = [...stack.filter((l) => !raise.includes(l) && l !== active), ...raise];
  }

  const user = [...USER_TOP].reverse(); // Dwgs_User is drawn last (topmost)
  const order = [...stack, ...HOLES, ...user, ...ALWAYS_TOP];
  if (active && !isCopperLayer(active)) {
    // non-copper active layer: just below the overlays / markers, above every drawing layer
    const rest = order.filter((l) => l !== active);
    const idx = rest.indexOf(PSEUDO_LAYERS.gridItems);
    rest.splice(idx < 0 ? rest.length : idx, 0, active);
    return dedupe(rest);
  }
  return dedupe(order);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of list) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

/** Human-readable KiCad layer name (`F.Cu`, `In1.Cu`, `B.SilkS`). */
export function boardLayerDisplayName(l: string): string {
  return l.replace(/^BL_/, '').replace(/_/g, '.');
}
