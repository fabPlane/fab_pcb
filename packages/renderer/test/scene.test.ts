/**
 * Headless Pixi scene tests: Graphics / Mesh objects can be built without a renderer, so
 * the diff logic, layer ordering, tinting and instancing cache are testable under bun.
 */
import { describe, expect, test } from 'bun:test';
import { Graphics, Mesh } from 'pixi.js';
import { Scene } from '../src/core/scene.js';
import { KICAD_CLASSIC_THEME, KICAD_DEFAULT_THEME } from '../src/core/theme.js';
import { makeRenderItem, type RenderItem } from '../src/core/model.js';
import { boardItemToRenderItems } from '../src/board/boardAdapter.js';
import { boardDrawOrder } from '../src/board/boardLayers.js';
import { MM, footprint, syntheticBoard, zone } from './fixtures.js';

describe('Scene', () => {
  test('apply builds one object per render item, per-owner rebuild and removal', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME);
    scene.setDrawOrder(boardDrawOrder());
    const fp = boardItemToRenderItems(footprint('R1', 'R1', 10, 10));
    scene.apply({ upsert: [{ owner: 'R1', items: fp }] });
    expect(scene.itemCount).toBe(fp.length);
    expect(scene.ownerItems('R1').length).toBe(fp.length);
    expect(scene.layer('BL_F_Cu').container.children.length).toBe(2);
    const before = scene.revision;
    // update: replaces everything of that owner
    const moved = boardItemToRenderItems(footprint('R1', 'R1', 20, 20));
    scene.apply({ upsert: [{ owner: 'R1', items: moved }] });
    expect(scene.itemCount).toBe(moved.length);
    expect(scene.getItem('R1-p1@BL_F_Cu')!.anchor!.x).toBeCloseTo(19.2 * MM, 0);
    expect(scene.revision).toBe(before + 1);
    scene.apply({ remove: ['R1'] });
    expect(scene.itemCount).toBe(0);
    expect(scene.layer('BL_F_Cu').container.children.length).toBe(0);
    scene.destroy();
  });

  test('layer containers follow the draw order and get theme tints', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME);
    scene.setDrawOrder(['BL_B_Cu', 'BL_F_Cu', 'BL_F_SilkS']);
    scene.apply({
      upsert: [
        { owner: 'a', items: [makeRenderItem('a', 'BL_F_SilkS', [{ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 0 }])] },
        { owner: 'b', items: [makeRenderItem('b', 'BL_F_Cu', [{ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 1 }])] },
        { owner: 'c', items: [makeRenderItem('c', 'BL_B_Cu', [{ kind: 'circle', c: { x: 0, y: 0 }, r: 1, width: 0, fill: true }])] },
      ],
    });
    const z = (l: string) => scene.layer(l).container.zIndex;
    expect(z('BL_B_Cu')).toBeLessThan(z('BL_F_Cu'));
    expect(z('BL_F_Cu')).toBeLessThan(z('BL_F_SilkS'));
    const labels = scene.root.children.map((c) => c.label);
    expect(labels).toEqual(['BL_B_Cu', 'BL_F_Cu', 'BL_F_SilkS']);
    scene.setDrawOrder(['BL_F_SilkS', 'BL_F_Cu', 'BL_B_Cu']);
    expect(scene.root.children.map((c) => c.label)).toEqual(['BL_F_SilkS', 'BL_F_Cu', 'BL_B_Cu']);
    // tints
    const objB = scene.objectsOf('b')[0]!;
    expect(objB.tint).toBe(0xc83434); // F_Cu default red
    scene.setTheme(KICAD_CLASSIC_THEME);
    expect(objB.tint).toBe(0x840000);
    expect(scene.objectsOf('c')[0]!.tint).toBe(0x008400);
    // visibility / alpha
    scene.setLayerVisible('BL_F_Cu', false);
    expect(scene.layer('BL_F_Cu').container.visible).toBe(false);
    expect(scene.isLayerVisible('BL_F_Cu')).toBe(false);
    scene.setLayerAlpha('BL_B_Cu', 0.5);
    expect(scene.layer('BL_B_Cu').container.alpha).toBe(0.5);
    scene.destroy();
  });

  test('instancing: identical pads share one GraphicsContext, released on removal', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME);
    const items = [...boardItemToRenderItems(footprint('R1', 'R1', 10, 10)), ...boardItemToRenderItems(footprint('R2', 'R2', 30, 10))];
    scene.apply({
      upsert: [
        { owner: 'R1', items: items.filter((i) => i.owner === 'R1') },
        { owner: 'R2', items: items.filter((i) => i.owner === 'R2') },
      ],
    });
    const g1 = scene.objectsOf('R1').find((o) => o.item.id === 'R1-p1@BL_F_Cu')!.children[0] as Graphics;
    const g2 = scene.objectsOf('R2').find((o) => o.item.id === 'R2-p2@BL_F_Cu')!.children[0] as Graphics;
    expect(g1.context).toBe(g2.context);
    const cached = scene.cachedContexts;
    expect(cached).toBeGreaterThan(0);
    expect(cached).toBeLessThan(items.filter((i) => i.cacheKey).length);
    scene.apply({ remove: ['R1'] });
    const r2Keys = new Set(items.filter((i) => i.owner === 'R2' && i.cacheKey).map((i) => i.cacheKey));
    expect(scene.cachedContexts).toBe(r2Keys.size); // R2 still references every shared pad key
    scene.apply({ remove: ['R2'] });
    expect(scene.cachedContexts).toBe(0);
    scene.destroy();
  });

  test('zone fills become meshes, moving the origin only re-positions objects', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME, { meshThreshold: 100 });
    const z = boardItemToRenderItems(
      zone(
        'z',
        [34],
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
        ],
      ),
    );
    scene.apply({ upsert: [{ owner: 'z', items: z }] });
    const fillObj = scene.objectsOf('z').find((o) => o.item.id === 'z@BL_B_Cu')!;
    expect(fillObj.children.some((c) => c instanceof Mesh)).toBe(true);
    const mesh = fillObj.children.find((c) => c instanceof Mesh) as Mesh;
    expect(mesh.geometry.indices.length).toBe(8 * 3); // square with a square hole -> 8 triangles
    expect(fillObj.position.x).toBe(fillObj.anchorX);
    scene.setOrigin(5 * MM, 5 * MM);
    expect(fillObj.position.x).toBe(fillObj.anchorX - 5 * MM);
    expect(fillObj.anchorX).toBe(5 * MM); // bbox centre
    scene.destroy();
  });

  test('net highlight dims everything outside the nets', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME, { dimAlpha: 0.25 });
    const items: RenderItem[] = [
      makeRenderItem('gnd', 'BL_F_Cu', [{ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, width: 1 }], { net: 'GND' }),
      makeRenderItem('vcc', 'BL_F_Cu', [{ kind: 'segment', a: { x: 0, y: 1 }, b: { x: 1, y: 1 }, width: 1 }], { net: 'VCC' }),
      makeRenderItem('silk', 'BL_F_SilkS', [{ kind: 'segment', a: { x: 0, y: 2 }, b: { x: 1, y: 2 }, width: 0 }]),
    ];
    scene.apply({ upsert: items.map((i) => ({ owner: i.id, items: [i] })) });
    scene.setNetHighlight(['GND']);
    expect(scene.objectsOf('gnd')[0]!.alpha).toBe(1);
    expect(scene.objectsOf('vcc')[0]!.alpha).toBe(0.25);
    expect(scene.objectsOf('silk')[0]!.alpha).toBe(0.25);
    scene.setNetHighlight(null);
    expect(scene.objectsOf('vcc')[0]!.alpha).toBe(1);
    scene.destroy();
  });

  test('the whole synthetic board builds headless', () => {
    const scene = new Scene(KICAD_DEFAULT_THEME);
    scene.setDrawOrder(boardDrawOrder());
    const upsert = syntheticBoard().map((it) => ({ owner: it.id, items: boardItemToRenderItems(it) }));
    scene.apply({ upsert });
    expect(scene.itemCount).toBeGreaterThan(30);
    expect(scene.layerIds().length).toBeGreaterThan(8);
    scene.clear();
    expect(scene.itemCount).toBe(0);
    expect(scene.cachedContexts).toBe(0);
    scene.destroy();
  });
});
