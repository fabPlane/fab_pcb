import './setup';
import { describe, expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import {
  BoardLayer,
  FieldSchema,
  PadSchema,
  PadStackShape,
  PadStackType,
  SchematicLabelShape,
  SchematicLineType,
  ViaType,
  ZoneType,
  unpackAny,
  type Any,
  type FootprintInstance,
  type Pad,
} from '@kicad-web/proto';
import type { StoredItem } from '@/contracts';
import {
  cloneForPaste,
  makeBoardShape,
  makeBoardText,
  makeFootprintInstance,
  makeJunction,
  makeLabel,
  makeNoConnect,
  makeSchematicLine,
  makeSchematicText,
  makeSheet,
  makeTrack,
  makeVia,
  makeZone,
  nextReference,
  translateChild,
  type LibraryFootprint,
} from '@/lib/create';

type Vec = { xNm: bigint; yNm: bigint };
const vec = (x: number, y: number): Vec => ({ xNm: BigInt(x), yNm: BigInt(y) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = (item: StoredItem) => item.proto as any;

function expectFreshId(item: StoredItem) {
  expect(item.id).toHaveLength(36);
  expect(p(item).id.value).toBe(item.id);
}

describe('create: board factories', () => {
  test('makeTrack', () => {
    const t = makeTrack({ x: 100e6, y: 100e6 }, { x: 110e6, y: 100e6 }, 250_000, 'BL_F_Cu', 'GND');
    expectFreshId(t);
    expect(t.type).toBe('KOT_PCB_TRACE');
    expect(t.layer).toBe('BL_F_Cu');
    expect(t.net).toBe('GND');
    expect(p(t).$typeName).toBe('kiapi.board.types.Track');
    expect(p(t).start).toMatchObject(vec(100_000_000, 100_000_000));
    expect(p(t).start.xNm).toBe(100000000n);
    expect(p(t).end).toMatchObject(vec(110_000_000, 100_000_000));
    expect(p(t).width.valueNm).toBe(250000n);
    expect(p(t).layer).toBe(BoardLayer.BL_F_Cu);
    expect(p(t).net.name).toBe('GND');
    expect(t.bbox).toEqual({ x: 100e6 - 125_000, y: 100e6 - 125_000, w: 10e6 + 250_000, h: 250_000 });
  });

  test('makeTrack without a net leaves net unset', () => {
    const t = makeTrack({ x: 0, y: 0 }, { x: 1e6, y: 0 }, 200_000, 'BL_B_Cu');
    expect(t.net).toBeUndefined();
    expect(p(t).net).toBeUndefined();
    expect(t.layer).toBe('BL_B_Cu');
    expect(p(t).layer).toBe(BoardLayer.BL_B_Cu);
  });

  test('two tracks get distinct ids', () => {
    const a = makeTrack({ x: 0, y: 0 }, { x: 1e6, y: 0 }, 1, 'BL_F_Cu');
    const b = makeTrack({ x: 0, y: 0 }, { x: 1e6, y: 0 }, 1, 'BL_F_Cu');
    expect(a.id).not.toBe(b.id);
  });

  test('makeVia defaults to F.Cu → B.Cu with drill and diameter in the pad stack', () => {
    const v = makeVia({ x: 110e6, y: 100e6 }, { diameterNm: 600_000, drillNm: 300_000, net: 'VCC' });
    expectFreshId(v);
    expect(v.type).toBe('KOT_PCB_VIA');
    expect(v.layer).toBe('BL_F_Cu');
    expect(v.net).toBe('VCC');
    expect(p(v).$typeName).toBe('kiapi.board.types.Via');
    expect(p(v).position).toMatchObject(vec(110_000_000, 100_000_000));
    expect(p(v).type).toBe(ViaType.VT_THROUGH);
    expect(p(v).padStack.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu]);
    expect(p(v).padStack.drill.diameter).toMatchObject(vec(300_000, 300_000));
    expect(p(v).padStack.drill.startLayer).toBe(BoardLayer.BL_F_Cu);
    expect(p(v).padStack.drill.endLayer).toBe(BoardLayer.BL_B_Cu);
    expect(p(v).padStack.copperLayers[0].size).toMatchObject(vec(600_000, 600_000));
    expect(v.bbox).toEqual({ x: 110e6 - 300_000, y: 100e6 - 300_000, w: 600_000, h: 600_000 });
  });

  test('makeVia with explicit layers uses the first as its primary layer', () => {
    const v = makeVia({ x: 0, y: 0 }, { diameterNm: 500_000, drillNm: 250_000, layers: ['BL_In1_Cu', 'BL_B_Cu'] });
    expect(v.layer).toBe('BL_In1_Cu');
    expect(p(v).padStack.layers).toEqual([BoardLayer.BL_In1_Cu, BoardLayer.BL_B_Cu]);
    expect(p(v).padStack.drill.startLayer).toBe(BoardLayer.BL_In1_Cu);
    expect(v.net).toBeUndefined();
  });

  test('makeBoardShape segment', () => {
    const s = makeBoardShape({ kind: 'segment', a: { x: 10e6, y: 20e6 }, b: { x: 30e6, y: 20e6 } }, 'BL_Edge_Cuts', 100_000);
    expectFreshId(s);
    expect(s.type).toBe('KOT_PCB_SHAPE');
    expect(s.layer).toBe('BL_Edge_Cuts');
    expect(p(s).$typeName).toBe('kiapi.board.types.BoardGraphicShape');
    expect(p(s).layer).toBe(BoardLayer.BL_Edge_Cuts);
    expect(p(s).shape.geometry.case).toBe('segment');
    expect(p(s).shape.geometry.value.start).toMatchObject(vec(10e6, 20e6));
    expect(p(s).shape.geometry.value.end).toMatchObject(vec(30e6, 20e6));
    expect(p(s).shape.attributes.stroke.width.valueNm).toBe(100000n);
    expect(p(s).shape.attributes.fill.fillType).toBe(1);
    expect(s.bbox).toEqual({ x: 10e6 - 50_000, y: 20e6 - 50_000, w: 20e6 + 100_000, h: 100_000 });
  });

  test('makeBoardShape rect normalises the corners', () => {
    const s = makeBoardShape({ kind: 'rect', a: { x: 20e6, y: 30e6 }, b: { x: 10e6, y: 5e6 } }, 'BL_F_SilkS', 150_000, { filled: true });
    expect(p(s).shape.geometry.case).toBe('rectangle');
    expect(p(s).shape.geometry.value.topLeft).toMatchObject(vec(10e6, 5e6));
    expect(p(s).shape.geometry.value.bottomRight).toMatchObject(vec(20e6, 30e6));
    expect(p(s).shape.attributes.fill.fillType).toBe(2);
    expect(s.bbox).toEqual({ x: 10e6 - 75_000, y: 5e6 - 75_000, w: 10e6 + 150_000, h: 25e6 + 150_000 });
  });

  test('makeBoardShape circle carries centre + radius point', () => {
    const s = makeBoardShape({ kind: 'circle', c: { x: 10e6, y: 10e6 }, r: 2e6 }, 'BL_F_Cu', 200_000, { net: 'GND' });
    expect(p(s).shape.geometry.case).toBe('circle');
    expect(p(s).shape.geometry.value.center).toMatchObject(vec(10e6, 10e6));
    expect(p(s).shape.geometry.value.radiusPoint).toMatchObject(vec(12e6, 10e6));
    expect(s.net).toBe('GND');
    expect(p(s).net.name).toBe('GND');
    expect(s.bbox).toEqual({ x: 8e6 - 100_000, y: 8e6 - 100_000, w: 4e6 + 200_000, h: 4e6 + 200_000 });
  });

  test('makeBoardShape arc', () => {
    const s = makeBoardShape({ kind: 'arc', start: { x: 0, y: 0 }, mid: { x: 1e6, y: 1e6 }, end: { x: 2e6, y: 0 } }, 'BL_F_Cu', 100_000);
    expect(p(s).shape.geometry.case).toBe('arc');
    expect(p(s).shape.geometry.value.start).toMatchObject(vec(0, 0));
    expect(p(s).shape.geometry.value.mid).toMatchObject(vec(1e6, 1e6));
    expect(p(s).shape.geometry.value.end).toMatchObject(vec(2e6, 0));
    expect(s.bbox).toEqual({ x: -50_000, y: -50_000, w: 2e6 + 100_000, h: 1e6 + 100_000 });
  });

  test('makeBoardShape polygon is a closed poly set of point nodes', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5e6, y: 0 },
      { x: 5e6, y: 5e6 },
    ];
    const s = makeBoardShape({ kind: 'polygon', pts }, 'BL_F_Cu', 100_000);
    expect(p(s).shape.geometry.case).toBe('polygon');
    const outline = p(s).shape.geometry.value.polygons[0].outline;
    expect(outline.closed).toBe(true);
    expect(outline.nodes).toHaveLength(3);
    expect(outline.nodes.every((n: { geometry: { case: string } }) => n.geometry.case === 'point')).toBe(true);
    expect(outline.nodes[2].geometry.value).toMatchObject(vec(5e6, 5e6));
    expect(s.bbox).toEqual({ x: -50_000, y: -50_000, w: 5e6 + 100_000, h: 5e6 + 100_000 });
  });

  test('makeBoardText', () => {
    const t = makeBoardText({ x: 50e6, y: 60e6 }, 'BL_F_SilkS', { text: 'HELLO', sizeNm: 1_000_000 });
    expectFreshId(t);
    expect(t.type).toBe('KOT_PCB_TEXT');
    expect(t.layer).toBe('BL_F_SilkS');
    expect(p(t).$typeName).toBe('kiapi.board.types.BoardText');
    expect(p(t).layer).toBe(BoardLayer.BL_F_SilkS);
    expect(p(t).text.text).toBe('HELLO');
    expect(p(t).text.position).toMatchObject(vec(50e6, 60e6));
    expect(p(t).text.attributes.size).toMatchObject(vec(1_000_000, 1_000_000));
    expect(p(t).text.attributes.strokeWidth.valueNm).toBe(150000n);
    expect(p(t).text.attributes.angle.valueDegrees).toBe(0);
    expect(t.bbox).toEqual({ x: 50e6 - 2e6, y: 60e6 - 500_000, w: 4e6, h: 1e6 });
  });

  test('makeBoardText honours thickness and angle overrides', () => {
    const t = makeBoardText({ x: 0, y: 0 }, 'BL_B_SilkS', { text: 'X', sizeNm: 2_000_000, thicknessNm: 400_000, angleDeg: 90 });
    expect(p(t).text.attributes.strokeWidth.valueNm).toBe(400000n);
    expect(p(t).text.attributes.angle.valueDegrees).toBe(90);
    expect(p(t).text.attributes.size.xNm).toBe(2000000n);
  });

  const square = [
    { x: 10e6, y: 10e6 },
    { x: 20e6, y: 10e6 },
    { x: 20e6, y: 20e6 },
    { x: 10e6, y: 20e6 },
  ];

  test('makeZone copper: closed point outline, net in copper settings', () => {
    const z = makeZone(square, ['BL_F_Cu', 'BL_B_Cu'], { net: 'GND', name: 'gnd pour', clearanceNm: 300_000, minThicknessNm: 200_000 });
    expectFreshId(z);
    expect(z.type).toBe('KOT_PCB_ZONE');
    expect(z.layer).toBe('BL_F_Cu');
    expect(z.net).toBe('GND');
    expect(p(z).$typeName).toBe('kiapi.board.types.Zone');
    expect(p(z).type).toBe(ZoneType.ZT_COPPER);
    expect(p(z).layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu]);
    expect(p(z).name).toBe('gnd pour');
    const outline = p(z).outline.polygons[0].outline;
    expect(outline.closed).toBe(true);
    expect(outline.nodes).toHaveLength(4);
    for (const [i, n] of outline.nodes.entries()) {
      expect(n.geometry.case).toBe('point');
      expect(n.geometry.value).toMatchObject(vec(square[i]!.x, square[i]!.y));
    }
    expect(p(z).outline.polygons[0].holes).toEqual([]);
    expect(p(z).settings.case).toBe('copperSettings');
    expect(p(z).settings.value.net.name).toBe('GND');
    expect(p(z).settings.value.clearance.valueNm).toBe(300000n);
    expect(p(z).settings.value.minThickness.valueNm).toBe(200000n);
    expect(z.bbox).toEqual({ x: 10e6, y: 10e6, w: 10e6, h: 10e6 });
  });

  test('makeZone defaults clearance / min thickness and leaves the net unset', () => {
    const z = makeZone(square, ['BL_B_Cu']);
    expect(z.net).toBeUndefined();
    expect(z.layer).toBe('BL_B_Cu');
    expect(p(z).settings.case).toBe('copperSettings');
    expect(p(z).settings.value.net).toBeUndefined();
    expect(p(z).settings.value.clearance.valueNm).toBe(200000n);
    expect(p(z).settings.value.minThickness.valueNm).toBe(250000n);
    expect(p(z).name).toBe('');
  });

  test('makeZone keepout uses rule-area settings', () => {
    const z = makeZone(square, ['BL_F_Cu'], { keepout: true, net: 'ignored?' });
    expect(p(z).type).toBe(ZoneType.ZT_RULE_AREA);
    expect(p(z).settings.case).toBe('ruleAreaSettings');
    expect(p(z).settings.value.keepoutCopper).toBe(true);
    expect(p(z).settings.value.keepoutTracks).toBe(true);
    expect(p(z).settings.value.keepoutVias).toBe(true);
  });
});

describe('create: schematic factories', () => {
  test('makeSchematicLine wire / bus / graphic', () => {
    const w = makeSchematicLine({ x: 50.8e6, y: 50.8e6 }, { x: 63.5e6, y: 50.8e6 }, 'wire');
    expectFreshId(w);
    expect(w.type).toBe('KOT_SCH_LINE');
    expect(w.layer).toBeUndefined();
    expect(p(w).$typeName).toBe('kiapi.schematic.types.SchematicLine');
    expect(p(w).type).toBe(SchematicLineType.SLT_WIRE);
    expect(p(w).start).toMatchObject(vec(50_800_000, 50_800_000));
    expect(p(w).end).toMatchObject(vec(63_500_000, 50_800_000));
    expect(p(w).stroke.width.valueNm).toBe(0n);
    expect(w.bbox).toEqual({ x: 50.8e6 - 100_000, y: 50.8e6 - 100_000, w: 12.7e6 + 200_000, h: 200_000 });

    const b = makeSchematicLine({ x: 0, y: 0 }, { x: 0, y: 2.54e6 }, 'bus', 300_000);
    expect(p(b).type).toBe(SchematicLineType.SLT_BUS);
    expect(p(b).stroke.width.valueNm).toBe(300000n);

    const g = makeSchematicLine({ x: 0, y: 0 }, { x: 1e6, y: 1e6 }, 'graphic');
    expect(p(g).type).toBe(SchematicLineType.SLT_GRAPHIC);
  });

  test('makeJunction', () => {
    const j = makeJunction({ x: 63.5e6, y: 50.8e6 });
    expectFreshId(j);
    expect(j.type).toBe('KOT_SCH_JUNCTION');
    expect(p(j).$typeName).toBe('kiapi.schematic.types.Junction');
    expect(p(j).position).toMatchObject(vec(63_500_000, 50_800_000));
    expect(p(j).diameter.valueNm).toBe(0n);
    expect(j.bbox).toEqual({ x: 63.5e6 - 400_000, y: 50.8e6 - 400_000, w: 800_000, h: 800_000 });
  });

  test('makeNoConnect', () => {
    const n = makeNoConnect({ x: 10e6, y: 20e6 });
    expectFreshId(n);
    expect(n.type).toBe('KOT_SCH_NO_CONNECT');
    expect(p(n).$typeName).toBe('kiapi.schematic.types.NoConnectMarker');
    expect(p(n).position).toMatchObject(vec(10e6, 20e6));
    expect(n.bbox).toBeDefined();
  });

  test('makeLabel local / global / hierarchical', () => {
    const local = makeLabel({ x: 10e6, y: 20e6 }, 'local', 'SDA');
    expectFreshId(local);
    expect(local.type).toBe('KOT_SCH_LABEL');
    expect(local.net).toBe('SDA');
    expect(p(local).$typeName).toBe('kiapi.schematic.types.LocalLabel');
    expect(p(local).position).toMatchObject(vec(10e6, 20e6));
    expect(p(local).text.text).toBe('SDA');
    expect(p(local).text.position).toMatchObject(vec(10e6, 20e6));
    expect(p(local).text.attributes.size.xNm).toBe(1270000n);
    expect(p(local).shape).toBeUndefined();
    expect(local.bbox).toEqual({ x: 10e6, y: 20e6 - 1_270_000, w: 1_270_000 * 0.8 * 3, h: 2_540_000 });

    const global = makeLabel({ x: 0, y: 0 }, 'global', 'VBUS', { shape: 'output', sizeNm: 1_000_000 });
    expect(global.type).toBe('KOT_SCH_GLOBAL_LABEL');
    expect(p(global).$typeName).toBe('kiapi.schematic.types.GlobalLabel');
    expect(p(global).shape).toBe(SchematicLabelShape.SLSH_OUTPUT);
    expect(p(global).text.attributes.size.xNm).toBe(1000000n);
    expect(global.net).toBe('VBUS');

    const hier = makeLabel({ x: 0, y: 0 }, 'hier', 'CLK', { shape: 'bidi' });
    expect(hier.type).toBe('KOT_SCH_HIER_LABEL');
    expect(p(hier).$typeName).toBe('kiapi.schematic.types.HierarchicalLabel');
    expect(p(hier).shape).toBe(SchematicLabelShape.SLSH_BIDI);

    const hierDefault = makeLabel({ x: 0, y: 0 }, 'hier', 'RST');
    expect(p(hierDefault).shape).toBe(SchematicLabelShape.SLSH_INPUT);
  });

  test('makeSchematicText', () => {
    const t = makeSchematicText({ x: 5e6, y: 6e6 }, 'Note', 2_000_000);
    expectFreshId(t);
    expect(t.type).toBe('KOT_SCH_TEXT');
    expect(p(t).$typeName).toBe('kiapi.schematic.types.SchematicText');
    expect(p(t).text.text).toBe('Note');
    expect(p(t).text.position).toMatchObject(vec(5e6, 6e6));
    expect(p(t).text.attributes.size).toMatchObject(vec(2_000_000, 2_000_000));
    expect(t.bbox).toEqual({ x: 5e6, y: 6e6 - 2e6, w: 2e6 * 0.8 * 4, h: 2e6 });
  });

  test('makeSheet normalises the corners and names the fields', () => {
    const s = makeSheet({ x: 60e6, y: 40e6 }, { x: 30e6, y: 20e6 }, 'Power', 'power.kicad_sch');
    expectFreshId(s);
    expect(s.type).toBe('KOT_SCH_SHEET');
    expect(p(s).$typeName).toBe('kiapi.schematic.types.SheetSymbol');
    expect(p(s).position).toMatchObject(vec(30e6, 20e6));
    expect(p(s).size).toMatchObject(vec(30e6, 20e6));
    expect(p(s).nameField.name).toBe('Sheetname');
    expect(p(s).nameField.text.text).toBe('Power');
    expect(p(s).nameField.text.position).toMatchObject(vec(30e6, 20e6 - 200_000));
    expect(p(s).filenameField.name).toBe('Sheetfile');
    expect(p(s).filenameField.text.text).toBe('power.kicad_sch');
    expect(p(s).filenameField.text.position).toMatchObject(vec(30e6, 40e6 + 200_000));
    expect(s.bbox).toEqual({ x: 30e6, y: 20e6, w: 30e6, h: 20e6 });
  });
});

describe('create: footprint placement', () => {
  const PAD_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

  function lib(): LibraryFootprint {
    const pad = create(PadSchema, {
      id: { value: PAD_ID },
      number: '1',
      position: { xNm: -825000n, yNm: 0n },
      padStack: {
        type: PadStackType.PST_NORMAL,
        layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_F_Paste, BoardLayer.BL_F_Mask],
        copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: PadStackShape.PSS_RECTANGLE, size: { xNm: 1000000n, yNm: 950000n } }],
      },
    });
    const reference = create(FieldSchema, { name: 'Reference', visible: true, text: { layer: BoardLayer.BL_F_SilkS, text: { text: 'REF**', position: { xNm: 0n, yNm: -1430000n } } } });
    const value = create(FieldSchema, { name: 'Value', visible: true, text: { layer: BoardLayer.BL_F_Fab, text: { text: 'R_0402', position: { xNm: 0n, yNm: 1430000n } } } });
    return { libId: 'Resistor_SMD:R_0402_1005Metric', items: [pad], fields: [reference, value] };
  }

  test('children are translated to absolute coordinates and repacked as Any without ids', () => {
    const fp = makeFootprintInstance({ x: 150e6, y: 100e6 }, 'BL_F_Cu', lib(), 'R5', '10k');
    expectFreshId(fp);
    expect(fp.type).toBe('KOT_PCB_FOOTPRINT');
    expect(fp.layer).toBe('BL_F_Cu');
    const proto = fp.proto as FootprintInstance;
    expect(proto.$typeName).toBe('kiapi.board.types.FootprintInstance');
    expect(proto.position).toMatchObject(vec(150e6, 100e6));
    expect(proto.orientation?.valueDegrees).toBe(0);
    expect(proto.layer).toBe(BoardLayer.BL_F_Cu);

    expect(proto.definition?.id?.libraryNickname).toBe('Resistor_SMD');
    expect(proto.definition?.id?.entryName).toBe('R_0402_1005Metric');

    const items = proto.definition!.items as Any[];
    expect(items).toHaveLength(1);
    expect(items[0]!.$typeName).toBe('google.protobuf.Any');
    expect(items[0]!.typeUrl.endsWith('kiapi.board.types.Pad')).toBe(true);
    const pad = unpackAny(items[0]!) as Pad;
    expect(pad.$typeName).toBe('kiapi.board.types.Pad');
    expect(pad.position?.xNm).toBe(149175000n);
    expect(pad.position?.yNm).toBe(100000000n);
    expect(pad.id).toBeUndefined();
    expect(pad.number).toBe('1');
    // sizes are not coordinates
    expect(pad.padStack?.copperLayers[0]?.size).toMatchObject(vec(1_000_000, 950_000));
    expect(pad.padStack?.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_F_Paste, BoardLayer.BL_F_Mask]);

    expect(proto.referenceField?.name).toBe('Reference');
    expect(proto.referenceField?.text?.text?.text).toBe('R5');
    expect(proto.referenceField?.text?.text?.position).toMatchObject(vec(150e6, 100e6 - 1_430_000));
    expect(proto.valueField?.text?.text?.text).toBe('10k');
    expect(proto.valueField?.text?.text?.position).toMatchObject(vec(150e6, 100e6 + 1_430_000));

    expect(fp.bbox).toBeDefined();
    expect(fp.bbox!.x).toBeLessThanOrEqual(149_175_000);
    expect(fp.bbox!.x + fp.bbox!.w).toBeGreaterThanOrEqual(149_175_000);
    expect(fp.bbox!.y).toBeLessThanOrEqual(100e6);
    expect(fp.bbox!.y + fp.bbox!.h).toBeGreaterThanOrEqual(100e6);
  });

  test('the library messages are not mutated by placement', () => {
    const l = lib();
    makeFootprintInstance({ x: 150e6, y: 100e6 }, 'BL_F_Cu', l, 'R1');
    expect((l.items[0] as Pad).position?.xNm).toBe(-825000n);
    expect((l.items[0] as Pad).id?.value).toBe(PAD_ID);
    expect((l.fields[0] as { text?: { text?: { text?: string } } }).text?.text?.text).toBe('REF**');
  });

  test('value is kept from the library when not given; missing fields get defaults around the anchor', () => {
    const fp = makeFootprintInstance({ x: 10e6, y: 10e6 }, 'BL_B_Cu', lib(), 'R2');
    const proto = fp.proto as FootprintInstance;
    expect(proto.valueField?.text?.text?.text).toBe('R_0402');
    expect(proto.layer).toBe(BoardLayer.BL_B_Cu);
    expect(fp.layer).toBe('BL_B_Cu');
    expect(proto.datasheetField).toBeUndefined();

    const bare = makeFootprintInstance({ x: 10e6, y: 10e6 }, 'BL_F_Cu', { libId: 'Lib:Part', items: [], fields: [] }, 'U1', 'X');
    const bp = bare.proto as FootprintInstance;
    expect(bp.referenceField?.text?.text?.text).toBe('U1');
    expect(bp.referenceField?.text?.text?.position).toMatchObject(vec(10e6, 10e6 - 1_500_000));
    expect(bp.valueField?.text?.text?.text).toBe('X');
    expect(bp.definition?.items).toEqual([]);
    expect(bare.bbox).toEqual({ x: 10e6 - 1e6, y: 10e6 - 1e6, w: 2e6, h: 2e6 });
  });

  test('nextReference', () => {
    expect(nextReference('R', ['R1', 'R7', 'C2'])).toBe('R8');
    expect(nextReference('R', [])).toBe('R1');
    expect(nextReference('C', ['R1', 'R7'])).toBe('C1');
    expect(nextReference('R', ['R10', 'R9', 'R?', 'RX3'])).toBe('R11');
    expect(nextReference('U+', ['U+2'])).toBe('U+3');
  });
});

describe('create: translateChild / cloneForPaste', () => {
  test('translateChild shifts positional vectors but not size / offset', () => {
    const src = {
      $typeName: 'x',
      position: { xNm: 1n, yNm: 2n },
      start: { xNm: 10, yNm: 20 },
      end: { xNm: 30n, yNm: 40n },
      size: { xNm: 5n, yNm: 6n },
      padStack: { offset: { xNm: 7n, yNm: 8n }, copperLayers: [{ size: { xNm: 9n, yNm: 10n }, offset: { xNm: 11n, yNm: 12n } }] },
      nodes: [{ position: { xNm: 100n, yNm: 200n } }],
      text: { text: 'T', position: { xNm: 0n, yNm: 0n } },
    };
    const out = translateChild(src, 1000, 2000);
    expect(out).not.toBe(src);
    expect(out.position).toMatchObject({ xNm: 1001n, yNm: 2002n });
    expect(out.start).toMatchObject({ xNm: 1010n, yNm: 2020n });
    expect(out.end).toMatchObject({ xNm: 1030n, yNm: 2040n });
    expect(out.size).toMatchObject({ xNm: 5n, yNm: 6n });
    expect(out.padStack.offset).toMatchObject({ xNm: 7n, yNm: 8n });
    expect(out.padStack.copperLayers[0]!.size).toMatchObject({ xNm: 9n, yNm: 10n });
    expect(out.padStack.copperLayers[0]!.offset).toMatchObject({ xNm: 11n, yNm: 12n });
    expect(out.nodes[0]!.position).toMatchObject({ xNm: 1100n, yNm: 2200n });
    expect(out.text.position).toMatchObject({ xNm: 1000n, yNm: 2000n });
    expect(out.$typeName).toBe('x');
    // source untouched
    expect(src.position).toMatchObject({ xNm: 1n, yNm: 2n });
  });

  test('cloneForPaste: fresh id, parent remapped through the idMap, coordinates and bbox shifted', () => {
    const original = makeTrack({ x: 10e6, y: 10e6 }, { x: 20e6, y: 10e6 }, 200_000, 'BL_F_Cu', 'GND');
    const item: StoredItem = { ...original, parent: 'old-parent' };
    const idMap = new Map<string, string>([['old-parent', 'new-parent']]);
    const c = cloneForPaste(item, 1e6, 2e6, idMap);

    expect(c.id).toHaveLength(36);
    expect(c.id).not.toBe(item.id);
    expect(p(c).id.value).toBe(c.id);
    expect(idMap.get(item.id)).toBe(c.id);
    expect(c.parent).toBe('new-parent');
    expect(p(c).parent.value).toBe('new-parent');
    expect(p(c).start).toMatchObject(vec(11e6, 12e6));
    expect(p(c).end).toMatchObject(vec(21e6, 12e6));
    expect(p(c).width.valueNm).toBe(200000n);
    expect(c.type).toBe('KOT_PCB_TRACE');
    expect(c.net).toBe('GND');
    expect(c.bbox).toEqual({ ...item.bbox!, x: item.bbox!.x + 1e6, y: item.bbox!.y + 2e6 });
    // original untouched
    expect(p(item).start).toMatchObject(vec(10e6, 10e6));
    expect(item.id).not.toBe(c.id);
  });

  test('cloneForPaste: unknown parent is dropped, pre-mapped id is reused', () => {
    const item: StoredItem = { ...makeJunction({ x: 1e6, y: 1e6 }), parent: 'not-copied' };
    const idMap = new Map<string, string>([[item.id, 'preassigned-id']]);
    const c = cloneForPaste(item, 0, 0, idMap);
    expect(c.id).toBe('preassigned-id');
    expect(c.parent).toBeUndefined();
    expect(p(c).parent).toBeUndefined();
    expect(p(c).position).toMatchObject(vec(1e6, 1e6));
  });
});
