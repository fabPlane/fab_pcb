/**
 * Hand-written board items in protobuf-es message shape (camelCase, bigint nm, numeric
 * enums, `{ case, value }` oneofs) — exactly what @fp-pcb/client will hand the renderer.
 */
import { BOARD_LAYER_ENUM } from '../src/board/boardLayers.js';
import type { StoredItemLike } from '../src/core/host.js';

export const MM = 1_000_000;
const L = BOARD_LAYER_ENUM;

export const v = (xMm: number, yMm: number) => ({ xNm: BigInt(Math.round(xMm * MM)), yNm: BigInt(Math.round(yMm * MM)) });
export const d = (mm: number) => ({ valueNm: BigInt(Math.round(mm * MM)) });
export const a = (deg: number) => ({ valueDegrees: deg });
export const id = (s: string) => ({ value: s });

export const point = (xMm: number, yMm: number) => ({ geometry: { case: 'point' as const, value: v(xMm, yMm) } });
export const polyline = (pts: Array<[number, number]>) => ({ nodes: pts.map(([x, y]) => point(x, y)), closed: true });

export function track(kiid: string, ax: number, ay: number, bx: number, by: number, widthMm = 0.25, layer = L.BL_F_Cu!, net = 'GND'): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_PCB_TRACE',
    layer: 'BL_F_Cu',
    net,
    proto: {
      $typeName: 'kiapi.board.types.Track',
      id: id(kiid),
      start: v(ax, ay),
      end: v(bx, by),
      width: d(widthMm),
      layer,
      net: { code: { value: 1 }, name: net },
      locked: 1,
    },
  };
}

export function via(kiid: string, x: number, y: number, sizeMm = 0.8, drillMm = 0.4, net = 'GND'): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_PCB_VIA',
    proto: {
      $typeName: 'kiapi.board.types.Via',
      id: id(kiid),
      position: v(x, y),
      net: { code: { value: 1 }, name: net },
      type: 1, // VT_THROUGH
      padStack: {
        type: 1, // PST_NORMAL
        layers: [L.BL_F_Cu, L.BL_B_Cu],
        drill: { startLayer: L.BL_F_Cu, endLayer: L.BL_B_Cu, diameter: v(drillMm, drillMm), shape: 1 },
        copperLayers: [{ layer: L.BL_F_Cu, shape: 1, size: v(sizeMm, sizeMm) }],
        angle: a(0),
      },
    },
  };
}

export function pad(kiid: string, number: string, x: number, y: number, w: number, h: number, opts: { shape?: number; smd?: boolean; angle?: number; drill?: number; net?: string; roundRatio?: number } = {}) {
  const shape = opts.shape ?? 2; // PSS_RECTANGLE
  const smd = opts.smd ?? true;
  return {
    $typeName: 'kiapi.board.types.Pad',
    id: id(kiid),
    number,
    net: opts.net ? { code: { value: 2 }, name: opts.net } : undefined,
    type: smd ? 2 : 1,
    position: v(x, y),
    padStack: {
      type: 1,
      layers: smd ? [L.BL_F_Cu, L.BL_F_Mask, L.BL_F_Paste] : [L.BL_F_Cu, L.BL_B_Cu, L.BL_F_Mask, L.BL_B_Mask],
      drill: smd ? undefined : { diameter: v(opts.drill ?? 0.8, opts.drill ?? 0.8), shape: 1 },
      copperLayers: [{ layer: L.BL_F_Cu, shape, size: v(w, h), cornerRoundingRatio: opts.roundRatio ?? 0.25, offset: v(0, 0) }],
      angle: a(opts.angle ?? 0),
    },
  };
}

export function fpShape(kiid: string, layer: number, geometry: Record<string, unknown>, widthMm = 0.12, filled = false) {
  return {
    $typeName: 'kiapi.board.types.BoardGraphicShape',
    id: id(kiid),
    layer,
    shape: { attributes: { stroke: { width: d(widthMm), style: 2 }, fill: { fillType: filled ? 2 : 1 } }, geometry },
  };
}

export const seg = (ax: number, ay: number, bx: number, by: number) => ({ case: 'segment' as const, value: { start: v(ax, ay), end: v(bx, by) } });
export const rect = (x0: number, y0: number, x1: number, y1: number, r = 0) => ({ case: 'rectangle' as const, value: { topLeft: v(x0, y0), bottomRight: v(x1, y1), cornerRadius: d(r) } });
export const circle = (cx: number, cy: number, r: number) => ({ case: 'circle' as const, value: { center: v(cx, cy), radiusPoint: v(cx + r, cy) } });
export const arc = (sx: number, sy: number, mx: number, my: number, ex: number, ey: number) => ({ case: 'arc' as const, value: { start: v(sx, sy), mid: v(mx, my), end: v(ex, ey) } });

/** 0603-ish two-pad footprint at (x, y) rotated by `rot`, children in absolute coordinates (API semantics). */
export function footprint(kiid: string, ref: string, x: number, y: number, rot = 0, back = false): StoredItemLike {
  const layer = back ? L.BL_B_Cu! : L.BL_F_Cu!;
  const rad = (rot * Math.PI) / 180;
  const rp = (dx: number, dy: number): [number, number] => [x + dx * Math.cos(rad) + dy * Math.sin(rad), y + dy * Math.cos(rad) - dx * Math.sin(rad)];
  const [p1x, p1y] = rp(-0.8, 0);
  const [p2x, p2y] = rp(0.8, 0);
  const [c0x, c0y] = rp(-1.5, -0.8);
  const [c1x, c1y] = rp(1.5, 0.8);
  return {
    id: kiid,
    type: 'KOT_PCB_FOOTPRINT',
    layer: back ? 'BL_B_Cu' : 'BL_F_Cu',
    proto: {
      $typeName: 'kiapi.board.types.FootprintInstance',
      id: id(kiid),
      position: v(x, y),
      orientation: a(rot),
      layer,
      referenceField: {
        name: 'Reference',
        visible: true,
        text: { id: id(`${kiid}-ref`), layer: back ? L.BL_B_SilkS : L.BL_F_SilkS, text: { position: v(x, y - 1.5), text: ref, attributes: { size: v(1, 1), strokeWidth: d(0.15), angle: a(rot), horizontalAlignment: 2, verticalAlignment: 2, visible: true } } },
      },
      valueField: { name: 'Value', visible: false, text: { id: id(`${kiid}-val`), layer: L.BL_F_Fab, text: { position: v(x, y + 1.5), text: '10k' } } },
      definition: {
        id: { libraryNickname: 'Resistor_SMD', entryName: 'R_0603' },
        items: [
          pad(`${kiid}-p1`, '1', p1x, p1y, 0.9, 0.95, { angle: rot, net: 'GND', shape: 5 }),
          pad(`${kiid}-p2`, '2', p2x, p2y, 0.9, 0.95, { angle: rot, net: 'VCC', shape: 5 }),
          fpShape(`${kiid}-crtyd`, back ? L.BL_B_CrtYd! : L.BL_F_CrtYd!, rect(c0x, c0y, c1x, c1y), 0.05),
          fpShape(`${kiid}-silk`, back ? L.BL_B_SilkS! : L.BL_F_SilkS!, seg(...rp(-0.3, -0.7), ...rp(0.3, -0.7))),
        ],
      },
    },
  };
}

export function zone(kiid: string, layers: number[], outline: Array<[number, number]>, hole?: Array<[number, number]>, fill = true, net = 'GND', ruleArea = false): StoredItemLike {
  const poly = { outline: polyline(outline), holes: hole ? [polyline(hole)] : [] };
  return {
    id: kiid,
    type: 'KOT_PCB_ZONE',
    net,
    proto: {
      $typeName: 'kiapi.board.types.Zone',
      id: id(kiid),
      type: ruleArea ? 3 : 1,
      layers,
      outline: { polygons: [poly] },
      name: kiid,
      settings: ruleArea ? { case: 'ruleAreaSettings', value: { keepoutCopper: true } } : { case: 'copperSettings', value: { net: { code: { value: 1 }, name: net } } },
      filled: fill,
      filledPolygons: fill && !ruleArea ? layers.map((layer) => ({ layer, shapes: { polygons: [poly] } })) : [],
      border: { style: 3, pitch: d(0.5) },
    },
  };
}

export function graphic(kiid: string, layer: number, geometry: Record<string, unknown>, widthMm = 0.1, filled = false): StoredItemLike {
  return { id: kiid, type: 'KOT_PCB_SHAPE', proto: fpShape(kiid, layer, geometry, widthMm, filled) };
}

export function text(kiid: string, layer: number, x: number, y: number, str: string, sizeMm = 1.5): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_PCB_TEXT',
    proto: {
      $typeName: 'kiapi.board.types.BoardText',
      id: id(kiid),
      layer,
      text: { position: v(x, y), text: str, attributes: { size: v(sizeMm, sizeMm), strokeWidth: d(sizeMm * 0.15), angle: a(0), horizontalAlignment: 1, verticalAlignment: 3, visible: true } },
    },
  };
}

/**
 * `kiapi.board.types.Dimension`. `resolvedText` is the string KiCad plots (field 26, since
 * 11.0): `text.text` holds the bare measurement, and an empty `resolvedText` means the
 * dimension plots no text at all. Leave it undefined for an older server.
 */
export function dimension(
  kiid: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  heightMm: number,
  layer = L.BL_Dwgs_User!,
  opts: { resolvedText?: string; style?: { case: string; value: Record<string, unknown> }; inward?: boolean } = {},
): StoredItemLike {
  const proto: Record<string, unknown> = {
    $typeName: 'kiapi.board.types.Dimension',
    id: id(kiid),
    layer,
    text: { position: v((ax + bx) / 2, (ay + by) / 2 + heightMm - 1), text: '10.00', attributes: { size: v(1, 1), strokeWidth: d(0.15), horizontalAlignment: 2, verticalAlignment: 2 } },
    dimensionStyle: opts.style ?? { case: 'aligned', value: { start: v(ax, ay), end: v(bx, by), height: d(heightMm), extensionHeight: d(0.5) } },
    lineThickness: d(0.15),
    arrowLength: d(1.27),
    extensionOffset: d(0.5),
    arrowDirection: opts.inward ? 1 : 2,
  };
  if (opts.resolvedText !== undefined) proto.resolvedText = opts.resolvedText;
  return { id: kiid, type: 'KOT_PCB_DIMENSION', proto };
}

/** A `PolySet` of axis-aligned mm rectangles, as `knockout_shapes` / `Barcode.shapes` carry. */
export const polySet = (rects: Array<[number, number, number, number]>) => ({
  polygons: rects.map(([x0, y0, x1, y1]) => ({
    outline: polyline([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]),
    holes: [],
  })),
});

/** A small synthetic board: outline, two footprints, tracks, a via, a zone with a hole, text, a dimension. */
export function syntheticBoard(): StoredItemLike[] {
  const L = BOARD_LAYER_ENUM;
  return [
    graphic('edge-1', L.BL_Edge_Cuts!, rect(0, 0, 40, 30, 1), 0.05),
    footprint('fp-r1', 'R1', 10, 10, 0),
    footprint('fp-r2', 'R2', 20, 12, 90),
    footprint('fp-r3', 'R3', 30, 20, 45, true),
    track('t1', 10.8, 10, 19.2, 10, 0.3),
    track('t2', 19.2, 10, 20, 10.8, 0.3),
    track('t3', 20, 13.5, 20, 20, 0.5, L.BL_B_Cu!, 'VCC'),
    via('v1', 20, 20, 0.8, 0.4),
    zone('z1', [L.BL_B_Cu!], [[2, 2], [38, 2], [38, 28], [2, 28]], [[15, 15], [25, 15], [25, 25], [15, 25]]),
    zone('ra1', [L.BL_F_Cu!], [[32, 3], [38, 3], [38, 8], [32, 8]], undefined, false, '', true),
    text('txt-1', L.BL_F_SilkS!, 3, 28, 'fp-pcb demo', 1.5),
    dimension('dim-1', 0, 0, 40, 0, -3),
    graphic('arc-1', L.BL_Cmts_User!, arc(30, 26, 33, 23, 36, 26), 0.15),
    graphic('circ-1', L.BL_F_Fab!, circle(5, 25, 1.5), 0.1),
  ];
}

/** Minimal ItemStore-shaped object over an array. */
export class MemoryStore {
  readonly kind: string;
  readonly document = {};
  revision = 0;
  private items = new Map<string, StoredItemLike>();
  private subs = new Set<(d: { added: StoredItemLike[]; updated: StoredItemLike[]; removed: string[]; revision: number }) => void>();
  constructor(items: StoredItemLike[] = [], kind: 'board' | 'schematic' | 'footprint' = 'board') {
    this.kind = kind;
    for (const it of items) this.items.set(it.id, it);
  }
  get(id: string) {
    return this.items.get(id);
  }
  all() {
    return this.items.values();
  }
  byType(type: string) {
    return [...this.items.values()].filter((i) => i.type === type);
  }
  byLayer(layer: string) {
    return [...this.items.values()].filter((i) => i.layer === layer);
  }
  byNet(net: string) {
    return [...this.items.values()].filter((i) => i.net === net);
  }
  subscribe(cb: (d: { added: StoredItemLike[]; updated: StoredItemLike[]; removed: string[]; revision: number }) => void) {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }
  apply(diff: { added?: StoredItemLike[]; updated?: StoredItemLike[]; removed?: string[] }) {
    for (const it of diff.added ?? []) this.items.set(it.id, it);
    for (const it of diff.updated ?? []) this.items.set(it.id, it);
    for (const id of diff.removed ?? []) this.items.delete(id);
    this.revision++;
    const d = { added: diff.added ?? [], updated: diff.updated ?? [], removed: diff.removed ?? [], revision: this.revision };
    for (const cb of this.subs) cb(d);
  }
}

/** `kiapi.board.types.Barcode`. `shapes` is the encoded symbol KiCad >= 11.0 sends along. */
export function barcode(
  kiid: string,
  x: number,
  y: number,
  wMm: number,
  hMm: number,
  opts: { angle?: number; modules?: Array<[number, number, number, number]>; layer?: number } = {},
): StoredItemLike {
  const proto: Record<string, unknown> = {
    $typeName: 'kiapi.board.types.Barcode',
    id: id(kiid),
    text: 'kicad',
    kind: 4, // BK_QR_CODE
    position: v(x, y),
    orientation: a(opts.angle ?? 0),
    layer: opts.layer ?? L.BL_F_SilkS!,
    width: d(wMm),
    height: d(hMm),
  };
  if (opts.modules) {
    proto.shapes = {
      polygons: opts.modules.map(([x0, y0, x1, y1]) => ({
        outline: polyline([
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ]),
        holes: [],
      })),
    };
  }
  return { id: kiid, type: 'KOT_PCB_BARCODE', proto };
}

/** `kiapi.board.types.BoardTextBox`. `angle` turns the text (and with it the box corners). */
export function textBox(
  kiid: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  str: string,
  opts: { angle?: number; border?: boolean; strokeMm?: number; style?: number; layer?: number } = {},
): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_PCB_TEXTBOX',
    proto: {
      $typeName: 'kiapi.board.types.BoardTextBox',
      id: id(kiid),
      layer: opts.layer ?? L.BL_F_SilkS!,
      borderStroke: { width: d(opts.strokeMm ?? 0.15), style: opts.style ?? 2 },
      textbox: {
        topLeft: v(x0, y0),
        bottomRight: v(x1, y1),
        text: str,
        borderEnabled: opts.border ?? true,
        marginLeft: d(0.5),
        marginTop: d(0.5),
        marginRight: d(0.5),
        marginBottom: d(0.5),
        attributes: { size: v(1, 1), strokeWidth: d(0.15), angle: a(opts.angle ?? 0), horizontalAlignment: 1, verticalAlignment: 1, visible: true },
      },
    },
  };
}

/** A one-row table of `cells` text boxes, laid out left to right between y0 and y1. */
export function table(kiid: string, x0: number, y0: number, cellW: number, y1: number, cells: string[]): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_PCB_TABLE',
    proto: {
      $typeName: 'kiapi.board.types.Table',
      id: id(kiid),
      layer: L.BL_Dwgs_User!,
      columnCount: cells.length,
      externalBorder: 2, // TSM_ENABLED
      headerSeparator: 1, // TSM_DISABLED
      rowSeparators: 1,
      columnSeparators: 2,
      borderStroke: { width: d(0.15), style: 3 }, // SLS_DASH
      separatorsStroke: { width: d(0.1), style: 2 }, // SLS_SOLID
      cells: cells.map((str, i) => ({
        columnSpan: 1,
        rowSpan: 1,
        textBox: (textBox(`${kiid}-c${i}`, x0 + i * cellW, y0, x0 + (i + 1) * cellW, y1, str).proto as Record<string, unknown>),
      })),
    },
  };
}
