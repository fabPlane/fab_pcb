/**
 * Hand-written schematic items in protobuf-es message shape (camelCase, bigint nm, numeric
 * enums, `{ case, value }` oneofs), the way @kicad-web/client hands them to the renderer.
 * Symbol definition children are decoded messages (`$typeName`), as the client's
 * `unpackAny` produces; pin positions follow the API convention (absolute sheet coordinates)
 * unless `pinsRelative` is set.
 */
import type { StoredItemLike } from '../src/core/host.js';
import { MemoryStore, a, d, id, v } from './fixtures.js';

export { MemoryStore };
export const MM = 1_000_000;
/** KiCad's 50 mil schematic grid in mm */
export const G = 1.27;

const textAttrs = (sizeMm = 1.27, extra: Record<string, unknown> = {}) => ({
  size: v(sizeMm, sizeMm),
  strokeWidth: d(0),
  angle: a(0),
  horizontalAlignment: 1,
  verticalAlignment: 3,
  visible: true,
  ...extra,
});

export function field(name: string, text: string, xMm: number, yMm: number, visible = true, extra: Record<string, unknown> = {}) {
  return {
    $typeName: 'kiapi.schematic.types.SchematicField',
    name,
    visible,
    showName: false,
    text: { position: v(xMm, yMm), text, attributes: textAttrs(1.27, { horizontalAlignment: 1, verticalAlignment: 2, ...extra }) },
  };
}

export const rectShape = (x0: number, y0: number, x1: number, y1: number, widthMm = 0.254, fillType = 4) => ({
  $typeName: 'kiapi.schematic.types.SchematicGraphicShape',
  id: id(`shape-${x0}-${y0}`),
  shape: { attributes: { stroke: { width: d(widthMm), style: 1 }, fill: { fillType } }, geometry: { case: 'rectangle' as const, value: { topLeft: v(x0, y0), bottomRight: v(x1, y1) } } },
});

export const circleShape = (cx: number, cy: number, r: number, widthMm = 0.254, fillType = 1) => ({
  $typeName: 'kiapi.schematic.types.SchematicGraphicShape',
  id: id(`circle-${cx}-${cy}`),
  shape: { attributes: { stroke: { width: d(widthMm), style: 1 }, fill: { fillType } }, geometry: { case: 'circle' as const, value: { center: v(cx, cy), radiusPoint: v(cx + r, cy) } } },
});

export interface PinSpec {
  number: string;
  name?: string;
  /** library position (mm) */
  x: number;
  y: number;
  /** SPO_RIGHT = 1, SPO_LEFT = 2, SPO_UP = 3, SPO_DOWN = 4 */
  orientation: number;
  lengthMm?: number;
  /** SPS_* (1 = line, 2 = inverted, 3 = clock, ...) */
  shape?: number;
  electricalType?: number;
  visible?: boolean;
}

export function pin(kiid: string, p: PinSpec, xMm: number, yMm: number) {
  return {
    $typeName: 'kiapi.schematic.types.SchematicPin',
    id: id(kiid),
    name: p.name ?? '~',
    number: p.number,
    position: v(xMm, yMm),
    length: d(p.lengthMm ?? 2.54),
    orientation: p.orientation,
    electricalType: p.electricalType ?? 5,
    shape: p.shape ?? 1,
    visible: p.visible ?? true,
    nameTextSize: d(1.27),
    numberTextSize: d(1.27),
  };
}

/** Sheet position of a library point under a symbol transform, written out per KiCad orientation (independent of the renderer's code). */
export function kicadTransformPoint(x: number, y: number, orientation: number, mirrorX: boolean, mirrorY: boolean): [number, number] {
  let px = x;
  let py = y;
  // SYM_ORIENT_90 = one counter-clockwise rotation on screen: (x, y) -> (y, -x)
  const rot = orientation === 2 ? 1 : orientation === 3 ? 2 : orientation === 4 ? 3 : 0;
  for (let i = 0; i < rot; i++) [px, py] = [py, -px];
  if (mirrorX) py = -py;
  if (mirrorY) px = -px;
  return [px, py];
}

export interface SymbolOpts {
  /** SSO_0 = 1, SSO_90 = 2, SSO_180 = 3, SSO_270 = 4 */
  orientation?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  dnp?: boolean;
  unit?: number;
  /** keep pin positions in library coordinates (adapter option symbolPinsAbsolute: false) */
  pinsRelative?: boolean;
  showPinNames?: boolean;
  showPinNumbers?: boolean;
  pinNameOffsetMm?: number;
  /** SST_GLOBAL_POWER = 2 */
  type?: number;
}

/** A generic symbol instance: body shapes + pins (library coordinates) + reference / value fields. */
export function symbol(kiid: string, ref: string, value: string, xMm: number, yMm: number, shapes: unknown[], pins: PinSpec[], opts: SymbolOpts = {}): StoredItemLike {
  const orientation = opts.orientation ?? 1;
  const pinItems = pins.map((p, i) => {
    const [tx, ty] = opts.pinsRelative ? [p.x, p.y] : kicadTransformPoint(p.x, p.y, orientation, !!opts.mirrorX, !!opts.mirrorY);
    return { item: pin(`${kiid}-pin${i + 1}`, p, opts.pinsRelative ? tx : xMm + tx, opts.pinsRelative ? ty : yMm + ty), unit: { unit: 0 }, bodyStyle: { style: 0 }, isPrivate: false };
  });
  return {
    id: kiid,
    type: 'KOT_SCH_SYMBOL',
    proto: {
      $typeName: 'kiapi.schematic.types.SchematicSymbolInstance',
      id: id(kiid),
      position: v(xMm, yMm),
      transform: { orientation, mirrorX: !!opts.mirrorX, mirrorY: !!opts.mirrorY },
      unit: { unit: opts.unit ?? 1 },
      showPinNames: opts.showPinNames ?? true,
      showPinNumbers: opts.showPinNumbers ?? true,
      pinNameOffset: d(opts.pinNameOffsetMm ?? 0),
      attributes: { doNotPopulate: !!opts.dnp, excludeFromSimulation: false },
      referenceField: field('Reference', ref, xMm + 2.54, yMm - 1.27),
      valueField: field('Value', value, xMm + 2.54, yMm + 1.27),
      footprintField: field('Footprint', 'Resistor_SMD:R_0603', xMm, yMm, false),
      datasheetField: field('Datasheet', '~', xMm, yMm, false),
      descriptionField: field('Description', 'Resistor', xMm, yMm, false),
      userFields: [],
      definition: {
        $typeName: 'kiapi.schematic.types.SchematicSymbol',
        id: { libraryNickname: 'Device', entryName: value },
        type: opts.type ?? 1,
        unitCount: 1,
        items: [...shapes.map((s) => ({ item: s, unit: { unit: 0 }, bodyStyle: { style: 0 }, isPrivate: false })), ...pinItems],
      },
    },
  };
}

/** Device:R — a 2-pin resistor: body rect (-1.016,-2.54)..(1.016,2.54), pin 1 above pointing down, pin 2 below pointing up. */
export function resistor(kiid: string, ref: string, xMm: number, yMm: number, opts: SymbolOpts = {}): StoredItemLike {
  return symbol(
    kiid,
    ref,
    '10k',
    xMm,
    yMm,
    [rectShape(-1.016, -2.54, 1.016, 2.54)],
    [
      { number: '1', x: 0, y: -3.81, orientation: 4, lengthMm: 1.27 },
      { number: '2', x: 0, y: 3.81, orientation: 3, lengthMm: 1.27 },
    ],
    opts,
  );
}

/** A 4-pin IC-ish symbol with named pins (names inside the body), inverted / clock decorations. */
export function ic(kiid: string, ref: string, xMm: number, yMm: number, opts: SymbolOpts = {}): StoredItemLike {
  return symbol(
    kiid,
    ref,
    'IC',
    xMm,
    yMm,
    [rectShape(-5.08, -5.08, 5.08, 5.08)],
    [
      { number: '1', name: 'IN', x: -7.62, y: -2.54, orientation: 1, electricalType: 1 },
      { number: '2', name: 'CLK', x: -7.62, y: 2.54, orientation: 1, shape: 3, electricalType: 1 },
      { number: '3', name: '~{OUT}', x: 7.62, y: -2.54, orientation: 2, shape: 2, electricalType: 2 },
      { number: '4', name: 'GND', x: 0, y: 7.62, orientation: 3, electricalType: 8 },
    ],
    { pinNameOffsetMm: 0.508, ...opts },
  );
}

const strokeOf = (widthMm: number, style = 1, color?: { r: number; g: number; b: number; a: number }) => ({ width: d(widthMm), style, ...(color ? { color } : {}) });

export function wire(kiid: string, ax: number, ay: number, bx: number, by: number, opts: { widthMm?: number; bus?: boolean; graphic?: boolean; color?: { r: number; g: number; b: number; a: number }; style?: number } = {}): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_SCH_LINE',
    proto: {
      $typeName: 'kiapi.schematic.types.SchematicLine',
      id: id(kiid),
      start: v(ax, ay),
      end: v(bx, by),
      type: opts.bus ? 2 : opts.graphic ? 3 : 1,
      stroke: strokeOf(opts.widthMm ?? 0, opts.style ?? 1, opts.color),
      locked: 1,
    },
  };
}

export function junction(kiid: string, x: number, y: number, diameterMm = 0): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_JUNCTION', proto: { $typeName: 'kiapi.schematic.types.Junction', id: id(kiid), position: v(x, y), diameter: d(diameterMm) } };
}

export function noConnect(kiid: string, x: number, y: number): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_NO_CONNECT', proto: { $typeName: 'kiapi.schematic.types.NoConnectMarker', id: id(kiid), position: v(x, y), size: d(0) } };
}

export function busEntry(kiid: string, x: number, y: number, busToBus = false, sizeMm = 2.54): StoredItemLike {
  return {
    id: kiid,
    type: busToBus ? 'KOT_SCH_BUS_BUS_ENTRY' : 'KOT_SCH_BUS_WIRE_ENTRY',
    proto: { $typeName: 'kiapi.schematic.types.BusEntry', id: id(kiid), position: v(x, y), size: v(sizeMm, sizeMm), stroke: strokeOf(0), type: busToBus ? 2 : 1 },
  };
}

/** SLSS_LEFT = 1, SLSS_UP = 2, SLSS_RIGHT = 3, SLSS_BOTTOM = 4 */
export type Spin = 1 | 2 | 3 | 4;

function labelText(text: string, x: number, y: number, spin: Spin, sizeMm: number, valign: number) {
  const vertical = spin === 2 || spin === 4;
  const right = spin === 1 || spin === 4;
  return { position: v(x, y), text, attributes: textAttrs(sizeMm, { angle: a(vertical ? 90 : 0), horizontalAlignment: right ? 3 : 1, verticalAlignment: valign }) };
}

export function localLabel(kiid: string, x: number, y: number, text: string, spin: Spin = 3, sizeMm = 1.27): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_LABEL', proto: { $typeName: 'kiapi.schematic.types.LocalLabel', id: id(kiid), position: v(x, y), text: labelText(text, x, y, spin, sizeMm, 3), spinStyle: spin, fields: [] } };
}

/** SLSH_INPUT = 1, OUTPUT = 2, BIDI = 3, TRISTATE = 4, PASSIVE = 5 */
export function globalLabel(kiid: string, x: number, y: number, text: string, shape = 1, spin: Spin = 3, sizeMm = 1.27): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_GLOBAL_LABEL', proto: { $typeName: 'kiapi.schematic.types.GlobalLabel', id: id(kiid), position: v(x, y), text: labelText(text, x, y, spin, sizeMm, 2), spinStyle: spin, shape, fields: [] } };
}

export function hierLabel(kiid: string, x: number, y: number, text: string, shape = 1, spin: Spin = 3, sizeMm = 1.27): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_HIER_LABEL', proto: { $typeName: 'kiapi.schematic.types.HierarchicalLabel', id: id(kiid), position: v(x, y), text: labelText(text, x, y, spin, sizeMm, 2), spinStyle: spin, shape, fields: [] } };
}

/**
 * SLSH_DOT = 6, CIRCLE = 7, DIAMOND = 8, RECTANGLE = 9. Spin RIGHT (3) is what eeschema gives a
 * freshly placed directive label: the flag rises above the anchor, the field to its right.
 */
export function directiveLabel(kiid: string, x: number, y: number, shape = 7, spin: Spin = 3, netclass = 'Power'): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_SCH_DIRECTIVE_LABEL',
    proto: {
      $typeName: 'kiapi.schematic.types.DirectiveLabel',
      id: id(kiid),
      position: v(x, y),
      text: labelText('', x, y, spin, 1.27, 2),
      spinStyle: spin,
      shape,
      pinLength: d(2.54),
      symbolSize: d(0.508),
      fields: [field('Netclass', netclass, x + 1, y - 3, true, { horizontalAlignment: 1 })],
    },
  };
}

export interface SheetPinSpec {
  name: string;
  /** SHS_LEFT = 1, RIGHT = 2, TOP = 3, BOTTOM = 4 */
  side: number;
  shape?: number;
  /** offset along the side, mm */
  at: number;
}

export function sheet(kiid: string, x: number, y: number, w: number, h: number, name: string, file: string, pins: SheetPinSpec[]): StoredItemLike {
  const sideSpin: Record<number, Spin> = { 1: 3, 2: 1, 3: 4, 4: 2 };
  return {
    id: kiid,
    type: 'KOT_SCH_SHEET',
    proto: {
      $typeName: 'kiapi.schematic.types.SheetSymbol',
      id: id(kiid),
      position: v(x, y),
      size: v(w, h),
      borderStroke: strokeOf(0),
      fill: { fillType: 1 },
      nameField: field('Sheetname', name, x, y - 0.5, true, { verticalAlignment: 3 }),
      filenameField: field('Sheetfile', file, x, y + h + 0.5, true, { verticalAlignment: 1 }),
      userFields: [],
      pins: pins.map((p, i) => {
        const px = p.side === 1 ? x : p.side === 2 ? x + w : x + p.at;
        const py = p.side === 3 ? y : p.side === 4 ? y + h : y + p.at;
        return {
          $typeName: 'kiapi.schematic.types.SheetPin',
          id: id(`${kiid}-pin${i + 1}`),
          position: v(px, py),
          text: labelText(p.name, px, py, sideSpin[p.side]!, 1.27, 2),
          spinStyle: sideSpin[p.side],
          shape: p.shape ?? 1,
          side: p.side,
        };
      }),
      dnp: false,
    },
  };
}

export function schText(kiid: string, x: number, y: number, text: string, sizeMm = 1.27, extra: Record<string, unknown> = {}): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_TEXT', proto: { $typeName: 'kiapi.schematic.types.SchematicText', id: id(kiid), text: { position: v(x, y), text, attributes: textAttrs(sizeMm, extra) } } };
}

export function textBox(kiid: string, x0: number, y0: number, x1: number, y1: number, text: string): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_SCH_TEXTBOX',
    proto: {
      $typeName: 'kiapi.schematic.types.SchematicTextBox',
      id: id(kiid),
      textbox: { topLeft: v(x0, y0), bottomRight: v(x1, y1), text, attributes: textAttrs(1.27, { horizontalAlignment: 1, verticalAlignment: 1 }), borderEnabled: true },
      graphicAttributes: { stroke: strokeOf(0), fill: { fillType: 3, color: { r: 1, g: 1, b: 0.8, a: 1 } } },
      marginLeft: d(0.5),
      marginTop: d(0.5),
      marginRight: d(0.5),
      marginBottom: d(0.5),
    },
  };
}

export function schShape(kiid: string, shape: unknown): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_SHAPE', proto: { ...(shape as Record<string, unknown>), id: id(kiid) } };
}

/** A 300 x 100 px PNG header (enough for imageInfo); the pixel data is never decoded headless. */
export function pngHeader(): Uint8Array {
  const png = new Uint8Array(32);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0x64]);
  return png;
}

export function schImage(kiid: string, x: number, y: number, scale = 1, imageData: Uint8Array = pngHeader()): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_BITMAP', proto: { $typeName: 'kiapi.schematic.types.SchematicImage', id: id(kiid), position: v(x, y), imageScale: { value: scale }, imageData } };
}

export function group(kiid: string, name: string, members: string[]): StoredItemLike {
  return { id: kiid, type: 'KOT_SCH_GROUP', proto: { $typeName: 'kiapi.schematic.types.Group', id: id(kiid), name, items: members.map((m) => id(m)) } };
}

export function ruleArea(kiid: string, pts: Array<[number, number]>): StoredItemLike {
  return {
    id: kiid,
    type: 'KOT_SCH_RULE_AREA',
    proto: {
      $typeName: 'kiapi.schematic.types.SchematicRuleArea',
      id: id(kiid),
      shape: { attributes: { stroke: strokeOf(0), fill: { fillType: 1 } }, geometry: { case: 'polygon', value: { polygons: [{ outline: { nodes: pts.map(([px, py]) => ({ geometry: { case: 'point', value: v(px, py) } })), closed: true }, holes: [] }] } } },
    },
  };
}

/** A small synthetic sheet: symbols in several orientations, wires, labels of every kind, a bus, a sub-sheet. */
export function syntheticSchematic(): StoredItemLike[] {
  const items: StoredItemLike[] = [
    resistor('R1', 'R1', 50.8, 50.8),
    resistor('R2', 'R2', 63.5, 50.8, { orientation: 2 }),
    resistor('R3', 'R3', 76.2, 50.8, { orientation: 3, mirrorX: true }),
    resistor('R4', 'R4', 88.9, 50.8, { orientation: 4, mirrorY: true, dnp: true }),
    ic('U1', 'U1', 63.5, 76.2),
    ic('U2', 'U2', 88.9, 76.2, { orientation: 2 }),
    wire('w1', 50.8, 46.99, 50.8, 43.18),
    wire('w2', 50.8, 43.18, 63.5, 43.18),
    wire('w3', 50.8, 54.61, 50.8, 60.96),
    wire('w4', 40.64, 43.18, 50.8, 43.18),
    wire('w5', 55.88, 78.74, 50.8, 78.74),
    junction('j1', 50.8, 43.18),
    localLabel('lbl1', 40.64, 43.18, 'NET_A', 3),
    localLabel('lbl2', 50.8, 60.96, 'DOWN', 4),
    globalLabel('gl-in', 30.48, 30.48, 'IN', 1, 1),
    globalLabel('gl-out', 30.48, 33.02, 'OUT', 2, 1),
    globalLabel('gl-bidi', 30.48, 35.56, 'BIDI', 3, 1),
    globalLabel('gl-tri', 30.48, 38.1, 'TRI', 4, 1),
    globalLabel('gl-pas', 30.48, 40.64, 'PASSIVE', 5, 1),
    globalLabel('gl-up', 111.76, 60.96, 'VBUS', 1, 2),
    hierLabel('hl-in', 30.48, 55.88, 'H_IN', 1, 3),
    hierLabel('hl-out', 30.48, 58.42, 'H_OUT', 2, 3),
    hierLabel('hl-bidi', 30.48, 60.96, 'H_BIDI', 3, 3),
    hierLabel('hl-tri', 30.48, 63.5, 'H_TRI', 4, 3),
    hierLabel('hl-pas', 30.48, 66.04, 'H_PAS', 5, 3),
    directiveLabel('dl-circle', 111.76, 43.18, 7, 3, 'Power'),
    directiveLabel('dl-dot', 121.92, 43.18, 6, 3, 'Fast'),
    directiveLabel('dl-diamond', 132.08, 43.18, 8, 3, 'Clock'),
    directiveLabel('dl-rect', 142.24, 43.18, 9, 3, 'HV'),
    sheet('sheet1', 111.76, 76.2, 25.4, 20.32, 'Power', 'power.kicad_sch', [
      { name: 'VIN', side: 1, at: 5.08, shape: 1 },
      { name: 'VOUT', side: 2, at: 5.08, shape: 2 },
    ]),
    wire('bus1', 101.6, 25.4, 101.6, 60.96, { bus: true }),
    wire('bw1', 96.52, 30.48, 91.44, 30.48),
    busEntry('be1', 99.06, 33.02, false, -2.54),
    busEntry('be2', 101.6, 60.96, true),
    wire('bw2', 99.06, 33.02, 91.44, 33.02),
    noConnect('nc1', 55.88, 73.66),
    schText('t1', 30.48, 20.32, 'kicad-web schematic demo\nsecond line', 2.54),
    textBox('tb1', 91.44, 15.24, 127, 22.86, 'Text box with a\nyellow background'),
    schShape('s1', circleShape(40.64, 90, 3, 0.254, 1)),
    schShape('s2', rectShape(45, 85, 55, 95, 0.254, 5)),
    wire('gl1', 30.48, 100, 60, 100, { graphic: true, style: 3 }),
    ruleArea('ra1', [
      [58.42, 68.58],
      [70, 68.58],
      [70, 86],
      [58.42, 86],
    ]),
  ];
  return items;
}

/** A second (child) sheet's contents, for exercising SchematicCanvasHost.setStore. */
export function syntheticSubSheet(): StoredItemLike[] {
  return [
    resistor('SR1', 'R10', 25.4, 25.4),
    resistor('SR2', 'R11', 25.4, 38.1, { orientation: 2 }),
    wire('sw1', 25.4, 29.21, 25.4, 34.29),
    hierLabel('shl-in', 12.7, 21.59, 'VIN', 1, 1),
    hierLabel('shl-out', 38.1, 38.1, 'VOUT', 2, 3),
    wire('sw2', 12.7, 21.59, 25.4, 21.59),
    wire('sw3', 29.21, 38.1, 38.1, 38.1),
    schText('st1', 12.7, 12.7, 'Sub sheet: power'),
  ];
}
