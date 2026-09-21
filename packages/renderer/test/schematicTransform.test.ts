import { describe, expect, test } from 'bun:test';
import {
  pinDrawOrientation,
  symbolTransform,
  transformCoordinate,
  transformDet,
  transformTextGlyphs,
  inverseTransform,
  composeTransform,
  IDENTITY_TRANSFORM,
} from '../src/schematic/symbolTransform.js';
import { textGlyphPrims } from '../src/schematic/textMetrics.js';
import { schematicItemToRenderItems } from '../src/schematic/schematicAdapter.js';
import { SCH_DEFAULTS, SCH_LAYERS } from '../src/schematic/schematicLayers.js';
import { MM, kicadTransformPoint, resistor } from './schematicFixtures.js';
import type { Primitive } from '../src/core/model.js';

const T = (p: { x: number; y: number }, t: ReturnType<typeof symbolTransform>) => transformCoordinate(t, p);
const seg = (p: Primitive) => p as Extract<Primitive, { kind: 'segment' }>;
const glyph = (p: Primitive) => p as Extract<Primitive, { kind: 'text-glyphs' }>;

describe('symbol transform (SCH_SYMBOL::SetOrientation / TRANSFORM)', () => {
  test('orientation 0 / 90 / 180 / 270 map a library point like KiCad (90 = counter-clockwise on screen)', () => {
    const p = { x: 100, y: 30 };
    expect(T(p, symbolTransform(0))).toEqual({ x: 100, y: 30 });
    expect(T(p, symbolTransform(90))).toEqual({ x: 30, y: -100 }); // (x, y) -> (y, -x)
    expect(T(p, symbolTransform(180))).toEqual({ x: -100, y: -30 });
    expect(T(p, symbolTransform(270))).toEqual({ x: -30, y: 100 }); // (x, y) -> (-y, x)
    // a pin on the right of the body (pointing left) ends up on top after a 90° rotation
    expect(T({ x: 1, y: 0 }, symbolTransform(90))).toEqual({ x: 0, y: -1 });
    // enum values and names
    expect(symbolTransform(2)).toEqual(symbolTransform(90));
    expect(symbolTransform('SSO_270')).toEqual(symbolTransform(270));
    expect(symbolTransform(1)).toEqual({ ...IDENTITY_TRANSFORM });
  });

  test('mirror X flips y, mirror Y flips x, mirrors apply after the rotation', () => {
    const p = { x: 100, y: 30 };
    expect(T(p, symbolTransform(0, true, false))).toEqual({ x: 100, y: -30 });
    expect(T(p, symbolTransform(0, false, true))).toEqual({ x: -100, y: 30 });
    expect(T(p, symbolTransform(0, true, true))).toEqual({ x: -100, y: -30 });
    // 90 + mirror X: rotate (x,y)->(y,-x) then y -> -y: (y, x)
    expect(T(p, symbolTransform(90, true, false))).toEqual({ x: 30, y: 100 });
    expect(T(p, symbolTransform(90, false, true))).toEqual({ x: -30, y: -100 });
    expect(T(p, symbolTransform(270, true, false))).toEqual({ x: -30, y: -100 });
    expect(transformDet(symbolTransform(90))).toBe(1);
    expect(transformDet(symbolTransform(90, true))).toBe(-1);
    // matches the fixture's independent formulation for every combination
    for (const o of [1, 2, 3, 4]) {
      for (const mx of [false, true]) {
        for (const my of [false, true]) {
          const [x, y] = kicadTransformPoint(7, 3, o, mx, my);
          expect(T({ x: 7, y: 3 }, symbolTransform(o, mx, my))).toEqual({ x, y });
        }
      }
    }
    const t = symbolTransform(90, true, false);
    expect(T(T(p, t), inverseTransform(t))).toEqual(p);
    expect(composeTransform(IDENTITY_TRANSFORM, t)).toEqual(t);
  });

  test('pin draw orientation follows the transform (SCH_PIN::PinDrawOrient)', () => {
    expect(pinDrawOrientation('right', symbolTransform(0))).toBe('right');
    expect(pinDrawOrientation('right', symbolTransform(90))).toBe('up');
    expect(pinDrawOrientation('right', symbolTransform(180))).toBe('left');
    expect(pinDrawOrientation('right', symbolTransform(270))).toBe('down');
    expect(pinDrawOrientation('down', symbolTransform(90))).toBe('right');
    expect(pinDrawOrientation('up', symbolTransform(0, true))).toBe('down');
    expect(pinDrawOrientation('left', symbolTransform(0, false, true))).toBe('right');
    expect(pinDrawOrientation('up', symbolTransform(0, false, true))).toBe('up');
  });

  test('text through a transform stays readable: mirrors and 180° become justification flips', () => {
    const [g] = textGlyphPrims(
      'R1',
      { x: 10, y: 0 },
      { size: { x: 100, y: 100 }, thickness: 10, angle: 0, halign: 'left', valign: 'bottom' },
    );
    const r180 = transformTextGlyphs(g!, symbolTransform(180), { x: 0, y: 0 });
    expect(r180.angle).toBe(0);
    expect(r180.halign).toBe('right');
    expect(r180.valign).toBe('top');
    expect(r180.pos).toEqual({ x: -10, y: 0 });
    const r90 = transformTextGlyphs(g!, symbolTransform(90), { x: 0, y: 0 });
    expect(r90.angle).toBe(90);
    expect(r90.halign).toBe('left');
    expect(r90.valign).toBe('bottom');
    const r270 = transformTextGlyphs(g!, symbolTransform(270), { x: 0, y: 0 });
    expect(r270.angle).toBe(90);
    expect(r270.halign).toBe('right');
    expect(r270.valign).toBe('top');
    const my = transformTextGlyphs(g!, symbolTransform(0, false, true), { x: 0, y: 0 });
    expect(my.angle).toBe(0);
    expect(my.halign).toBe('right');
    expect(my.valign).toBe('bottom');
    const mx = transformTextGlyphs(g!, symbolTransform(0, true, false), { x: 0, y: 0 });
    expect(mx.angle).toBe(0);
    expect(mx.halign).toBe('left');
    expect(mx.valign).toBe('top');
    // the glyph box keeps its size and is re-justified around the new anchor
    expect(my.outline.length).toBe(4);
    expect(Math.min(...my.outline.map((p) => p.x))).toBeLessThan(-10);
    expect(Math.max(...my.outline.map((p) => p.x))).toBeCloseTo(-10, 6);
  });

  test('a rotated resistor (library-relative pins) lands where KiCad puts it', () => {
    // 90°: pin 1 (lib (0, -3.81), pointing down) -> (-3.81, 0) pointing right; root 1.27 further right
    const items = schematicItemToRenderItems(resistor('R', 'R', 10, 10, { orientation: 2 }), {
      symbolPinsAbsolute: false,
    });
    const p1 = items.find((i) => i.ref === 'R:1')!;
    const s = seg(p1.prims[0]!);
    expect(s.b).toEqual({ x: 10 * MM - 3.81 * MM, y: 10 * MM });
    expect(s.a).toEqual({ x: 10 * MM - 3.81 * MM + 1.27 * MM, y: 10 * MM });
    const num = glyph(items.find((i) => i.id === 'R@pin:R-pin1:number')!.prims[0]!);
    expect(num.angle).toBe(0); // horizontal pin now
    expect(num.pos.x).toBe(10 * MM - 3.81 * MM + 0.635 * MM); // centred on the pin line
    // body rect rotated: 2.032 wide x 5.08 tall becomes 5.08 wide
    const body = items.find((i) => i.layer === SCH_LAYERS.device && i.prims.length)!;
    expect(body.bbox.w).toBeCloseTo(5.08 * MM + 0.254 * MM, -3);
    expect(body.bbox.h).toBeCloseTo(2.032 * MM + 0.254 * MM, -3);
    // the reference field (at +2.54, -1.27 from the symbol) rotates with it and turns vertical;
    // its anchor is shifted along the reading direction (here: up) by the closed-form
    // δ = round(1.5 · size/8) − trunc(lineWidth / 1.52) that turns KiCad's bbox-centred draw
    // into a left-justified one (symbolFieldPlacement)
    const ref = glyph(items.find((i) => i.id === 'R:field:Reference')!.prims[0]!);
    expect(ref.angle).toBe(90);
    expect(ref.halign).toBe('left');
    const delta = Math.round(1.5 * Math.round((1.27 * MM) / 8)) - Math.trunc(SCH_DEFAULTS.lineWidth / 1.52);
    expect(ref.pos).toEqual({ x: 10 * MM - 1.27 * MM, y: 10 * MM - 2.54 * MM - delta });
    // absolute pins (API semantics) give the same geometry
    const abs = schematicItemToRenderItems(resistor('R', 'R', 10, 10, { orientation: 2 }));
    expect(seg(abs.find((i) => i.ref === 'R:1')!.prims[0]!)).toEqual(s);
  });

  test('mirrored resistor (mirror Y): pins swap sides in x, text stays readable', () => {
    const items = schematicItemToRenderItems(resistor('R', 'R', 0, 0, { orientation: 2, mirrorY: true }));
    const p1 = seg(items.find((i) => i.ref === 'R:1')!.prims[0]!);
    expect(p1.b).toEqual({ x: 3.81 * MM, y: 0 });
    expect(p1.a).toEqual({ x: 3.81 * MM - 1.27 * MM, y: 0 }); // root towards the body (pin now points left)
    const ref = glyph(items.find((i) => i.id === 'R:field:Reference')!.prims[0]!);
    expect(ref.angle === 0 || ref.angle === 90).toBe(true);
    expect(ref.mirrored).toBeFalsy();
  });
});
