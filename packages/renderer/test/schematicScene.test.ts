/**
 * Headless picking, scene building and host store switching for schematics.
 */
import { describe, expect, test } from 'bun:test';
import { Picker } from '../src/core/picker.js';
import { Scene } from '../src/core/scene.js';
import { KICAD_DEFAULT_THEME } from '../src/core/theme.js';
import { boxOfPrimitive, type Primitive, type RenderItem } from '../src/core/model.js';
import { distanceToPrimitive } from '../src/core/geometry.js';
import { schematicItemToRenderItems } from '../src/schematic/schematicAdapter.js';
import { SCHEMATIC_DRAW_ORDER, SCH_LAYERS } from '../src/schematic/schematicLayers.js';
import { SchematicCanvasHost } from '../src/schematic/SchematicCanvasHost.js';
import { createTextGlyphBuilder } from '../src/schematic/textGlyphs.js';
import { MemoryStore, MM, globalLabel, ic, localLabel, resistor, syntheticSchematic, syntheticSubSheet, wire } from './schematicFixtures.js';

function pickerFor(items: RenderItem[]): Picker {
  return new Picker(() => items);
}

describe('schematic picking', () => {
  test('pins are picked at their connection point and return <symbol>:<pin number>', () => {
    const items = [...schematicItemToRenderItems(resistor('R1', 'R1', 50, 50)), ...schematicItemToRenderItems(wire('w', 50, 46.19, 50, 40))];
    const picker = pickerFor(items);
    const hits = picker.pick({ x: 50 * MM, y: 46.19 * MM }, 0.1 * MM);
    expect(hits.length).toBeGreaterThan(0);
    const pin = hits.find((h) => h.id.includes('@pin:'))!;
    expect(pin.ref).toBe('R1:1');
    expect(pin.owner).toBe('R1');
    expect(pin.layer).toBe(SCH_LAYERS.pin);
    expect(pin.distance).toBe(0);
    // the wire ends there too; the symbol body (bbox only) sorts after the pin
    expect(hits.some((h) => h.id === 'w')).toBe(true);
    const bodyIdx = hits.findIndex((h) => h.id === 'R1');
    expect(bodyIdx).toBeGreaterThan(hits.indexOf(pin));
    // inside the body but off any outline: only the body
    const inside = picker.pick({ x: 50 * MM, y: 50 * MM }, 0.05 * MM).filter((h) => h.item.prims.length || h.id === 'R1');
    expect(inside.map((h) => h.id)).toContain('R1');
    expect(inside.some((h) => h.id.includes('@pin:'))).toBe(false);
    // pin texts are decorations and never picked
    const numPos = (items.find((i) => i.id === 'R1@pin:R1-pin1:number')!.prims[0] as Extract<Primitive, { kind: 'text-glyphs' }>).pos;
    expect(picker.pick(numPos, 0.01 * MM).some((h) => h.id.endsWith(':number'))).toBe(false);
  });

  test('labels are picked through their text-glyph boxes and flag outlines', () => {
    const items = [...schematicItemToRenderItems(localLabel('lbl', 10, 10, 'NET_A', 3)), ...schematicItemToRenderItems(globalLabel('gl', 30, 30, 'IN', 1, 1))];
    const picker = pickerFor(items);
    const g = items[0]!.prims[0] as Extract<Primitive, { kind: 'text-glyphs' }>;
    const centre = { x: (g.outline[0]!.x + g.outline[2]!.x) / 2, y: (g.outline[0]!.y + g.outline[2]!.y) / 2 };
    expect(distanceToPrimitive(centre, g)).toBe(0);
    expect(boxOfPrimitive(g).w).toBeGreaterThan(0);
    const hits = picker.pick(centre, 0.01 * MM);
    expect(hits[0]!.id).toBe('lbl');
    // global label: click on the flag outline far from the text
    const outline = (items.find((i) => i.id === 'gl')!.prims[0] as Extract<Primitive, { kind: 'polygon' }>).outline;
    const tip = outline.find((p) => Math.abs(p.x - 30 * MM) < 1 && Math.abs(p.y - 30 * MM) < 1)!;
    expect(picker.pick(tip, 0.05 * MM)[0]!.ref).toBe('gl');
    // nothing far away
    expect(picker.pick({ x: 0, y: 0 }, 0.5 * MM)).toEqual([]);
  });

  test('IC pins with names and decorations are all pickable by ref', () => {
    const items = schematicItemToRenderItems(ic('U1', 'U1', 0, 0));
    const picker = pickerFor(items);
    expect(picker.pick({ x: -7.62 * MM, y: -2.54 * MM }, 0.05 * MM).find((h) => h.id.includes('@pin:'))!.ref).toBe('U1:1');
    expect(picker.pick({ x: 7.62 * MM, y: -2.54 * MM }, 0.05 * MM).find((h) => h.id.includes('@pin:'))!.ref).toBe('U1:3');
    expect(picker.pick({ x: 0, y: 7.62 * MM }, 0.05 * MM).find((h) => h.id.includes('@pin:'))!.ref).toBe('U1:4');
  });
});

describe('schematic scene (headless)', () => {
  test('the synthetic sheet builds; text-glyphs are claimed by the builder; item colours resolve', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME, { primitiveBuilder: createTextGlyphBuilder() });
    scene.setDrawOrder([...SCHEMATIC_DRAW_ORDER]);
    const upsert = syntheticSchematic().map((it) => ({ owner: it.id, items: schematicItemToRenderItems(it) }));
    scene.apply({ upsert });
    expect(scene.itemCount).toBeGreaterThan(80);
    const labels = scene.root.children.map((c) => c.label);
    expect(labels.indexOf(SCH_LAYERS.wire)).toBeGreaterThan(labels.indexOf(SCH_LAYERS.device));
    // hier label fill takes the theme background colour through its key reference
    const fill = scene.getItem('hl-in@fill')!;
    expect(scene.itemColor(fill)).toEqual(KICAD_DEFAULT_THEME.colors['schematic.background']!);
    const fillObj = scene.objectsOf('hl-in').find((o) => o.item.id === 'hl-in@fill')!;
    expect(fillObj.tint).toBe(0xf5f4ef);
    // explicit colours win unless the theme overrides item colours
    const red = schematicItemToRenderItems(wire('red', 0, 0, 1, 0, { color: { r: 1, g: 0, b: 0, a: 1 } }));
    scene.apply({ upsert: [{ owner: 'red', items: red }] });
    expect(scene.objectsOf('red')[0]!.tint).toBe(0xff0000);
    scene.setTheme({ ...KICAD_DEFAULT_THEME, overrideSchItemColors: true });
    expect(scene.objectsOf('red')[0]!.tint).toBe(0x009600); // schematic.wire
    expect(scene.objectsOf('hl-in').find((o) => o.item.id === 'hl-in@fill')!.tint).toBe(0xf5f4ef); // key references still apply
    scene.destroy();
  });
});

describe('SchematicCanvasHost', () => {
  test('setStore switches sheets and remembers the camera per sheet', () => {
    const host = new SchematicCanvasHost(KICAD_DEFAULT_THEME);
    const main = new MemoryStore(syntheticSchematic(), 'schematic');
    const sub = new MemoryStore(syntheticSubSheet(), 'schematic');
    host.setStore(main);
    const mainCount = host.scene.itemCount;
    expect(mainCount).toBeGreaterThan(80);
    expect(host.getRenderItem('R1')).toBeDefined();
    host.setCamera({ x: 1, y: 2, zoom: 1e-4 });
    host.setStore(sub);
    expect(host.currentStore).toBe(sub);
    expect(host.scene.itemCount).toBeLessThan(mainCount);
    expect(host.getRenderItem('R1')).toBeUndefined();
    expect(host.getRenderItem('SR1')).toBeDefined();
    host.setCamera({ x: 100, y: 200, zoom: 2e-4 });
    host.setStore(main);
    expect(host.getCamera()).toEqual({ x: 1, y: 2, zoom: 1e-4 });
    host.setStore(sub);
    expect(host.getCamera()).toEqual({ x: 100, y: 200, zoom: 2e-4 });
    // store diffs on the current sheet still flow through
    sub.apply({ removed: ['SR1'] });
    expect(host.getRenderItem('SR1')).toBeUndefined();
    main.apply({ removed: ['R1'] }); // not current: ignored
    expect(host.currentStore).toBe(sub);
    // child items listed separately are skipped when their parent is in the store
    const withPin = new MemoryStore([resistor('R9', 'R9', 0, 0), { id: 'R9-pin1', type: 'KOT_SCH_PIN', parent: 'R9', proto: { number: '1', position: { xNm: 0, yNm: 0 }, orientation: 1 } }], 'schematic');
    host.setStore(withPin);
    expect(host.scene.ownerItems('R9-pin1')).toEqual([]);
    expect(host.scene.ownerItems('R9').length).toBeGreaterThan(3);
    expect(SchematicCanvasHost.isPinHit({ id: 'R9@pin:x', ref: 'R9:1', owner: 'R9', layer: '', distance: 0 })).toBe(true);
    expect(SchematicCanvasHost.isPinHit({ id: 'R9@pin:x:name', ref: 'R9:1', owner: 'R9', layer: '', distance: 0 })).toBe(false);
    host.unmount();
  });
});
