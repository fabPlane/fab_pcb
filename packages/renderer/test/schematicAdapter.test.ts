import { describe, expect, test } from 'bun:test';
import { schematicItemToRenderItems, colorOf, schematicItemTypeOf } from '../src/schematic/schematicAdapter.js';
import { SCH_LAYERS, SCH_DEFAULTS, SCHEMATIC_DRAW_ORDER, SCHEMATIC_THEME_LAYERS, MIL } from '../src/schematic/schematicLayers.js';
import { KICAD_CLASSIC_THEME, KICAD_DEFAULT_THEME } from '../src/core/theme.js';
import { boxContains, type Primitive, type RenderItem } from '../src/core/model.js';
import { MM, busEntry, directiveLabel, globalLabel, group, hierLabel, ic, junction, localLabel, noConnect, resistor, ruleArea, schImage, sheet, syntheticSchematic, wire, schText, textBox, type Spin } from './schematicFixtures.js';

const seg = (p: Primitive) => p as Extract<Primitive, { kind: 'segment' }>;
const poly = (p: Primitive) => p as Extract<Primitive, { kind: 'polygon' }>;
const glyph = (p: Primitive) => p as Extract<Primitive, { kind: 'text-glyphs' }>;
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

describe('schematic adapter: wiring', () => {
  test('wire / bus / graphic line: default widths, layers, colour override, dashes', () => {
    const [w] = schematicItemToRenderItems(wire('w', 0, 0, 10, 0));
    expect(w!.layer).toBe(SCH_LAYERS.wire);
    expect(w!.prims).toEqual([{ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 10 * MM, y: 0 }, width: SCH_DEFAULTS.wireWidth }]);
    expect(w!.owner).toBe('w');
    expect(w!.color).toBeUndefined();
    const [b] = schematicItemToRenderItems(wire('b', 0, 0, 10, 0, { bus: true }));
    expect(b!.layer).toBe(SCH_LAYERS.bus);
    expect(seg(b!.prims[0]!).width).toBe(SCH_DEFAULTS.busWidth);
    const [g] = schematicItemToRenderItems(wire('g', 0, 0, 10, 0, { graphic: true, widthMm: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } }));
    expect(g!.layer).toBe(SCH_LAYERS.note);
    expect(seg(g!.prims[0]!).width).toBe(0.5 * MM);
    expect(g!.color).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    const [dashed] = schematicItemToRenderItems(wire('d', 0, 0, 20, 0, { graphic: true, style: 3 }));
    expect(dashed!.prims.length).toBeGreaterThan(3);
    // enum names are accepted too
    const [named] = schematicItemToRenderItems({ id: 'n', type: 'KOT_SCH_LINE', proto: { start: { xNm: 0, yNm: 0 }, end: { xNm: 1000, yNm: 0 }, type: 'SLT_BUS' } });
    expect(named!.layer).toBe(SCH_LAYERS.bus);
  });

  test('junction, no-connect, bus entries', () => {
    const [j] = schematicItemToRenderItems(junction('j', 1, 1));
    expect(j!.layer).toBe(SCH_LAYERS.junction);
    expect(j!.prims[0]).toEqual({ kind: 'circle', c: { x: 1 * MM, y: 1 * MM }, r: SCH_DEFAULTS.junctionDiameter / 2, width: 0, fill: true });
    const [j2] = schematicItemToRenderItems(junction('j2', 0, 0, 1));
    expect((j2!.prims[0] as { r: number }).r).toBe(0.5 * MM);
    const [nc] = schematicItemToRenderItems(noConnect('nc', 2, 2));
    expect(nc!.layer).toBe(SCH_LAYERS.noConnect);
    expect(nc!.prims.length).toBe(2);
    const delta = SCH_DEFAULTS.noConnectSize / 2;
    expect(seg(nc!.prims[0]!).a).toEqual({ x: 2 * MM - delta, y: 2 * MM - delta });
    expect(seg(nc!.prims[0]!).width).toBe(SCH_DEFAULTS.lineWidth);
    const [wb] = schematicItemToRenderItems(busEntry('be', 10, 10, false));
    expect(wb!.layer).toBe(SCH_LAYERS.wire);
    expect(wb!.prims).toEqual([{ kind: 'segment', a: { x: 10 * MM, y: 10 * MM }, b: { x: 12.54 * MM, y: 12.54 * MM }, width: SCH_DEFAULTS.wireWidth }]);
    const [bb] = schematicItemToRenderItems(busEntry('bb', 10, 10, true));
    expect(bb!.layer).toBe(SCH_LAYERS.bus);
    expect(seg(bb!.prims[0]!).width).toBe(SCH_DEFAULTS.busWidth);
  });
});

describe('schematic adapter: wire + junction + label', () => {
  test('a labelled net: the label text sits on the wire end, the junction covers the wire width', () => {
    const items = [wire('w', 10, 10, 30, 10), wire('w2', 20, 10, 20, 20), junction('j', 20, 10), localLabel('l', 10, 10, 'NET_A', 3)].flatMap((it) => schematicItemToRenderItems(it));
    expect(items.map((i) => i.id)).toEqual(['w', 'w2', 'j', 'l']);
    const j = items[2]!.prims[0]!;
    expect(j.kind).toBe('circle');
    if (j.kind === 'circle') {
      expect(j.c).toEqual({ x: 20 * MM, y: 10 * MM });
      expect(j.r).toBeGreaterThan(SCH_DEFAULTS.wireWidth / 2);
    }
    // the label's bbox includes its anchor (the wire end) and its text lies above the wire
    const l = items[3]!;
    expect(boxContains(l.bbox, { x: 10 * MM, y: 10 * MM })).toBe(true);
    const g = glyph(l.prims[0]!);
    for (const p of g.outline) expect(p.y).toBeLessThan(10 * MM);
    expect(g.pos.x).toBe(10 * MM);
    // all on their own layers, no colour overrides
    expect(items.map((i) => i.layer)).toEqual([SCH_LAYERS.wire, SCH_LAYERS.wire, SCH_LAYERS.junction, SCH_LAYERS.labelLocal]);
    expect(items.every((i) => i.color === undefined)).toBe(true);
  });
});

describe('schematic adapter: labels', () => {
  test('local label: text-glyphs raised above the wire, anchored at the label position', () => {
    const items = schematicItemToRenderItems(localLabel('l', 10, 10, 'NET', 3));
    expect(items.length).toBe(1);
    const it = items[0]!;
    expect(it.layer).toBe(SCH_LAYERS.labelLocal);
    const g = glyph(it.prims[0]!);
    expect(g.kind).toBe('text-glyphs');
    expect(g.text).toBe('NET');
    expect(g.halign).toBe('left');
    expect(g.valign).toBe('bottom');
    expect(g.angle).toBe(0);
    // raised by textOffset + pen width above the anchor, extending to +x for spin RIGHT
    const dist = Math.round(0.15 * 1.27 * MM) + SCH_DEFAULTS.lineWidth;
    expect(g.pos).toEqual({ x: 10 * MM, y: 10 * MM - dist });
    for (const p of g.outline) expect(p.y).toBeLessThanOrEqual(10 * MM - dist + 1);
    for (const p of g.outline) expect(p.x).toBeGreaterThanOrEqual(10 * MM - 1);
    expect(boxContains(it.bbox, { x: 10 * MM, y: 10 * MM })).toBe(true);
    // vertical spin
    const [up] = schematicItemToRenderItems(localLabel('u', 0, 0, 'UP', 2));
    const gu = glyph(up!.prims[0]!);
    expect(gu.angle).toBe(90);
    for (const p of gu.outline) expect(p.y).toBeLessThanOrEqual(1);
  });

  test('global labels: one closed outline per shape with the anchor as a vertex, text centred inside', () => {
    const shapes = [1, 2, 3, 4, 5];
    for (const shape of shapes) {
      for (const spin of [1, 2, 3, 4] as Spin[]) {
        const [it] = schematicItemToRenderItems(globalLabel(`g${shape}${spin}`, 20, 20, 'SIG', shape, spin));
        expect(it!.layer).toBe(SCH_LAYERS.labelGlobal);
        const outline = poly(it!.prims[0]!);
        expect(outline.kind).toBe('polygon');
        expect(outline.fill).toBe(false);
        expect(outline.outline.length).toBe(6);
        expect(outline.width).toBe(SCH_DEFAULTS.lineWidth);
        expect(outline.outline.some((p) => near(p.x, 20 * MM) && near(p.y, 20 * MM))).toBe(true);
        // the flag extends away from the anchor in the spin direction
        for (const p of outline.outline) {
          if (spin === 3) expect(p.x).toBeGreaterThanOrEqual(20 * MM - 1);
          if (spin === 1) expect(p.x).toBeLessThanOrEqual(20 * MM + 1);
          if (spin === 2) expect(p.y).toBeLessThanOrEqual(20 * MM + 1);
          if (spin === 4) expect(p.y).toBeGreaterThanOrEqual(20 * MM - 1);
        }
        const g = glyph(it!.prims[1]!);
        expect(g.kind).toBe('text-glyphs');
        expect(g.valign).toBe('center');
        for (const p of g.outline) expect(boxContains(it!.bbox, p)).toBe(true);
      }
    }
    // input / bidi / tristate have a pointed tip: the vertex at the anchor is unique; output / passive have a flat side
    const tip = (shape: number) => poly(schematicItemToRenderItems(globalLabel('t', 0, 0, 'A', shape, 3))[0]!.prims[0]!).outline.filter((p) => near(p.x, 0) && near(p.y, 0)).length;
    expect(tip(1)).toBe(1);
    expect(tip(2)).toBe(1);
    expect(tip(5)).toBe(1);
  });

  test('hierarchical labels: template shapes filled with the sheet background plus outline and text', () => {
    for (const shape of [1, 2, 3, 4, 5]) {
      const items = schematicItemToRenderItems(hierLabel(`h${shape}`, 30, 30, 'H', shape, 3));
      expect(items.length).toBe(2);
      const [fill, main] = items;
      expect(fill!.id).toBe(`h${shape}@fill`);
      expect(fill!.color).toBe('schematic.background');
      expect(fill!.pickable).toBe(false);
      expect(fill!.layer).toBe(SCH_LAYERS.labelHier);
      expect(main!.layer).toBe(SCH_LAYERS.labelHier);
      const outline = poly(main!.prims[0]!);
      expect(outline.outline.length).toBe(shape === 1 || shape === 2 ? 5 : 4);
      const half = 1.27 * MM * 0.5;
      // every vertex sits on the half-text-height lattice around the anchor
      for (const p of outline.outline) {
        expect(near((p.x - 30 * MM) / half, Math.round((p.x - 30 * MM) / half), 1e-6)).toBe(true);
        expect(near((p.y - 30 * MM) / half, Math.round((p.y - 30 * MM) / half), 1e-6)).toBe(true);
      }
      // input / bidi / tristate templates start at the anchor; OUTPUT (TemplateOUT_HI = {2,0 ...}) and
      // UNSPC ({0,-1 ...}) do not touch it
      expect(outline.outline.some((p) => near(p.x, 30 * MM) && near(p.y, 30 * MM))).toBe(shape === 1 || shape === 3 || shape === 4);
      // output template (spin RIGHT / HI): {2,0 1,-1 0,-1 0,1 1,1}
      if (shape === 2) {
        expect(outline.outline.map((p) => [Math.round((p.x - 30 * MM) / half), Math.round((p.y - 30 * MM) / half)])).toEqual([
          [2, 0],
          [1, -1],
          [0, -1],
          [0, 1],
          [1, 1],
        ]);
      }
      // input template (spin RIGHT / HI): 6 points {0,0 1,1 2,1 2,-1 1,-1}
      if (shape === 1) {
        expect(outline.outline.map((p) => [Math.round((p.x - 30 * MM) / half), Math.round((p.y - 30 * MM) / half)])).toEqual([
          [0, 0],
          [1, 1],
          [2, 1],
          [2, -1],
          [1, -1],
        ]);
      }
      // text sits beyond the flag (offset = textOffset + text width) for spin RIGHT
      const g = glyph(main!.prims[1]!);
      expect(g.pos.x).toBe(30 * MM + Math.round(0.15 * 1.27 * MM) + 1.27 * MM);
      expect(g.halign).toBe('left');
    }
  });

  test('directive labels: circle / dot / diamond / rectangle flags on the netclass layer with their fields', () => {
    const circle = schematicItemToRenderItems(directiveLabel('dc', 0, 0, 7, 2));
    expect(circle[0]!.layer).toBe(SCH_LAYERS.netclassFlag);
    expect(circle[0]!.prims.some((p) => p.kind === 'circle' && !p.fill)).toBe(true);
    expect(circle[1]!.id).toBe('dc:field:Netclass');
    expect(circle[1]!.layer).toBe(SCH_LAYERS.netclassFlag);
    const dot = schematicItemToRenderItems(directiveLabel('dd', 0, 0, 6, 3));
    expect(dot[0]!.prims.some((p) => p.kind === 'circle' && p.fill)).toBe(true);
    // the flag template points +y and CreateGraphicShape rotates it per spin: RIGHT (KiCad's default
    // for a freshly placed directive label) = RotatePoint(180) -> the flag rises above the anchor,
    // UP = RotatePoint(-90) -> (x, y) -> (-y, x) -> the flag extends to the left, BOTTOM -> right, LEFT -> down
    const circleAt = (spin: Spin) => {
      const c = schematicItemToRenderItems(directiveLabel('d', 0, 0, 6, spin))[0]!.prims.find((p) => p.kind === 'circle')!;
      return c.kind === 'circle' ? c.c : { x: NaN, y: NaN };
    };
    expect(circleAt(3).y).toBeLessThan(0);
    expect(near(circleAt(3).x, 0)).toBe(true);
    expect(circleAt(2).x).toBeLessThan(0);
    expect(circleAt(4).x).toBeGreaterThan(0);
    expect(circleAt(1).y).toBeGreaterThan(0);
    // dot: circle centred at the pin length (pts[2]) with radius |pts[2] - pts[1]| = 0.7 * symbol size
    expect(near(circleAt(3).y, -2.54 * MM)).toBe(true);
    const dotPrim = dot[0]!.prims.find((p) => p.kind === 'circle')!;
    if (dotPrim.kind === 'circle') expect(dotPrim.r).toBe(Math.round(0.508 * MM * 0.7));
    const diamond = schematicItemToRenderItems(directiveLabel('dm', 0, 0, 8, 3));
    expect(poly(diamond[0]!.prims[0]!).outline.length).toBe(6);
    const rect = schematicItemToRenderItems(directiveLabel('dr', 0, 0, 9, 3));
    expect(poly(rect[0]!.prims[0]!).outline.length).toBe(7);
  });
});

describe('schematic adapter: symbols', () => {
  test('resistor: body outline + background fill, two pins with refs, fields, pickable body last', () => {
    const items = schematicItemToRenderItems(resistor('R1', 'R1', 50, 50));
    const byLayer = (l: string) => items.filter((i) => i.layer === l);
    for (const it of items) expect(it.owner).toBe('R1');
    const bg = byLayer(SCH_LAYERS.deviceBackground);
    expect(bg.length).toBe(1);
    expect(bg[0]!.pickable).toBe(false);
    expect(poly(bg[0]!.prims[0]!).fill).toBe(true);
    const body = byLayer(SCH_LAYERS.device).filter((i) => i.prims.length);
    expect(body.length).toBe(1);
    expect(poly(body[0]!.prims[0]!).width).toBe(0.254 * MM);
    const pins = byLayer(SCH_LAYERS.pin);
    expect(pins.length).toBe(2);
    expect(pins.map((p) => p.ref).sort()).toEqual(['R1:1', 'R1:2']);
    const p1 = pins.find((p) => p.ref === 'R1:1')!;
    expect(p1.id).toBe('R1@pin:R1-pin1');
    // pin 1 at (50, 46.19): points down into the body, root at y + 1.27
    const s = seg(p1.prims[0]!);
    expect(s.a).toEqual({ x: 50 * MM, y: 46.19 * MM + 1.27 * MM }); // root
    expect(s.b).toEqual({ x: 50 * MM, y: 46.19 * MM }); // connection point
    expect(s.width).toBe(SCH_DEFAULTS.lineWidth);
    const nums = byLayer(SCH_LAYERS.pinNumber);
    expect(nums.length).toBe(2);
    expect(nums[0]!.pickable).toBe(false);
    expect(byLayer(SCH_LAYERS.pinName).length).toBe(0); // names are '~'
    const refField = items.find((i) => i.id === 'R1:field:Reference')!;
    expect(refField.layer).toBe(SCH_LAYERS.reference);
    expect(glyph(refField.prims[0]!).text).toBe('R1');
    expect(items.find((i) => i.id === 'R1:field:Value')!.layer).toBe(SCH_LAYERS.value);
    expect(items.find((i) => i.id === 'R1:field:Footprint')).toBeUndefined(); // hidden
    const last = items[items.length - 1]!;
    expect(last.id).toBe('R1');
    expect(last.prims).toEqual([]);
    expect(boxContains(last.bbox, { x: 50 * MM, y: 46.19 * MM })).toBe(true);
    expect(boxContains(last.bbox, { x: 50 * MM, y: 50 * MM })).toBe(true);
    expect(items.some((i) => i.layer === SCH_LAYERS.dnpMarker)).toBe(false);
  });

  test('hidden pins and fields are skipped unless the context shows them', () => {
    const r = resistor('R', 'R', 0, 0);
    const def = (r.proto as { definition: { items: Array<{ item: { visible: boolean } }> } }).definition;
    def.items[1]!.item.visible = false;
    const items = schematicItemToRenderItems(r);
    expect(items.filter((i) => i.layer === SCH_LAYERS.pin).length).toBe(1);
    const shown = schematicItemToRenderItems(r, { showHiddenPins: true, showHiddenFields: true });
    expect(shown.filter((i) => i.layer === SCH_LAYERS.hidden && i.id.includes('@pin')).length).toBe(2); // pin line + number (name is '~')
    expect(shown.filter((i) => i.layer === SCH_LAYERS.pin).length).toBe(1);
    expect(shown.some((i) => i.id === 'R:field:Footprint' && i.layer === SCH_LAYERS.hidden)).toBe(true);
  });

  test('DNP symbol gets a cross over its body on the dnp_marker layer', () => {
    const items = schematicItemToRenderItems(resistor('R', 'R', 0, 0, { dnp: true }));
    const dnp = items.find((i) => i.layer === SCH_LAYERS.dnpMarker)!;
    expect(dnp).toBeDefined();
    expect(dnp.pickable).toBe(false);
    expect(dnp.prims.length).toBe(2);
    expect(seg(dnp.prims[0]!).width).toBe(SCH_DEFAULTS.dnpStroke);
    expect(boxContains(dnp.bbox, { x: 0, y: 0 })).toBe(true);
    expect(schematicItemToRenderItems(resistor('R', 'R', 0, 0, { dnp: true }), { showDnpMarkers: false }).some((i) => i.layer === SCH_LAYERS.dnpMarker)).toBe(false);
  });

  test('IC: pin names inside the body, decorations for inverted / clock pins, electrical types', () => {
    const items = schematicItemToRenderItems(ic('U1', 'U1', 0, 0));
    const names = items.filter((i) => i.layer === SCH_LAYERS.pinName);
    expect(names.map((n) => glyph(n.prims[0]!).text).sort()).toEqual(['CLK', 'GND', 'IN', '~{OUT}']);
    // pin 1 (IN, points right, at x = -7.62): name inside the body, left aligned, just past the root
    const nameIn = names.find((n) => glyph(n.prims[0]!).text === 'IN')!;
    const g = glyph(nameIn.prims[0]!);
    expect(g.halign).toBe('left');
    expect(g.pos.x).toBe(-7.62 * MM + 2.54 * MM + 0.508 * MM);
    expect(g.angle).toBe(0);
    // pin 4 (GND, points up at the bottom): vertical text reading upwards into the body;
    // transformTextForPin flips the alignment only for PIN_LEFT / PIN_DOWN
    const gnd = glyph(names.find((n) => glyph(n.prims[0]!).text === 'GND')!.prims[0]!);
    expect(gnd.angle).toBe(90);
    expect(gnd.halign).toBe('left');
    expect(gnd.pos).toEqual({ x: 0, y: 7.62 * MM - 2.54 * MM - 0.508 * MM });
    // pin 3 (~{OUT}, points left from the right side): flipped alignment, text extends left into the body
    const out = glyph(names.find((n) => glyph(n.prims[0]!).text === '~{OUT}')!.prims[0]!);
    expect(out.halign).toBe('right');
    expect(out.pos.x).toBe(7.62 * MM - 2.54 * MM - 0.508 * MM);
    // inverted output pin has a circle, clock pin a triangle (two extra segments)
    const p3 = items.find((i) => i.ref === 'U1:3')!;
    expect(p3.prims.some((p) => p.kind === 'circle')).toBe(true);
    const p2 = items.find((i) => i.ref === 'U1:2')!;
    expect(p2.prims.filter((p) => p.kind === 'segment').length).toBe(3);
    // numbers for horizontal pins sit above the pin line when names are inside
    const num1 = items.find((i) => i.id === 'U1@pin:U1-pin1:number')!;
    expect(glyph(num1.prims[0]!).pos.y).toBeLessThan(-2.54 * MM);
    expect(num1.ref).toBe('U1:1');
  });

  test('showPinNames / showPinNumbers flags and unit filtering', () => {
    const items = schematicItemToRenderItems(ic('U', 'U', 0, 0, { showPinNames: false, showPinNumbers: false }));
    expect(items.some((i) => i.layer === SCH_LAYERS.pinName || i.layer === SCH_LAYERS.pinNumber)).toBe(false);
    const r = resistor('R', 'R', 0, 0, { unit: 2 });
    const def = (r.proto as { definition: { items: Array<{ unit: { unit: number } }> } }).definition;
    def.items[1]!.unit = { unit: 1 }; // pin 1 belongs to unit 1 only
    const u2 = schematicItemToRenderItems(r);
    expect(u2.filter((i) => i.layer === SCH_LAYERS.pin).map((i) => i.ref)).toEqual(['R:2']);
  });

  test('Any children go through decodeAny; undecodable ones are skipped', () => {
    const r = resistor('R', 'R', 0, 0);
    const def = (r.proto as { definition: { items: Array<{ item: unknown }> } }).definition;
    const real = def.items.map((c) => c.item);
    def.items.forEach((c, i) => (c.item = { $typeName: 'google.protobuf.Any', typeUrl: `type.googleapis.com/x${i}`, value: new Uint8Array() }));
    expect(schematicItemToRenderItems(r).filter((i) => i.layer === SCH_LAYERS.pin).length).toBe(0);
    const decoded = schematicItemToRenderItems(r, { decodeAny: (any) => real[Number((any as { typeUrl: string }).typeUrl.slice(-1))] });
    expect(decoded.filter((i) => i.layer === SCH_LAYERS.pin).length).toBe(2);
    expect(schematicItemTypeOf({ type: 'KOT_SCH_PIN', proto: { number: '1' } })?.type).toBe('KOT_SCH_PIN');
    expect(schematicItemTypeOf({ proto: { $typeName: 'kiapi.schematic.types.SchematicPin' } })?.type).toBe('KOT_SCH_PIN');
  });
});

describe('schematic adapter: sheets, text, shapes', () => {
  test('sheet: background, border, name / file fields, two pins with direction shapes, body last', () => {
    const items = schematicItemToRenderItems(
      sheet('S1', 100, 100, 25.4, 20.32, 'Power', 'power.kicad_sch', [
        { name: 'VIN', side: 1, at: 5.08, shape: 1 },
        { name: 'VOUT', side: 2, at: 5.08, shape: 2 },
      ]),
    );
    expect(items.find((i) => i.id === 'S1@bg')!.layer).toBe(SCH_LAYERS.sheetBackground);
    const border = items.find((i) => i.id === 'S1@border')!;
    expect(border.layer).toBe(SCH_LAYERS.sheet);
    expect(poly(border.prims[0]!).width).toBe(SCH_DEFAULTS.lineWidth);
    expect(items.find((i) => i.id === 'S1:field:Sheetname')!.layer).toBe(SCH_LAYERS.sheetName);
    expect(items.find((i) => i.id === 'S1:field:Sheetfile')!.layer).toBe(SCH_LAYERS.sheetFilename);
    const pins = items.filter((i) => i.id.startsWith('S1:pin:') && !i.id.endsWith('@fill'));
    expect(pins.length).toBe(2);
    expect(pins.map((p) => p.ref)).toEqual(['S1-pin1', 'S1-pin2']);
    expect(pins.every((p) => p.layer === SCH_LAYERS.sheetLabel)).toBe(true);
    // VIN on the left edge: the flag points inwards (input drawn with the OUTPUT template), text inside the sheet
    const vin = pins[0]!;
    const outline = poly(vin.prims[0]!).outline;
    for (const p of outline) expect(p.x).toBeGreaterThanOrEqual(100 * MM - 1);
    expect(glyph(vin.prims[1]!).text).toBe('VIN');
    expect(glyph(vin.prims[1]!).pos.x).toBeGreaterThan(100 * MM);
    const vout = pins[1]!;
    for (const p of poly(vout.prims[0]!).outline) expect(p.x).toBeLessThanOrEqual(125.4 * MM + 1);
    expect(items.some((i) => i.id === 'S1:pin:S1-pin1@fill' && i.color === 'schematic.background')).toBe(true);
    const last = items[items.length - 1]!;
    expect(last.id).toBe('S1');
    expect(last.prims).toEqual([]);
    expect(last.bbox).toEqual({ x: 100 * MM, y: 100 * MM, w: 25.4 * MM, h: 20.32 * MM });
  });

  test('text and text boxes: multi-line glyph runs, server shapes take precedence', () => {
    const [t] = schematicItemToRenderItems(schText('t', 10, 10, 'line one\nline two', 2.54));
    expect(t!.layer).toBe(SCH_LAYERS.note);
    expect(t!.prims.length).toBe(2);
    const [l1, l2] = t!.prims.map(glyph);
    expect(l1!.text).toBe('line one');
    expect(l2!.pos.y).toBeGreaterThan(l1!.pos.y);
    expect(l1!.size).toEqual({ x: 2.54 * MM, y: 2.54 * MM });
    const [shaped] = schematicItemToRenderItems(schText('t', 10, 10, 'x'), { textShapes: (id) => (id === 't' ? [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]] : undefined) });
    expect(shaped!.prims).toEqual([{ kind: 'text-shapes', polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]] }]);
    const [boxed] = schematicItemToRenderItems(schText('t', 10, 10, 'x'), { textFallback: 'box' });
    expect(boxed!.prims[0]!.kind).toBe('polygon');
    expect(schematicItemToRenderItems(schText('t', 10, 10, 'x'), { textFallback: 'none' })).toEqual([]);
    const tb = schematicItemToRenderItems(textBox('tb', 0, 0, 30, 10, 'hello'));
    expect(tb.map((i) => i.id)).toEqual(['tb@bg', 'tb@border', 'tb']);
    expect(tb[0]!.color).toEqual({ r: 255, g: 255, b: 204, a: 1 });
    expect(tb[0]!.layer).toBe(SCH_LAYERS.noteBackground);
    const g = glyph(tb[2]!.prims[0]!);
    expect(g.pos).toEqual({ x: 0.5 * MM, y: 0.5 * MM }); // top-left inside the margins
    expect(g.halign).toBe('left');
    expect(g.valign).toBe('top');
  });

  test('images, groups and rule areas', () => {
    const [img] = schematicItemToRenderItems(schImage('img', 10, 20, 2));
    expect(img!.layer).toBe(SCH_LAYERS.bitmaps);
    expect(img!.pickable).toBeUndefined();
    const prim = img!.prims[0]!;
    expect(prim.kind).toBe('image');
    if (prim.kind === 'image') {
      expect(prim.c).toEqual({ x: 10 * MM, y: 20 * MM });
      expect(prim.w).toBeCloseTo(300 * (25.4e6 / 300) * 2, 3);
      expect(prim.h).toBeCloseTo(100 * (25.4e6 / 300) * 2, 3);
      expect(prim.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }
    // undecodable bytes: a placeholder square on the notes layer
    const [bad] = schematicItemToRenderItems(schImage('bad', 0, 0, 1, new Uint8Array([1, 2, 3])));
    expect(bad!.layer).toBe(SCH_LAYERS.note);
    expect(bad!.prims[0]!.kind).toBe('polygon');
    // groups: bbox-only pick target over their members, nothing without an itemBBox lookup
    expect(schematicItemToRenderItems(group('g', 'G', ['a', 'b']))).toEqual([]);
    const [grp] = schematicItemToRenderItems(group('g', 'G', ['a', 'b']), { itemBBox: (id) => (id === 'a' ? { x: 0, y: 0, w: 10, h: 10 } : { x: 20, y: 20, w: 5, h: 5 }) });
    expect(grp!.bbox).toEqual({ x: 0, y: 0, w: 25, h: 25 });
    expect(grp!.prims).toEqual([]);
    expect(grp!.layer).toBe(SCH_LAYERS.auxItems);
    // rule areas: outline on the rule-area layer
    const ra = schematicItemToRenderItems(
      ruleArea('ra', [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    );
    expect(ra.length).toBe(1);
    expect(ra[0]!.layer).toBe(SCH_LAYERS.ruleArea);
    expect(poly(ra[0]!.prims[0]!).outline.length).toBe(4);
    expect(poly(ra[0]!.prims[0]!).fill).toBe(false);
    expect(poly(ra[0]!.prims[0]!).width).toBe(SCH_DEFAULTS.lineWidth);
  });

  test('colour helper and the whole synthetic sheet', () => {
    expect(colorOf(undefined)).toBeUndefined();
    expect(colorOf({ r: 0, g: 0, b: 0, a: 0 })).toBeUndefined();
    expect(colorOf({ r: 0.5, g: 1, b: 0, a: 0.5 })).toEqual({ r: 128, g: 255, b: 0, a: 0.5 });
    const all: RenderItem[] = syntheticSchematic().flatMap((it) => schematicItemToRenderItems(it));
    expect(all.length).toBeGreaterThan(80);
    const layers = new Set(all.map((i) => i.layer));
    for (const l of [SCH_LAYERS.wire, SCH_LAYERS.bus, SCH_LAYERS.junction, SCH_LAYERS.labelLocal, SCH_LAYERS.labelGlobal, SCH_LAYERS.labelHier, SCH_LAYERS.netclassFlag, SCH_LAYERS.sheet, SCH_LAYERS.sheetLabel, SCH_LAYERS.pin, SCH_LAYERS.pinName, SCH_LAYERS.pinNumber, SCH_LAYERS.reference, SCH_LAYERS.value, SCH_LAYERS.device, SCH_LAYERS.deviceBackground, SCH_LAYERS.noConnect, SCH_LAYERS.note, SCH_LAYERS.noteBackground, SCH_LAYERS.ruleArea, SCH_LAYERS.dnpMarker]) {
      expect(layers.has(l)).toBe(true);
    }
    for (const l of layers) expect(SCHEMATIC_DRAW_ORDER.includes(l)).toBe(true);
    const ids = all.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // unique render ids
  });
});

describe('schematic layers and theme', () => {
  test('every schematic layer id is a colour key in the built-in themes', () => {
    for (const l of SCHEMATIC_THEME_LAYERS) {
      expect(KICAD_DEFAULT_THEME.colors[l]).toBeDefined();
      expect(KICAD_CLASSIC_THEME.colors[l]).toBeDefined();
    }
    expect(SCHEMATIC_DRAW_ORDER.length).toBe(SCHEMATIC_THEME_LAYERS.length + 1); // + the bitmap pseudo layer
    expect(new Set(SCHEMATIC_DRAW_ORDER).size).toBe(SCHEMATIC_DRAW_ORDER.length);
  });

  test('draw order follows eeschema: backgrounds < sheets < symbols < wires < labels < junctions < fields', () => {
    const idx = (l: string) => SCHEMATIC_DRAW_ORDER.indexOf(l);
    expect(idx(SCH_LAYERS.deviceBackground)).toBeLessThan(idx(SCH_LAYERS.sheet));
    expect(idx(SCH_LAYERS.sheet)).toBeLessThan(idx(SCH_LAYERS.device));
    expect(idx(SCH_LAYERS.device)).toBeLessThan(idx(SCH_LAYERS.pin));
    expect(idx(SCH_LAYERS.pin)).toBeLessThan(idx(SCH_LAYERS.wire));
    expect(idx(SCH_LAYERS.bus)).toBeLessThan(idx(SCH_LAYERS.wire));
    expect(idx(SCH_LAYERS.wire)).toBeLessThan(idx(SCH_LAYERS.labelLocal));
    expect(idx(SCH_LAYERS.labelHier)).toBeLessThan(idx(SCH_LAYERS.junction));
    expect(idx(SCH_LAYERS.junction)).toBeLessThan(idx(SCH_LAYERS.pinNumber));
    expect(idx(SCH_LAYERS.pinNumber)).toBeLessThan(idx(SCH_LAYERS.reference));
    expect(idx(SCH_LAYERS.reference)).toBeLessThan(idx(SCH_LAYERS.dnpMarker));
    expect(MIL).toBe(25_400);
  });
});
