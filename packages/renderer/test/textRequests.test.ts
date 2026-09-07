import { describe, expect, test } from 'bun:test';
import { type RequestText, type SchTextRequest, resolveTextRequests, schematicTextRequests } from '../src/schematic/textRequests.js';
import { schematicItemToRenderItems, subReference } from '../src/schematic/schematicAdapter.js';
import { SCH_DEFAULTS } from '../src/schematic/schematicLayers.js';
import { MM, globalLabel, ic, localLabel, resistor, schText, sheet, syntheticSchematic, symbol, textBox } from './schematicFixtures.js';
import type { StoredItemLike } from '../src/core/host.js';

const n = (v: bigint | number | undefined): number => Number(v ?? 0);
const at = (r: SchTextRequest): { x: number; y: number; angle: number; h: number; v: number; text: string; pen: number; size: number } => {
  const t = r.text!;
  return { x: n(t.position.xNm), y: n(t.position.yNm), angle: t.attributes.angle.valueDegrees, h: t.attributes.horizontalAlignment, v: t.attributes.verticalAlignment, text: t.text, pen: n(t.attributes.strokeWidth.valueNm), size: n(t.attributes.size.xNm) };
};
const byKey = (reqs: SchTextRequest[], key: string): SchTextRequest => {
  const r = reqs.find((q) => q.key === key);
  if (!r) throw new Error(`no request ${key}; have ${reqs.map((q) => q.key).join(', ')}`);
  return r;
};

/** name_offset == num_offset of SCH_PIN::PlotPinTexts: text offset (24 mil × ratio) + PIN_TEXT_MARGIN + default pen */
const PIN_OFF = Math.round(24 * SCH_DEFAULTS.textOffsetRatio) * 25400 + SCH_DEFAULTS.pinTextMargin + SCH_DEFAULTS.lineWidth;
/** symbolFieldPlacement's δ for a 1.27 mm field with no stored width: round(1.5 · size/8) − trunc(lineWidth / 1.52) */
const DELTA = Math.round(1.5 * Math.round((1.27 * MM) / 8)) - Math.trunc(SCH_DEFAULTS.lineWidth / 1.52);

describe('schematic text requests: pins', () => {
  test('pin numbers of a resistor in all four orientations sit where SCH_PIN::PlotPinTexts plots them', () => {
    expect(PIN_OFF).toBe(355600);
    // pin 1 (lib (0, -3.81), pointing down, 1.27 long) after each SCH_SYMBOL orientation:
    // connection point, root, and the number anchor: vertical pins -> (x1 − off, mid y) at 90°,
    // horizontal pins -> (mid x, y1 − off) at 0°, centred / bottom-justified (number only: names hidden)
    const cases: Array<{ orientation: number; pos: [number, number]; root: [number, number]; anchor: [number, number]; angle: number }> = [
      { orientation: 1, pos: [10, 6.19], root: [10, 7.46], anchor: [10 * MM - PIN_OFF, 6.825 * MM], angle: 90 },
      { orientation: 2, pos: [6.19, 10], root: [7.46, 10], anchor: [6.825 * MM, 10 * MM - PIN_OFF], angle: 0 },
      { orientation: 3, pos: [10, 13.81], root: [10, 12.54], anchor: [10 * MM - PIN_OFF, 13.175 * MM], angle: 90 },
      { orientation: 4, pos: [13.81, 10], root: [12.54, 10], anchor: [13.175 * MM, 10 * MM - PIN_OFF], angle: 0 },
    ];
    for (const c of cases) {
      const reqs = schematicTextRequests(resistor('R', 'R1', 10, 10, { orientation: c.orientation }), { symbolPinsAbsolute: true });
      const num = at(byKey(reqs, 'R:pin:R-pin1:number'));
      expect(num.text).toBe('1');
      expect([num.x, num.y]).toEqual([Math.round(c.anchor[0]), Math.round(c.anchor[1])]);
      expect(num.angle).toBe(c.angle);
      expect(num.h).toBe(2); // centre
      expect(num.v).toBe(3); // bottom: the glyphs sit on the far side of the anchor from the pin
      expect(num.pen).toBe(SCH_DEFAULTS.lineWidth);
      expect(num.size).toBe(1.27 * MM);
      // no name request: the resistor's pin names are `~`
      expect(reqs.some((r) => r.key.endsWith(':name'))).toBe(false);
    }
  });

  test('names inside the body (pin_name_offset > 0): left / right / vertical, numbers above the pin', () => {
    const reqs = schematicTextRequests(ic('U', 'U1', 0, 0), { symbolPinsAbsolute: true });
    // pin 1 IN: PIN_RIGHT at (-7.62, -2.54), root at (-5.08, -2.54)
    const inName = at(byKey(reqs, 'U:pin:U-pin1:name'));
    expect(inName).toMatchObject({ text: 'IN', x: -5.08 * MM + 0.508 * MM, y: -2.54 * MM, angle: 0, h: 1, v: 2 });
    const inNum = at(byKey(reqs, 'U:pin:U-pin1:number'));
    expect(inNum).toMatchObject({ text: '1', x: -6.35 * MM, y: -2.54 * MM - PIN_OFF, angle: 0, h: 2, v: 3 });
    // pin 3 ~{OUT}: PIN_LEFT at (7.62, -2.54), root (5.08, -2.54): right-justified inside
    expect(at(byKey(reqs, 'U:pin:U-pin3:name'))).toMatchObject({ text: '~{OUT}', x: 5.08 * MM - 0.508 * MM, y: -2.54 * MM, angle: 0, h: 3, v: 2 });
    // pin 4 GND: PIN_UP at (0, 7.62), root (0, 5.08): vertical, left-justified, number to the left
    expect(at(byKey(reqs, 'U:pin:U-pin4:name'))).toMatchObject({ text: 'GND', x: 0, y: 5.08 * MM - 0.508 * MM, angle: 90, h: 1, v: 2 });
    expect(at(byKey(reqs, 'U:pin:U-pin4:number'))).toMatchObject({ text: '4', x: -PIN_OFF, y: 6.35 * MM, angle: 90, h: 2, v: 3 });
  });

  test('names outside (offset 0) with numbers: name above, number below the pin; hidden pins and alternates', () => {
    const item = symbol('S', 'S1', 'X', 0, 0, [], [{ number: '7', name: 'CLK', x: -5.08, y: 0, orientation: 1 }, { number: '8', name: 'NC', x: 5.08, y: 0, orientation: 2, visible: false }]);
    const reqs = schematicTextRequests(item, { symbolPinsAbsolute: true });
    // PIN_RIGHT at (-5.08, 0), root (-2.54, 0), mid x = -3.81
    expect(at(byKey(reqs, 'S:pin:S-pin1:name'))).toMatchObject({ text: 'CLK', x: -3.81 * MM, y: -PIN_OFF, angle: 0, h: 2, v: 3 });
    expect(at(byKey(reqs, 'S:pin:S-pin1:number'))).toMatchObject({ text: '7', x: -3.81 * MM, y: PIN_OFF, angle: 0, h: 2, v: 1 });
    expect(reqs.some((r) => r.key.includes('S-pin2'))).toBe(false);
    expect(schematicTextRequests(item, { symbolPinsAbsolute: true, showHiddenPins: true }).some((r) => r.key === 'S:pin:S-pin2:name')).toBe(true);
    // an active alternate replaces the shown name
    const p = item.proto as { definition: { items: Array<{ item: Record<string, unknown> }> } };
    const pin = p.definition.items[0]!.item;
    pin.alternates = [{ name: 'ALT_FN', shape: 2, electricalType: 1 }];
    pin.activeAlternate = 'ALT_FN';
    expect(at(byKey(schematicTextRequests(item, { symbolPinsAbsolute: true }), 'S:pin:S-pin1:name')).text).toBe('ALT_FN');
  });
});

describe('schematic text requests: symbol fields', () => {
  test('a left-justified, vertically centred field is exact without measuring: anchor shifted by δ along the reading direction', () => {
    expect(DELTA).toBe(137862);
    const reqs = schematicTextRequests(resistor('R', 'R1', 10, 10), { symbolPinsAbsolute: true });
    const ref = byKey(reqs, 'R:field:Reference');
    expect(ref.measure).toBeUndefined();
    // stored at (12.54, 8.73): the reading direction is +x, so the anchor moves right by δ
    expect(at(ref)).toMatchObject({ text: 'R1', x: 12.54 * MM + DELTA, y: 8.73 * MM, angle: 0, h: 1, v: 2 });
    // hidden footprint / datasheet fields make no request unless hidden fields are shown
    expect(reqs.some((r) => r.key === 'R:field:Footprint')).toBe(false);
    expect(schematicTextRequests(resistor('R', 'R1', 10, 10), { symbolPinsAbsolute: true, showHiddenFields: true }).some((r) => r.key === 'R:field:Footprint')).toBe(true);
  });

  test('rotated symbol: the field turns vertical and δ points up; mirrored symbol: justification flips', () => {
    const rot = at(byKey(schematicTextRequests(resistor('R', 'R1', 10, 10, { orientation: 2 }), { symbolPinsAbsolute: true }), 'R:field:Reference'));
    expect(rot).toMatchObject({ x: 8.73 * MM, y: 7.46 * MM - DELTA, angle: 90, h: 1, v: 2 });
    // mirror Y (x -> -x): the reading direction is reversed, so a left-justified field is drawn right-justified, δ to the left
    const my = at(byKey(schematicTextRequests(resistor('R', 'R1', 0, 0, { mirrorY: true }), { symbolPinsAbsolute: true }), 'R:field:Reference'));
    expect(my).toMatchObject({ x: -2.54 * MM - DELTA, y: -1.27 * MM, angle: 0, h: 3, v: 2 });
    // mirror X (y -> -y): reading direction kept, position mirrored
    const mx = at(byKey(schematicTextRequests(resistor('R', 'R1', 0, 0, { mirrorX: true }), { symbolPinsAbsolute: true }), 'R:field:Reference'));
    expect(mx).toMatchObject({ x: 2.54 * MM + DELTA, y: 1.27 * MM, angle: 0, h: 1, v: 2 });
  });

  test('multi-unit references carry LIB_SYMBOL::SubReference: U2 -> U2B for unit 2', () => {
    expect([1, 2, 26, 27, 52, 53].map((u) => subReference(u))).toEqual(['A', 'B', 'Z', 'AA', 'AZ', 'BA']);
    expect(subReference(3, '1', '.')).toBe('.3');
    const item = resistor('R', 'U2', 0, 0);
    const p = item.proto as { unit: { unit: number }; definition: { unitCount: number } };
    p.unit.unit = 2;
    p.definition.unitCount = 4;
    expect(at(byKey(schematicTextRequests(item, { symbolPinsAbsolute: true }), 'R:field:Reference')).text).toBe('U2B');
    expect(at(byKey(schematicTextRequests(item, { symbolPinsAbsolute: true, subpartFirstId: '1', subpartIdSeparator: '.' }), 'R:field:Reference')).text).toBe('U2.2');
  });

  test('a top-justified field is measured first: GetTextExtents box centre through the transform, drawn centred', async () => {
    const item = resistor('R', 'R1', 10, 10, { orientation: 2 });
    const p = item.proto as { referenceField: { text: { attributes: Record<string, unknown>; position: { xNm: bigint; yNm: bigint } } } };
    p.referenceField.text.attributes.verticalAlignment = 1;
    const reqs = schematicTextRequests(item, { symbolPinsAbsolute: true });
    const ref = byKey(reqs, 'R:field:Reference');
    expect(ref.text).toBeUndefined();
    expect(ref.measure).toBeDefined();
    // the measure request is the field as stored (position, justification, angle, stored pen width)
    expect(at({ ...ref, text: ref.measure } as SchTextRequest)).toMatchObject({ x: 12.54 * MM, y: 8.73 * MM, angle: 0, h: 1, v: 1, pen: 0 });
    const asked: RequestText[] = [];
    const ready = await resolveTextRequests(reqs, async (t) => {
      asked.push(t);
      return { x: n(t.position.xNm), y: n(t.position.yNm) - 2 * MM, w: 4 * MM, h: 2 * MM };
    });
    expect(asked.length).toBe(1);
    expect(ready.length).toBe(reqs.length);
    // box centre (14.54, 7.73) relative to the stored position (12.54, 8.73) = (+2, −1); through the
    // 90° transform (x, y) -> (y, −x): (−1, −2); from the transformed position (8.73, 7.46) -> (7.73, 5.46)
    expect(at(ref)).toMatchObject({ x: 7.73 * MM, y: 5.46 * MM, angle: 90, h: 2, v: 2 });
  });
});

describe('schematic text requests: labels, sheets, text', () => {
  test('rotated local label: text at the label position plus GetSchematicTextOffset, spin-style angle / justification', () => {
    const up = at(byKey(schematicTextRequests(localLabel('L', 5, 5, 'NET', 2)), 'L'));
    const dist = Math.round(0.15 * 1.27 * MM) + SCH_DEFAULTS.lineWidth;
    expect(up).toMatchObject({ text: 'NET', x: 5 * MM - dist, y: 5 * MM, angle: 90, h: 1, v: 3, pen: SCH_DEFAULTS.lineWidth });
    const right = at(byKey(schematicTextRequests(localLabel('L', 5, 5, 'NET', 3)), 'L'));
    expect(right).toMatchObject({ x: 5 * MM, y: 5 * MM - dist, angle: 0, h: 1, v: 3 });
    // global label spun left: text right-justified inside the flag, centred on the "E" line
    const g = at(byKey(schematicTextRequests(globalLabel('G', 5, 5, 'IN', 1, 1)), 'G'));
    expect(g).toMatchObject({ x: 5 * MM - 1428750, y: 5 * MM + 90805, angle: 0, h: 3, v: 2 });
  });

  test('sheet: name / File: file fields, pins as hierarchical labels with ${field} resolved from the sheet', () => {
    const reqs = schematicTextRequests(sheet('S', 0, 0, 20, 10, 'Sub', 'sub.kicad_sch', [{ name: '${Sheetname}', side: 1, at: 5 }]));
    expect(at(byKey(reqs, 'S:field:Sheetname')).text).toBe('Sub');
    expect(at(byKey(reqs, 'S:field:Sheetfile')).text).toBe('File: sub.kicad_sch');
    const pin = at(byKey(reqs, 'S:pin:S-pin1'));
    expect(pin).toMatchObject({ text: 'Sub', x: Math.round(0.15 * 1.27 * MM) + 1.27 * MM, y: 5 * MM, angle: 0, h: 1, v: 2 });
  });

  test('plain text is raised by the KiCad-6 fudge; text boxes carry their margins and the plotter pen', () => {
    expect(at(byKey(schematicTextRequests(schText('T', 3, 4, 'hi')), 'T'))).toMatchObject({ x: 3 * MM, y: 4 * MM - 250_000 });
    const tb = byKey(schematicTextRequests(textBox('B', 0, 0, 10, 5, 'hello')), 'B').textbox as Record<string, { valueNm?: bigint; xNm?: bigint }>;
    expect(n(tb.marginLeft!.valueNm)).toBe(0.5 * MM);
    expect(n(tb.bottomRight!.xNm)).toBe(10 * MM);
    expect(n((tb.attributes as unknown as { strokeWidth: { valueNm: bigint } }).strokeWidth.valueNm)).toBe(SCH_DEFAULTS.lineWidth);
    expect('$typeName' in tb).toBe(false);
  });

  test('hashes follow the content; every request key is a key the adapter looks up', () => {
    const a = schematicTextRequests(resistor('R', 'R1', 10, 10), { symbolPinsAbsolute: true });
    const b = schematicTextRequests(resistor('R', 'R1', 10, 10), { symbolPinsAbsolute: true });
    const moved = schematicTextRequests(resistor('R', 'R1', 11, 10), { symbolPinsAbsolute: true });
    expect(a.map((r) => r.hash)).toEqual(b.map((r) => r.hash));
    expect(a.map((r) => r.hash)).not.toEqual(moved.map((r) => r.hash));
    const items: StoredItemLike[] = syntheticSchematic();
    for (const item of items) {
      const seen = new Set<string>();
      schematicItemToRenderItems(item, { symbolPinsAbsolute: true, textShapes: (k) => (seen.add(k), undefined) });
      for (const r of schematicTextRequests(item, { symbolPinsAbsolute: true })) expect(seen.has(r.key)).toBe(true);
    }
  });
});
