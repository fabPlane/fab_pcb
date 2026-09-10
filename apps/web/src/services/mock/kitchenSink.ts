// Mock project modelled on qa/data/*/api_kitchen_sink.* — a handful of items shaped like
// the kiapi messages (camelCase, {valueNm} distances, {valueDegrees} angles, enums as
// strings). Enough for every panel to have something real to show.

import type { StoredItem } from '@/contracts';
import { mockKiid } from '@/lib/id';
import { mm } from '@/lib/units';
import { MemoryItemStore } from '../MemoryItemStore';
import type { SheetInfo } from '../types';

export interface Vec2 {
  xNm: number;
  yNm: number;
}

export const v = (xMm: number, yMm: number): Vec2 => ({ xNm: mm(xMm), yNm: mm(yMm) });
export const d = (valueMm: number) => ({ valueNm: mm(valueMm) });
export const deg = (valueDegrees: number) => ({ valueDegrees });
export const kiid = (value: string) => ({ value });

const textAttrs = (sizeMm = 1, strokeMm = 0.15) => ({
  fontName: '',
  horizontalAlignment: 'HA_CENTER',
  verticalAlignment: 'VA_CENTER',
  angle: deg(0),
  lineSpacing: 1,
  strokeWidth: d(strokeMm),
  italic: false,
  bold: false,
  underlined: false,
  visible: true,
  mirrored: false,
  multiline: false,
  keepUpright: true,
  size: v(sizeMm, sizeMm),
});

const box = (x: number, y: number, w: number, h: number) => ({ x: mm(x), y: mm(y), w: mm(w), h: mm(h) });

// ---------------------------------------------------------------------------- board

export interface BoardFixture {
  store: MemoryItemStore;
  ids: Record<string, string>;
}

export function buildBoard(): BoardFixture {
  const store = new MemoryItemStore('board', { boardFilename: 'api_kitchen_sink.kicad_pcb' }, 'board');
  const ids: Record<string, string> = {};
  const items: StoredItem[] = [];

  const edge = (id: string, ax: number, ay: number, bx: number, by: number) =>
    items.push({
      id,
      type: 'KOT_PCB_SHAPE',
      layer: 'BL_Edge_Cuts',
      bbox: box(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax) || 0.1, Math.abs(by - ay) || 0.1),
      proto: {
        id: kiid(id),
        shape: {
          segment: { start: v(ax, ay), end: v(bx, by) },
          attributes: { stroke: { width: d(0.1), style: 'SLS_SOLID' }, fill: { fillType: 'GFT_UNFILLED' } },
        },
        layer: 'BL_Edge_Cuts',
        locked: 'LS_UNLOCKED',
      },
    });
  // 60 x 40 mm outline
  edge(mockKiid('edge1'), 0, 0, 60, 0);
  edge(mockKiid('edge2'), 60, 0, 60, 40);
  edge(mockKiid('edge3'), 60, 40, 0, 40);
  edge(mockKiid('edge4'), 0, 40, 0, 0);

  const footprint = (ref: string, value: string, lib: string, name: string, x: number, y: number, rot: number, layer: 'BL_F_Cu' | 'BL_B_Cu', bodyW: number, bodyH: number, description: string) => {
    const id = mockKiid(ref);
    ids[ref] = id;
    items.push({
      id,
      type: 'KOT_PCB_FOOTPRINT',
      layer,
      bbox: box(x - bodyW / 2, y - bodyH / 2, bodyW, bodyH),
      proto: {
        id: kiid(id),
        position: v(x, y),
        orientation: deg(rot),
        layer,
        locked: 'LS_UNLOCKED',
        definition: {
          id: { libraryNickname: lib, entryName: name },
          anchor: v(0, 0),
          attributes: {
            description,
            keywords: '',
            notInSchematic: false,
            excludeFromPositionFiles: false,
            excludeFromBillOfMaterials: false,
            doNotPopulate: false,
            mountingStyle: layer === 'BL_F_Cu' && lib.endsWith('SMD') ? 'FMS_SMD' : 'FMS_THROUGH_HOLE',
            allowSoldermaskBridges: false,
          },
        },
        referenceField: {
          id: { id: 0 },
          name: 'Reference',
          text: { position: v(x, y - bodyH / 2 - 1), attributes: textAttrs(1, 0.15), text: ref, layer: 'BL_F_SilkS' },
          visible: true,
        },
        valueField: {
          id: { id: 1 },
          name: 'Value',
          text: { position: v(x, y + bodyH / 2 + 1), attributes: textAttrs(1, 0.15), text: value, layer: 'BL_F_Fab' },
          visible: true,
        },
        datasheetField: { id: { id: 2 }, name: 'Datasheet', text: { text: '' }, visible: false },
        descriptionField: { id: { id: 3 }, name: 'Description', text: { text: description }, visible: false },
        attributes: {
          description,
          keywords: '',
          notInSchematic: false,
          excludeFromPositionFiles: false,
          excludeFromBillOfMaterials: false,
          doNotPopulate: false,
          mountingStyle: lib.endsWith('SMD') ? 'FMS_SMD' : 'FMS_THROUGH_HOLE',
          allowSoldermaskBridges: false,
          excludeFromSimulation: false,
        },
        overrides: {
          solderMask: { solderMaskMargin: d(0), exposeCopper: false },
          solderPaste: { solderPasteMargin: d(0), solderPasteMarginRatio: { value: 0 } },
          copperClearance: d(0),
          zoneConnection: 'ZCS_INHERITED',
        },
        symbolPath: { path: [], pathHumanReadable: '/' },
        symbolSheetName: 'Root',
        symbolSheetFilename: 'api_kitchen_sink.kicad_sch',
        variants: [],
      },
    });
    return id;
  };

  const pad = (
    parent: string,
    parentRef: string,
    number: string,
    x: number,
    y: number,
    w: number,
    h: number,
    net: string | undefined,
    smd: boolean,
    layer: 'BL_F_Cu' | 'BL_B_Cu' = 'BL_F_Cu',
    shape = smd ? 'PSS_ROUNDRECT' : 'PSS_CIRCLE',
  ) => {
    const id = mockKiid(`${parentRef}p${number}`);
    ids[`${parentRef}.${number}`] = id;
    const layers = smd ? (layer === 'BL_F_Cu' ? ['BL_F_Cu', 'BL_F_Paste', 'BL_F_Mask'] : ['BL_B_Cu', 'BL_B_Paste', 'BL_B_Mask']) : ['BL_F_Cu', 'BL_B_Cu', 'BL_F_Mask', 'BL_B_Mask'];
    items.push({
      id,
      type: 'KOT_PCB_PAD',
      layer,
      net,
      parent,
      bbox: box(x - w / 2, y - h / 2, w, h),
      proto: {
        id: kiid(id),
        locked: 'LS_UNLOCKED',
        number,
        net: net ? { code: { value: 0 }, name: net } : undefined,
        type: smd ? 'PT_SMD' : 'PT_PTH',
        padStack: {
          type: smd ? 'PST_NORMAL' : 'PST_THROUGH',
          layers,
          copperLayers: [
            {
              layer: 'BL_F_Cu',
              shape,
              size: v(w, h),
              cornerRoundingRatio: shape === 'PSS_ROUNDRECT' ? 0.25 : 0,
              chamferRatio: 0,
              offset: v(0, 0),
              zoneSettings: { zoneConnection: 'ZCS_INHERITED', thermalSpokes: { width: d(0.5), angle: deg(90), gap: d(0.5) } },
            },
          ],
          drill: smd ? undefined : { startLayer: 'BL_F_Cu', endLayer: 'BL_B_Cu', diameter: v(0.8, 0.8) },
          angle: deg(0),
        },
        position: v(x, y),
        copperClearanceOverride: d(0),
        padToDieLength: d(0),
        parent: kiid(parent),
        pinFunction: '',
      },
    });
    return id;
  };

  // R1 0603 at (12, 10), pads on F.Cu
  const r1 = footprint('R1', '10k', 'Resistor_SMD', 'R_0603_1608Metric', 12, 10, 0, 'BL_F_Cu', 1.6, 0.8, 'Resistor SMD 0603 (1608 Metric)');
  pad(r1, 'R1', '1', 12 - 0.7875, 10, 0.9, 0.95, 'VCC', true);
  pad(r1, 'R1', '2', 12 + 0.7875, 10, 0.9, 0.95, 'SIG', true);

  // C1 0603 at (12, 20)
  const c1 = footprint('C1', '100nF', 'Capacitor_SMD', 'C_0603_1608Metric', 12, 20, 90, 'BL_F_Cu', 1.6, 0.8, 'Capacitor SMD 0603 (1608 Metric)');
  pad(c1, 'C1', '1', 12, 20 - 0.775, 0.9, 0.95, 'SIG', true);
  pad(c1, 'C1', '2', 12, 20 + 0.775, 0.9, 0.95, 'GND', true);

  // U1 SOIC-8 at (30, 15)
  const u1 = footprint('U1', 'ATtiny85-20SU', 'Package_SO', 'SOIC-8_5.3x5.3mm_P1.27mm', 30, 15, 0, 'BL_F_Cu', 5.3, 5.3, 'SOIC, 8 Pin, 1.27 mm pitch');
  const u1Nets = ['SIG', 'PB4', 'PB3', 'GND', 'PB0', 'PB1', 'PB2', 'VCC'];
  for (let i = 0; i < 4; i++) {
    pad(u1, 'U1', String(i + 1), 30 - 3.6, 15 - 1.905 + i * 1.27, 1.55, 0.6, u1Nets[i], true);
    pad(u1, 'U1', String(8 - i), 30 + 3.6, 15 - 1.905 + i * 1.27, 1.55, 0.6, u1Nets[7 - i], true);
  }

  // J1 pin header 1x04 at (50, 8..15.62) PTH
  const j1 = footprint(
    'J1',
    'Conn_01x04',
    'Connector_PinHeader_2.54mm',
    'PinHeader_1x04_P2.54mm_Vertical',
    50,
    11.81,
    0,
    'BL_F_Cu',
    2.54,
    10.16,
    'Through hole straight pin header, 1x04, 2.54mm pitch',
  );
  const j1Nets = ['VCC', 'GND', 'SIG', 'PB0'];
  for (let i = 0; i < 4; i++) pad(j1, 'J1', String(i + 1), 50, 8 + i * 2.54, 1.7, 1.7, j1Nets[i], false, 'BL_F_Cu', i === 0 ? 'PSS_RECTANGLE' : 'PSS_CIRCLE');

  // Tracks
  const track = (tag: string, ax: number, ay: number, bx: number, by: number, w: number, layer: string, net: string) => {
    const id = mockKiid(tag);
    ids[tag] = id;
    items.push({
      id,
      type: 'KOT_PCB_TRACE',
      layer,
      net,
      bbox: box(Math.min(ax, bx) - w / 2, Math.min(ay, by) - w / 2, Math.abs(bx - ax) + w, Math.abs(by - ay) + w),
      proto: {
        id: kiid(id),
        start: v(ax, ay),
        end: v(bx, by),
        width: d(w),
        locked: 'LS_UNLOCKED',
        layer,
        net: { code: { value: 0 }, name: net },
        customProperties: [],
      },
    });
    return id;
  };
  track('t1', 12.7875, 10, 16, 10, 0.25, 'BL_F_Cu', 'SIG');
  track('t2', 16, 10, 19.095, 13.095, 0.25, 'BL_F_Cu', 'SIG');
  track('t3', 19.095, 13.095, 26.4, 13.095, 0.25, 'BL_F_Cu', 'SIG');
  track('t4', 12, 19.225, 12, 16, 0.25, 'BL_F_Cu', 'SIG');
  track('t5', 12, 16, 16, 12, 0.25, 'BL_F_Cu', 'SIG');
  track('t6', 11.2125, 10, 8, 10, 0.4, 'BL_F_Cu', 'VCC');
  track('t7', 8, 10, 8, 4, 0.4, 'BL_F_Cu', 'VCC');
  track('t8', 8, 4, 50, 4, 0.4, 'BL_B_Cu', 'VCC');
  track('t9', 50, 4, 50, 8, 0.4, 'BL_B_Cu', 'VCC');
  track('t10', 33.6, 16.905, 40, 16.905, 0.25, 'BL_F_Cu', 'PB0');
  track('t11', 40, 16.905, 50, 15.62, 0.25, 'BL_F_Cu', 'PB0');
  track('t12', 33.6, 15.635, 45, 15.635, 0.25, 'BL_F_Cu', 'PB1');
  track('t13', 45, 15.635, 45, 30, 0.25, 'BL_F_Cu', 'PB1');

  const via = (tag: string, x: number, y: number, net: string, dia = 0.8, drill = 0.4) => {
    const id = mockKiid(tag);
    ids[tag] = id;
    items.push({
      id,
      type: 'KOT_PCB_VIA',
      layer: 'BL_F_Cu',
      net,
      bbox: box(x - dia / 2, y - dia / 2, dia, dia),
      proto: {
        id: kiid(id),
        position: v(x, y),
        padStack: {
          type: 'PST_THROUGH',
          layers: ['BL_F_Cu', 'BL_B_Cu'],
          copperLayers: [{ layer: 'BL_F_Cu', shape: 'PSS_CIRCLE', size: v(dia, dia), offset: v(0, 0) }],
          drill: { startLayer: 'BL_F_Cu', endLayer: 'BL_B_Cu', diameter: v(drill, drill) },
          angle: deg(0),
        },
        locked: 'LS_UNLOCKED',
        net: { code: { value: 0 }, name: net },
        type: 'VT_THROUGH',
        isFree: false,
      },
    });
  };
  via('via1', 8, 4, 'VCC');
  via('via2', 50, 4, 'VCC');
  via('via3', 45, 30, 'PB1');

  // GND zone on B.Cu
  const zoneId = mockKiid('zoneGND');
  ids.zoneGND = zoneId;
  const outline = [v(1, 1), v(59, 1), v(59, 39), v(1, 39)];
  items.push({
    id: zoneId,
    type: 'KOT_PCB_ZONE',
    layer: 'BL_B_Cu',
    net: 'GND',
    bbox: box(1, 1, 58, 38),
    proto: {
      id: kiid(zoneId),
      type: 'ZT_COPPER',
      layers: ['BL_B_Cu'],
      outline: { polygons: [{ outline: { nodes: outline.map((p) => ({ point: p })), closed: true }, holes: [] }] },
      name: 'GND pour',
      copperSettings: {
        connection: { zoneConnection: 'ZCS_THERMAL', thermalSpokes: { width: d(0.5), angle: deg(90), gap: d(0.5) } },
        clearance: d(0.5),
        minThickness: d(0.25),
        islandMode: 'IRM_ALWAYS',
        minIslandArea: 0,
        fillMode: 'ZFM_SOLID',
        hatchSettings: { thickness: d(1), gap: d(1.5), orientation: deg(0), hatchSmoothingRatio: 0.1, hatchHoleMinAreaRatio: 0.3 },
        net: { code: { value: 0 }, name: 'GND' },
        cornerRadius: d(0),
      },
      priority: 0,
      filled: true,
      filledPolygons: [],
      border: { style: 'ZBS_DIAGONAL_EDGE', pitch: d(0.5) },
      locked: 'LS_UNLOCKED',
    },
  });

  // Silkscreen text
  const textId = mockKiid('title');
  ids.title = textId;
  items.push({
    id: textId,
    type: 'KOT_PCB_TEXT',
    layer: 'BL_F_SilkS',
    bbox: box(20, 33, 20, 2),
    proto: {
      id: kiid(textId),
      text: { position: v(30, 34), attributes: textAttrs(1.5, 0.2), text: 'KICAD WEB KITCHEN SINK', layer: 'BL_F_SilkS' },
      layer: 'BL_F_SilkS',
      knockout: false,
      locked: 'LS_UNLOCKED',
    },
  });

  // A courtyard rectangle on F.CrtYd for U1
  const cyId = mockKiid('u1crtyd');
  items.push({
    id: cyId,
    type: 'KOT_PCB_SHAPE',
    layer: 'BL_F_CrtYd',
    parent: u1,
    bbox: box(30 - 4.7, 15 - 2.9, 9.4, 5.8),
    proto: {
      id: kiid(cyId),
      shape: {
        rectangle: { topLeft: v(30 - 4.7, 15 - 2.9), bottomRight: v(30 + 4.7, 15 + 2.9), cornerRadius: d(0) },
        attributes: { stroke: { width: d(0.05), style: 'SLS_SOLID' }, fill: { fillType: 'GFT_UNFILLED' } },
      },
      layer: 'BL_F_CrtYd',
      locked: 'LS_UNLOCKED',
      parent: kiid(u1),
    },
  });

  store.batch(() => items.forEach((it) => store.insert(it)));
  return { store, ids };
}

// ------------------------------------------------------------------------ schematic

export interface SchematicFixture {
  sheets: SheetInfo[];
  stores: Map<string, MemoryItemStore>;
  ids: Record<string, string>;
}

const GRID = 1.27; // 50 mil

export function buildSchematic(): SchematicFixture {
  const ids: Record<string, string> = {};
  const powerSheetId = mockKiid('sheetPower');
  const sheets: SheetInfo[] = [
    {
      path: '/',
      name: 'Root',
      file: 'api_kitchen_sink.kicad_sch',
      page: '1',
      children: [{ path: `/${powerSheetId}/`, name: 'Power supply', file: 'power.kicad_sch', page: '2', children: [] }],
    },
  ];
  const stores = new Map<string, MemoryItemStore>();
  const root = new MemoryItemStore('schematic', { sheetPath: { pathHumanReadable: '/' } }, 'schematic:/');
  const power = new MemoryItemStore('schematic', { sheetPath: { pathHumanReadable: `/${powerSheetId}/` } }, `schematic:/${powerSheetId}/`);
  stores.set('/', root);
  stores.set(`/${powerSheetId}/`, power);

  const items: StoredItem[] = [];
  const g = (n: number) => n * GRID;

  const pin = (name: string, number: string, x: number, y: number, orientation: string, type = 'EPT_PASSIVE') => ({
    item: {
      '@type': 'kiapi.schematic.types.SchematicPin',
      name,
      number,
      position: v(x, y),
      length: d(g(2)),
      orientation,
      electricalType: type,
      visible: true,
      nameTextSize: d(1.27),
      numberTextSize: d(1.27),
      alternates: [],
    },
    unit: { unit: 1 },
    bodyStyle: { style: 1 },
    isPrivate: false,
  });

  const symbol = (
    ref: string,
    value: string,
    lib: string,
    name: string,
    footprint: string,
    x: number,
    y: number,
    orientation: string,
    pins: ReturnType<typeof pin>[],
    body: { w: number; h: number },
    description: string,
    type = 'SST_NORMAL',
  ) => {
    const id = mockKiid(ref);
    ids[ref] = id;
    const field = (fid: number, fname: string, text: string, dx: number, dy: number, visible = true) => ({
      id: { id: fid },
      name: fname,
      text: { position: v(x + dx, y + dy), attributes: textAttrs(1.27, 0.15), text },
      visible,
      showName: false,
      allowAutoPlace: true,
      isPrivate: false,
    });
    items.push({
      id,
      type: 'KOT_SCH_SYMBOL',
      bbox: box(x - body.w / 2, y - body.h / 2, body.w, body.h),
      proto: {
        id: kiid(id),
        path: { path: [], pathHumanReadable: '/' },
        position: v(x, y),
        transform: { orientation, mirrorX: false, mirrorY: false },
        locked: 'LS_UNLOCKED',
        definition: {
          id: { libraryNickname: lib, entryName: name },
          type,
          attributes: { excludeFromSimulation: false, excludeFromBillOfMaterials: false, excludeFromBoard: false, excludeFromPositionFiles: false, doNotPopulate: false },
          items: pins,
          unitCount: 1,
          keywords: '',
          footprintFilters: [],
          unitsLocked: false,
        },
        referenceField: field(0, 'Reference', ref, body.w / 2 + 1, -body.h / 2),
        valueField: field(1, 'Value', value, body.w / 2 + 1, 0),
        footprintField: field(2, 'Footprint', footprint, 0, 0, false),
        datasheetField: field(3, 'Datasheet', '~', 0, 0, false),
        descriptionField: field(4, 'Description', description, 0, 0, false),
        attributes: { excludeFromSimulation: false, excludeFromBillOfMaterials: false, excludeFromBoard: false, excludeFromPositionFiles: false, doNotPopulate: false },
        unit: { unit: 1 },
        bodyStyle: { style: 1 },
        showPinNames: true,
        showPinNumbers: true,
        variants: { variants: [] },
      },
    });
    return id;
  };

  // R1 vertical at (40, 40) mm
  symbol('R1', '10k', 'Device', 'R', 'Resistor_SMD:R_0603_1608Metric', 40, 40, 'SSO_0', [pin('~', '1', 0, -g(3), 'SPO_DOWN'), pin('~', '2', 0, g(3), 'SPO_UP')], { w: 2.54, h: 7.62 }, 'Resistor');
  symbol(
    'C1',
    '100nF',
    'Device',
    'C',
    'Capacitor_SMD:C_0603_1608Metric',
    40,
    60,
    'SSO_0',
    [pin('~', '1', 0, -g(3), 'SPO_DOWN'), pin('~', '2', 0, g(3), 'SPO_UP')],
    { w: 2.54, h: 7.62 },
    'Unpolarized capacitor',
  );
  symbol(
    'U1',
    'ATtiny85-20SU',
    'MCU_Microchip_ATtiny',
    'ATtiny85-20SU',
    'Package_SO:SOIC-8_5.3x5.3mm_P1.27mm',
    70,
    50,
    'SSO_0',
    [
      pin('PB0', '5', -g(8), -g(3), 'SPO_RIGHT', 'EPT_BIDIRECTIONAL'),
      pin('PB1', '6', -g(8), -g(1), 'SPO_RIGHT', 'EPT_BIDIRECTIONAL'),
      pin('PB2', '7', -g(8), g(1), 'SPO_RIGHT', 'EPT_BIDIRECTIONAL'),
      pin('PB3', '2', g(8), -g(3), 'SPO_LEFT', 'EPT_BIDIRECTIONAL'),
      pin('PB4', '3', g(8), -g(1), 'SPO_LEFT', 'EPT_BIDIRECTIONAL'),
      pin('~{RESET}/PB5', '1', g(8), g(1), 'SPO_LEFT', 'EPT_BIDIRECTIONAL'),
      pin('VCC', '8', 0, -g(6), 'SPO_DOWN', 'EPT_POWER_IN'),
      pin('GND', '4', 0, g(6), 'SPO_UP', 'EPT_POWER_IN'),
    ],
    { w: 15.24, h: 12.7 },
    '8-bit AVR microcontroller, SOIC-8',
  );
  symbol(
    'J1',
    'Conn_01x04',
    'Connector_Generic',
    'Conn_01x04',
    'Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical',
    100,
    50,
    'SSO_0',
    [pin('Pin_1', '1', -g(4), -g(3), 'SPO_RIGHT'), pin('Pin_2', '2', -g(4), -g(1), 'SPO_RIGHT'), pin('Pin_3', '3', -g(4), g(1), 'SPO_RIGHT'), pin('Pin_4', '4', -g(4), g(3), 'SPO_RIGHT')],
    { w: 5.08, h: 10.16 },
    'Generic connector, single row, 01x04',
  );
  symbol(
    '#PWR01',
    'VCC',
    'power',
    'VCC',
    '',
    40,
    30,
    'SSO_0',
    [pin('VCC', '1', 0, 0, 'SPO_UP', 'EPT_POWER_IN')],
    { w: 2.54, h: 2.54 },
    'Power symbol creates a global label with name "VCC"',
    'SST_GLOBAL_POWER',
  );
  symbol(
    '#PWR02',
    'GND',
    'power',
    'GND',
    '',
    40,
    70,
    'SSO_0',
    [pin('GND', '1', 0, 0, 'SPO_UP', 'EPT_POWER_IN')],
    { w: 2.54, h: 2.54 },
    'Power symbol creates a global label with name "GND"',
    'SST_GLOBAL_POWER',
  );

  const wire = (tag: string, ax: number, ay: number, bx: number, by: number, type: 'SLT_WIRE' | 'SLT_BUS' = 'SLT_WIRE') => {
    const id = mockKiid(tag);
    ids[tag] = id;
    items.push({
      id,
      type: 'KOT_SCH_LINE',
      bbox: box(Math.min(ax, bx) - 0.1, Math.min(ay, by) - 0.1, Math.abs(bx - ax) + 0.2, Math.abs(by - ay) + 0.2),
      proto: {
        id: kiid(id),
        start: v(ax, ay),
        end: v(bx, by),
        layer: type,
        stroke: { width: d(0), style: 'SLS_DEFAULT' },
        locked: 'LS_UNLOCKED',
        startEnding: 'LES_NONE',
        endEnding: 'LES_NONE',
      },
    });
  };
  wire('w_vcc', 40, 30, 40, 40 - g(3)); // VCC -> R1.1
  wire('w_sig1', 40, 40 + g(3), 40, 60 - g(3)); // R1.2 -> C1.1
  wire('w_sig2', 40, 50, 70 - g(8), 50 - g(3)); // junction -> U1.PB0 (diagonal for variety)
  wire('w_gnd', 40, 60 + g(3), 40, 70); // C1.2 -> GND
  wire('w_pb3', 70 + g(8), 50 - g(3), 100 - g(4), 50 - g(3)); // U1.PB3 -> J1.1
  wire('w_pb4', 70 + g(8), 50 - g(1), 100 - g(4), 50 - g(1)); // U1.PB4 -> J1.2
  wire('bus1', 85, 60, 85, 75, 'SLT_BUS');

  const junction = (tag: string, x: number, y: number) => {
    const id = mockKiid(tag);
    ids[tag] = id;
    items.push({
      id,
      type: 'KOT_SCH_JUNCTION',
      bbox: box(x - 0.5, y - 0.5, 1, 1),
      proto: { id: kiid(id), position: v(x, y), diameter: d(0), color: { r: 0, g: 0, b: 0, a: 0 }, locked: 'LS_UNLOCKED' },
    });
  };
  junction('j1', 40, 50);

  const label = (tag: string, type: 'KOT_SCH_LOCAL_LABEL' | 'KOT_SCH_GLOBAL_LABEL' | 'KOT_SCH_HIER_LABEL', text: string, x: number, y: number, shape?: string) => {
    const id = mockKiid(tag);
    ids[tag] = id;
    items.push({
      id,
      type,
      bbox: box(x, y - 1.5, text.length * 1.3 + 2, 3),
      proto: {
        id: kiid(id),
        position: v(x, y),
        text: { position: v(x, y), attributes: textAttrs(1.27, 0.15), text },
        ...(shape ? { shape } : {}),
        fields: [],
        locked: 'LS_UNLOCKED',
        fieldsAutoplaced: true,
      },
    });
  };
  label('lbl_sig', 'KOT_SCH_LOCAL_LABEL', 'SIG', 42, 50);
  label('lbl_pb2', 'KOT_SCH_HIER_LABEL', 'PB2', 70 - g(8), 50 + g(1), 'SLSH_BIDI');
  label('lbl_vin', 'KOT_SCH_GLOBAL_LABEL', 'VIN', 100 - g(4), 50 + g(1), 'SLSH_INPUT');

  const nc = mockKiid('nc1');
  items.push({
    id: nc,
    type: 'KOT_SCH_NO_CONNECT',
    bbox: box(100 - g(4) - 0.6, 50 + g(3) - 0.6, 1.2, 1.2),
    proto: { id: kiid(nc), position: v(100 - g(4), 50 + g(3)), size: d(1.27), locked: 'LS_UNLOCKED' },
  });

  // Sheet symbol for the power sheet
  items.push({
    id: powerSheetId,
    type: 'KOT_SCH_SHEET',
    bbox: box(60, 70, 25.4, 15.24),
    proto: {
      id: kiid(powerSheetId),
      position: v(60, 70),
      size: v(25.4, 15.24),
      borderStroke: { width: d(0.15), style: 'SLS_SOLID' },
      fill: { fillType: 'GFT_UNFILLED' },
      locked: 'LS_UNLOCKED',
      sheetName: { id: { id: 0 }, name: 'Sheetname', text: { position: v(60, 69), attributes: textAttrs(1.27, 0.15), text: 'Power supply' }, visible: true },
      sheetFile: { id: { id: 1 }, name: 'Sheetfile', text: { position: v(60, 86), attributes: textAttrs(1.27, 0.15), text: 'power.kicad_sch' }, visible: true },
      userFields: [],
      pins: [
        { id: kiid(mockKiid('spin1')), position: v(60, 75), text: { text: 'VIN', attributes: textAttrs(1.27, 0.15) }, shape: 'SLSH_INPUT', side: 'SPS_LEFT', locked: 'LS_UNLOCKED' },
        { id: kiid(mockKiid('spin2')), position: v(85.4, 75), text: { text: 'VCC', attributes: textAttrs(1.27, 0.15) }, shape: 'SLSH_OUTPUT', side: 'SPS_RIGHT', locked: 'LS_UNLOCKED' },
      ],
      excludeFromSim: false,
      excludeFromBom: false,
      excludeFromBoard: false,
      dnp: false,
      path: { path: [kiid(powerSheetId)], pathHumanReadable: `/${powerSheetId}/` },
      pageNumber: '2',
      fieldsAutoplaced: true,
    },
  });

  const txt = mockKiid('note');
  items.push({
    id: txt,
    type: 'KOT_SCH_TEXT',
    bbox: box(30, 20, 40, 2),
    proto: {
      id: kiid(txt),
      text: { position: v(30, 20), attributes: { ...textAttrs(1.5, 0.15), horizontalAlignment: 'HA_LEFT' }, text: 'Kitchen-sink schematic: every item type the API exposes.' },
      locked: 'LS_UNLOCKED',
      excludeFromSim: false,
    },
  });

  root.batch(() => items.forEach((it) => root.insert(it)));

  // Power sheet: a regulator, two labels, wires
  const pItems: StoredItem[] = [];
  const pid = mockKiid('U2');
  ids.U2 = pid;
  pItems.push({
    id: pid,
    type: 'KOT_SCH_SYMBOL',
    bbox: box(50 - 7.62, 40 - 5.08, 15.24, 10.16),
    proto: {
      id: kiid(pid),
      path: { path: [kiid(powerSheetId)], pathHumanReadable: `/${powerSheetId}/` },
      position: v(50, 40),
      transform: { orientation: 'SSO_0', mirrorX: false, mirrorY: false },
      locked: 'LS_UNLOCKED',
      definition: {
        id: { libraryNickname: 'Regulator_Linear', entryName: 'AMS1117-3.3' },
        type: 'SST_NORMAL',
        items: [pin('VI', '3', -g(8), 0, 'SPO_RIGHT', 'EPT_POWER_IN'), pin('VO', '2', g(8), 0, 'SPO_LEFT', 'EPT_POWER_OUT'), pin('GND', '1', 0, g(6), 'SPO_UP', 'EPT_POWER_IN')],
        unitCount: 1,
      },
      referenceField: { id: { id: 0 }, name: 'Reference', text: { position: v(50, 32), attributes: textAttrs(1.27), text: 'U2' }, visible: true },
      valueField: { id: { id: 1 }, name: 'Value', text: { position: v(50, 47), attributes: textAttrs(1.27), text: 'AMS1117-3.3' }, visible: true },
      footprintField: { id: { id: 2 }, name: 'Footprint', text: { text: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2' }, visible: false },
      unit: { unit: 1 },
      showPinNames: true,
      showPinNumbers: true,
    },
  });
  const pw = (tag: string, ax: number, ay: number, bx: number, by: number) => {
    const id = mockKiid(tag);
    pItems.push({
      id,
      type: 'KOT_SCH_LINE',
      bbox: box(Math.min(ax, bx), Math.min(ay, by) - 0.1, Math.abs(bx - ax) + 0.1, Math.abs(by - ay) + 0.2),
      proto: { id: kiid(id), start: v(ax, ay), end: v(bx, by), layer: 'SLT_WIRE', stroke: { width: d(0), style: 'SLS_DEFAULT' }, locked: 'LS_UNLOCKED' },
    });
  };
  pw('pw1', 30, 40, 50 - g(8), 40);
  pw('pw2', 50 + g(8), 40, 70, 40);
  const pl = (tag: string, text: string, x: number, y: number, shape: string) => {
    const id = mockKiid(tag);
    pItems.push({
      id,
      type: 'KOT_SCH_HIER_LABEL',
      bbox: box(x - 6, y - 1.5, 6, 3),
      proto: { id: kiid(id), position: v(x, y), text: { position: v(x, y), attributes: textAttrs(1.27), text }, shape, fields: [], locked: 'LS_UNLOCKED' },
    });
  };
  pl('pl_vin', 'VIN', 30, 40, 'SLSH_INPUT');
  pl('pl_vcc', 'VCC', 70, 40, 'SLSH_OUTPUT');
  power.batch(() => pItems.forEach((it) => power.insert(it)));

  return { sheets, stores, ids };
}

// ------------------------------------------------------------------------ footprint

export function buildFootprintDoc(libId: string): MemoryItemStore {
  const store = new MemoryItemStore('footprint', { libId }, `footprint:${libId}`);
  const items: StoredItem[] = [];
  const padAt = (n: string, x: number) => {
    const id = mockKiid(`fp${n}`);
    items.push({
      id,
      type: 'KOT_PCB_PAD',
      layer: 'BL_F_Cu',
      bbox: box(x - 0.45, -0.475, 0.9, 0.95),
      proto: {
        id: kiid(id),
        number: n,
        type: 'PT_SMD',
        locked: 'LS_UNLOCKED',
        position: v(x, 0),
        padStack: {
          type: 'PST_NORMAL',
          layers: ['BL_F_Cu', 'BL_F_Paste', 'BL_F_Mask'],
          copperLayers: [{ layer: 'BL_F_Cu', shape: 'PSS_ROUNDRECT', size: v(0.9, 0.95), cornerRoundingRatio: 0.25, offset: v(0, 0) }],
          angle: deg(0),
        },
        copperClearanceOverride: d(0),
      },
    });
  };
  padAt('1', -0.7875);
  padAt('2', 0.7875);
  const line = (tag: string, layer: string, ax: number, ay: number, bx: number, by: number, w: number) => {
    const id = mockKiid(tag);
    items.push({
      id,
      type: 'KOT_PCB_SHAPE',
      layer,
      bbox: box(Math.min(ax, bx) - w, Math.min(ay, by) - w, Math.abs(bx - ax) + 2 * w, Math.abs(by - ay) + 2 * w),
      proto: {
        id: kiid(id),
        shape: { segment: { start: v(ax, ay), end: v(bx, by) }, attributes: { stroke: { width: d(w), style: 'SLS_SOLID' }, fill: { fillType: 'GFT_UNFILLED' } } },
        layer,
        locked: 'LS_UNLOCKED',
      },
    });
  };
  line('silk1', 'BL_F_SilkS', -0.24, -0.735, 0.24, -0.735, 0.12);
  line('silk2', 'BL_F_SilkS', -0.24, 0.735, 0.24, 0.735, 0.12);
  line('cy1', 'BL_F_CrtYd', -1.48, -0.73, 1.48, -0.73, 0.05);
  line('cy2', 'BL_F_CrtYd', 1.48, -0.73, 1.48, 0.73, 0.05);
  line('cy3', 'BL_F_CrtYd', 1.48, 0.73, -1.48, 0.73, 0.05);
  line('cy4', 'BL_F_CrtYd', -1.48, 0.73, -1.48, -0.73, 0.05);
  line('fab1', 'BL_F_Fab', -0.8, -0.4, 0.8, -0.4, 0.1);
  line('fab2', 'BL_F_Fab', 0.8, -0.4, 0.8, 0.4, 0.1);
  line('fab3', 'BL_F_Fab', 0.8, 0.4, -0.8, 0.4, 0.1);
  line('fab4', 'BL_F_Fab', -0.8, 0.4, -0.8, -0.4, 0.1);
  const ref = mockKiid('fpref');
  items.push({
    id: ref,
    type: 'KOT_PCB_TEXT',
    layer: 'BL_F_SilkS',
    bbox: box(-1.5, -2, 3, 1),
    proto: { id: kiid(ref), text: { position: v(0, -1.43), attributes: textAttrs(1, 0.15), text: 'REF**', layer: 'BL_F_SilkS' }, layer: 'BL_F_SilkS', locked: 'LS_UNLOCKED' },
  });
  store.batch(() => items.forEach((it) => store.insert(it)));
  return store;
}
