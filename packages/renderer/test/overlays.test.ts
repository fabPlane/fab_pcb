/**
 * Ratsnest overlay, DRC/ERC marker glyphs and zoom-gated pad number / net name labels.
 * Everything runs headless: hosts are used without `mount` (no WebGL), Graphics objects
 * build fine without a renderer.
 */
import { describe, expect, test } from 'bun:test';
import { Graphics } from 'pixi.js';
import { BoardCanvasHost } from '../src/board/BoardCanvasHost.js';
import { SchematicCanvasHost } from '../src/schematic/SchematicCanvasHost.js';
import { boardItemToRenderItems } from '../src/board/boardAdapter.js';
import { LABEL_LAYERS, PSEUDO_LAYERS, boardDrawOrder } from '../src/board/boardLayers.js';
import { RatsnestLayer } from '../src/core/ratsnest.js';
import { MARKER_SHAPE, MarkerLayer, markerLayerKey, markerScaleNm } from '../src/core/markers.js';
import { animateCamera, Camera } from '../src/core/camera.js';
import { KICAD_CLASSIC_THEME, KICAD_DEFAULT_THEME, colorToHex, themeColor } from '../src/core/theme.js';
import type { Primitive } from '../src/core/model.js';
import { MM, MemoryStore, footprint, pad, syntheticBoard, track, via } from './fixtures.js';
import { syntheticSchematic } from './schematicFixtures.js';

const glyph = (p: Primitive | undefined) => p as Extract<Primitive, { kind: 'text-glyphs' }>;
const instructions = (g: Graphics) => g.context.instructions.length;

describe('ratsnest overlay', () => {
  test('edges are normal without emphasis, bright for highlighted nets / selected ends, dim otherwise', () => {
    const layer = new RatsnestLayer(KICAD_DEFAULT_THEME);
    const gnd = { net: 'GND', a: { x: 0, y: 0 }, b: { x: 5 * MM, y: 0 }, source: 'R1-p1', target: 'C1-p2' };
    const vcc = { net: 'VCC', a: { x: 0, y: MM }, b: { x: 5 * MM, y: MM }, source: 'R2-p1', target: 'U1-p4' };
    layer.setEdges([gnd, vcc]);
    expect(layer.edgeCount).toBe(2);
    expect(layer.emphasis(gnd)).toBe('normal');
    layer.setHighlightNets(['GND']);
    expect(layer.emphasis(gnd)).toBe('bright');
    expect(layer.emphasis(vcc)).toBe('dim');
    layer.setHighlightNets([]);
    layer.setSelectedRefs(['U1-p4']);
    expect(layer.emphasis(vcc)).toBe('bright');
    expect(layer.emphasis(gnd)).toBe('dim');
    layer.setSelectedRefs([]);
    expect(layer.emphasis(gnd)).toBe('normal');
    // the graphics are built lazily, once per change, in the theme's ratsnest colour
    layer.setHighlightNets(['GND']);
    layer.update();
    const [dim, normal, bright] = layer.root.children as Graphics[];
    expect(instructions(bright!)).toBeGreaterThan(0);
    expect(instructions(dim!)).toBeGreaterThan(0);
    expect(instructions(normal!)).toBe(0);
    layer.setVisible(false);
    expect(layer.visible).toBe(false);
    layer.destroy();
  });

  test('host: setRatsnest + selection of a footprint emphasises edges touching its pads', () => {
    const host = new BoardCanvasHost(KICAD_DEFAULT_THEME);
    host.setStore(new MemoryStore([footprint('R1', 'R1', 10, 10), footprint('R2', 'R2', 30, 10)]));
    const e1 = { net: 'N1', a: { x: 10 * MM, y: 10 * MM }, b: { x: 30 * MM, y: 10 * MM }, source: 'R1-p1', target: 'R2-p1' };
    const e2 = { net: 'N2', a: { x: 10 * MM, y: 12 * MM }, b: { x: 30 * MM, y: 12 * MM }, source: 'X-p1', target: 'Y-p1' };
    host.setRatsnest([e1, e2]);
    expect(host.ratsnest.edgeCount).toBe(2);
    host.setSelection(['R1']); // the footprint owns pads R1-p1 / R1-p2
    expect(host.ratsnest.emphasis(e1)).toBe('bright');
    expect(host.ratsnest.emphasis(e2)).toBe('dim');
    host.setSelection([]);
    host.setHighlightNets(['N2']);
    expect(host.ratsnest.emphasis(e2)).toBe('bright');
    host.setHighlightNets([]);
    expect(host.ratsnest.emphasis(e2)).toBe('normal');
    host.setLayerVisible('board.ratsnest', false);
    expect(host.ratsnest.visible).toBe(false);
    host.setRatsnestVisible(true);
    expect(host.ratsnest.visible).toBe(true);
    // the layer lives under the scene root, above every drawing layer
    expect(host.scene.root.children).toContain(host.ratsnest.root);
    expect(host.ratsnest.root.zIndex).toBeGreaterThan(boardDrawOrder().length);
    host.unmount();
  });
});

describe('DRC / ERC markers', () => {
  test('glyph scale grows as the view zooms out (PCB_MARKER::SetZoom 1/sqrt(zoom))', () => {
    const s1 = markerScaleNm(1e-5, 'board');
    const s2 = markerScaleNm(1e-6, 'board');
    expect(s2 / s1).toBeCloseTo(Math.sqrt(10), 5);
    // ~13 px at 10 px/mm, ~41 px at 100 px/mm (13 shape units)
    expect((13 * s1 * 1e-5).toFixed(0)).toBe('13');
    expect(Math.round(13 * markerScaleNm(1e-4, 'board') * 1e-4)).toBe(41);
    expect(markerScaleNm(1e-5, 'schematic') / s1).toBeCloseTo(0.15 / 0.1625, 5);
    expect(MARKER_SHAPE.length).toBe(8);
    expect(markerLayerKey('board', 'warning')).toBe('board.drc_warning');
    expect(markerLayerKey('schematic', 'exclusion')).toBe('schematic.erc_exclusion');
  });

  test('markers are tinted per severity from the theme and picked nearest first with ref = id, owner = marker', () => {
    const host = new BoardCanvasHost(KICAD_DEFAULT_THEME);
    host.setStore(new MemoryStore(syntheticBoard()));
    host.camera.setViewport(800, 600);
    host.setCamera({ x: 20 * MM, y: 20 * MM, zoom: 1e-5 });
    host.setMarkers([
      { id: 'm-err', position: { x: 20 * MM, y: 20 * MM }, severity: 'error', layer: 'BL_F_Cu', description: 'Clearance violation', endPosition: { x: 21 * MM, y: 20 * MM } },
      { id: 'm-warn', position: { x: 25 * MM, y: 20 * MM }, severity: 'warning', description: 'Silk overlap' },
      { id: 'm-excl', position: { x: 30 * MM, y: 20 * MM }, severity: 'exclusion', description: 'Excluded' },
    ]);
    expect(host.markers.count).toBe(3);
    host.renderNow(); // no app: frame() returns early, so update the layer by hand
    host.markers.update(host.camera.zoom);
    const objs = host.markers.root.children.filter((c) => c.label?.startsWith('marker:'));
    expect(objs.length).toBe(3);
    const errGlyph = (objs.find((o) => o.label === 'marker:m-err')!.children[0] as Graphics);
    expect(errGlyph.tint).toBe(colorToHex(themeColor(KICAD_DEFAULT_THEME, 'board.drc_error')));
    expect(errGlyph.alpha).toBeCloseTo(0.8, 2);
    // the glyph extends right/down from the position: pick inside it
    const s = host.markers.scale;
    const inside = { x: 20 * MM + 6 * s, y: 20 * MM + 6 * s };
    const sp = host.worldToScreen(inside.x, inside.y);
    const hits = host.pick(sp.x, sp.y);
    expect(hits[0]).toMatchObject({ id: 'marker:m-err', ref: 'm-err', owner: 'marker', layer: 'board.drc_error', distance: 0 });
    // left of the tip: nothing from the marker (tolerance 6 px)
    const far = host.worldToScreen(20 * MM - 20 / 1e-5, 20 * MM);
    expect(host.pick(far.x, far.y).some((h) => h.owner === 'marker')).toBe(false);
    // per-severity visibility through setLayerVisible with the theme key
    const wp = host.worldToScreen(25 * MM + 6 * s, 20 * MM + 6 * s);
    expect(host.pick(wp.x, wp.y)[0]!.ref).toBe('m-warn');
    host.setLayerVisible('board.drc_warning', false);
    expect(host.markers.isSeverityVisible('warning')).toBe(false);
    expect(host.pick(wp.x, wp.y).some((h) => h.ref === 'm-warn')).toBe(false);
    host.setLayerVisible('board.drc_warning', true);
    host.setMarkersVisible(false);
    expect(host.pick(wp.x, wp.y).some((h) => h.owner === 'marker')).toBe(false);
    host.setMarkersVisible(true);
    // theme switch re-tints
    host.setTheme(KICAD_CLASSIC_THEME);
    expect(errGlyph.tint).toBe(colorToHex(themeColor(KICAD_CLASSIC_THEME, 'board.drc_error')));
    host.unmount();
  });

  test('focusMarker moves the camera (immediately without rAF / with reduced motion) and shows the legend', () => {
    const host = new BoardCanvasHost(KICAD_DEFAULT_THEME);
    host.setStore(new MemoryStore(syntheticBoard()));
    host.camera.setViewport(800, 600);
    host.setCamera({ x: 0, y: 0, zoom: 5e-5 });
    host.setMarkers([{ id: 'a', position: { x: 12 * MM, y: 34 * MM }, severity: 'error', description: 'x', endPosition: { x: 13 * MM, y: 34 * MM } }]);
    expect(host.focusMarker('nope')).toBe(false);
    expect(host.focusMarker('a', { reducedMotion: true })).toBe(true);
    expect(host.getCamera()).toEqual({ x: 12 * MM, y: 34 * MM, zoom: 5e-5 });
    expect(host.focusedMarker).toBe('a');
    host.markers.update(host.camera.zoom);
    const legend = host.markers.root.children.find((c) => !c.label?.startsWith('marker:')) as Graphics;
    expect(instructions(legend)).toBeGreaterThan(0);
    // zoomed far out the focus also zooms in to 40 px/mm; an explicit zoom wins
    host.setCamera({ zoom: 1e-6 });
    host.focusMarker('a');
    expect(host.getCamera().zoom).toBeCloseTo(4e-5, 9);
    host.focusMarker('a', { zoom: 1e-4 });
    expect(host.getCamera().zoom).toBeCloseTo(1e-4, 9);
    host.focusMarker(null);
    expect(host.focusedMarker).toBeNull();
    host.markers.update(host.camera.zoom);
    expect(instructions(legend)).toBe(0);
    host.unmount();
  });

  test('animateCamera eases geometrically in zoom and can be cancelled', async () => {
    const cam = new Camera();
    cam.setState({ x: 0, y: 0, zoom: 1e-5 });
    const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (id: number) => void };
    const hadRaf = typeof g.requestAnimationFrame === 'function';
    let now = 0;
    const queue: Array<(t: number) => void> = [];
    g.requestAnimationFrame = (cb) => {
      queue.push(cb);
      return queue.length;
    };
    g.cancelAnimationFrame = () => {
      queue.length = 0;
    };
    try {
      let done = false;
      animateCamera(cam, { x: 100, zoom: 1e-4 }, { durationMs: 100, reducedMotion: false, onDone: () => (done = true) });
      const t0 = performance.now();
      now = t0 + 50;
      queue.shift()!(now);
      const mid = cam.getState();
      expect(mid.x).toBeGreaterThan(0);
      expect(mid.x).toBeLessThan(100);
      expect(mid.zoom).toBeGreaterThan(1e-5);
      expect(mid.zoom).toBeLessThan(1e-4);
      queue.shift()!(t0 + 1000);
      expect(cam.getState().x).toBe(100);
      expect(cam.getState().y).toBe(0);
      expect(cam.getState().zoom).toBeCloseTo(1e-4, 12);
      expect(done).toBe(true);
      // reduced motion jumps at once
      animateCamera(cam, { x: 0 }, { reducedMotion: true });
      expect(cam.x).toBe(0);
      // cancel stops further frames
      const cancel = animateCamera(cam, { x: 50 }, { durationMs: 100, reducedMotion: false });
      cancel();
      expect(queue.length).toBe(0);
      expect(cam.x).toBe(0);
    } finally {
      if (!hadRaf) {
        delete g.requestAnimationFrame;
        delete g.cancelAnimationFrame;
      }
    }
  });

  test('schematic host uses the ERC colour keys and scale', () => {
    const host = new SchematicCanvasHost(KICAD_DEFAULT_THEME);
    host.setStore(new MemoryStore(syntheticSchematic(), 'schematic'));
    host.camera.setViewport(800, 600);
    host.setCamera({ x: 0, y: 0, zoom: 1e-5 });
    host.setMarkers([{ id: 'e1', position: { x: 0, y: 0 }, severity: 'warning', description: 'Pin not connected' }]);
    expect(host.markers.kind).toBe('schematic');
    host.markers.update(host.camera.zoom);
    expect(host.markers.scale).toBeCloseTo(markerScaleNm(1e-5, 'schematic'), 3);
    const s = host.markers.scale;
    const sp = host.worldToScreen(6 * s, 6 * s);
    const hit = host.pick(sp.x, sp.y)[0]!;
    expect(hit.layer).toBe('schematic.erc_warning');
    expect(hit.ref).toBe('e1');
    host.setLayerVisible('schematic.erc_warning', false);
    expect(host.pick(sp.x, sp.y).some((h) => h.owner === 'marker')).toBe(false);
    host.unmount();
  });
});

describe('pad number / net name labels', () => {
  const labels = { padNumbers: true, netNames: true };

  test('the adapter emits text-glyphs on the label layers only when asked', () => {
    const fp = footprint('R1', 'R1', 10, 10);
    const plain = boardItemToRenderItems(fp);
    expect(plain.some((i) => LABEL_LAYERS.includes(i.layer))).toBe(false);
    const withLabels = boardItemToRenderItems(fp, { labels });
    const num = withLabels.find((i) => i.id === 'R1-p1@label:number')!;
    const net = withLabels.find((i) => i.id === 'R1-p1@label:net')!;
    expect(num.layer).toBe(PSEUDO_LAYERS.padNumbers);
    expect(num.color).toBe(PSEUDO_LAYERS.padNetNames);
    expect(num.pickable).toBe(false);
    expect(num.ref).toBe('R1-p1');
    expect(num.owner).toBe('R1');
    expect(glyph(num.prims[0]).text).toBe('1');
    expect(net.layer).toBe(PSEUDO_LAYERS.padNetNames);
    expect(glyph(net.prims[0]).text).toBe('GND');
    expect(glyph(net.prims[0]).bold).toBe(true);
    // the fixture pad is 0.9 x 0.95: narrower than 0.95 x its height, so pcbnew turns the text
    expect(glyph(num.prims[0]).angle).toBe(90);
    // a wide pad keeps the text horizontal: number above the centre, net name below, both inside
    const wide = { id: 'wp', type: 'KOT_PCB_PAD', proto: pad('wp', '7', 0, 0, 1.6, 0.9, { net: 'GND' }) };
    const wl = boardItemToRenderItems(wide, { labels });
    const wPad = wl.find((i) => i.id === 'wp@BL_F_Cu')!;
    const wNum = glyph(wl.find((i) => i.id === 'wp@label:number')!.prims[0]);
    const wNet = glyph(wl.find((i) => i.id === 'wp@label:net')!.prims[0]);
    expect(wNum.angle).toBe(0);
    expect(wNum.pos.y).toBeLessThan(wNet.pos.y);
    expect(wNum.size.y).toBeLessThanOrEqual(wPad.bbox.h / 2.5);
    expect(wl.find((i) => i.id === 'wp@label:number')!.bbox.h).toBeLessThan(wPad.bbox.h);
    // only pad numbers: bigger, centred
    const numbersOnly = boardItemToRenderItems(wide, { labels: { padNumbers: true } });
    expect(numbersOnly.some((i) => i.id.endsWith('@label:net'))).toBe(false);
    const big = glyph(numbersOnly.find((i) => i.id === 'wp@label:number')!.prims[0]);
    expect(big.size.y).toBeGreaterThan(wNum.size.y);
    expect(big.pos).toEqual({ x: wPad.bbox.x + wPad.bbox.w / 2, y: wPad.bbox.y + wPad.bbox.h / 2 });
  });

  test('tall pads rotate the label; tracks need room for the name; vias get one inside', () => {
    const tall = { id: 'tp', type: 'KOT_PCB_PAD', proto: pad('tp', '12', 0, 0, 0.9, 1.6, { net: 'SIG' }) }; // 0.9 wide x 1.6 tall
    const items = boardItemToRenderItems(tall, { labels });
    const label = glyph(items.find((i) => i.id === 'tp@label:number')!.prims[0]);
    expect(Math.abs(label.angle)).toBe(90);
    expect(glyph(items.find((i) => i.id === 'tp@label:net')!.prims[0]).angle).toBe(90);
    expect(label.size.y).toBeLessThanOrEqual(0.9 * MM);
    const long = boardItemToRenderItems(track('t', 0, 0, 20, 0, 0.5, undefined, 'LONG_NET'), { labels });
    const tl = long.find((i) => i.id === 't@label:net')!;
    expect(tl.layer).toBe(PSEUDO_LAYERS.trackNetNames);
    expect(glyph(tl.prims[0]).text).toBe('LONG_NET');
    expect(glyph(tl.prims[0]).size.y).toBeCloseTo(0.5 * MM * 0.55, 0);
    expect(glyph(tl.prims[0]).pos).toEqual({ x: 10 * MM, y: 0 });
    const diag = boardItemToRenderItems(track('d', 0, 0, 20, 20, 0.5, undefined, 'D'), { labels });
    expect(glyph(diag.find((i) => i.id === 'd@label:net')!.prims[0]).angle).toBeCloseTo(-45, 5);
    const short = boardItemToRenderItems(track('s', 0, 0, 1, 0, 0.5, undefined, 'LONG_NET'), { labels });
    expect(short.some((i) => i.id === 's@label:net')).toBe(false);
    const v = boardItemToRenderItems(via('v', 5, 5, 0.8, 0.4, 'GND'), { labels });
    const vl = v.find((i) => i.id === 'v@label:net')!;
    expect(vl.layer).toBe(PSEUDO_LAYERS.viaNetNames);
    expect(glyph(vl.prims[0]).size.y).toBeLessThan(0.8 * MM);
    expect(vl.pickable).toBe(false);
  });

  test('host gates the label layers by zoom and rebuilds on setLabelOptions', () => {
    const host = new BoardCanvasHost(KICAD_DEFAULT_THEME, { labels: { padNumbers: true, netNames: true, minPxPerMm: 20 } });
    host.setStore(new MemoryStore(syntheticBoard()));
    const has = (suffix: string) => [...host.scene.items()].some((i) => i.id.endsWith(suffix));
    expect(has('@label:number')).toBe(true);
    expect(has('@label:net')).toBe(true);
    host.setCamera({ zoom: 1e-6 }); // 1 px/mm
    expect(host.labelsVisible).toBe(false);
    for (const l of LABEL_LAYERS) expect(host.scene.isLayerVisible(l)).toBe(false);
    host.setCamera({ zoom: 5e-5 }); // 50 px/mm
    expect(host.labelsVisible).toBe(true);
    for (const l of LABEL_LAYERS) expect(host.scene.isLayerVisible(l)).toBe(true);
    // a user toggle sticks across the gate
    host.setLayerVisible(PSEUDO_LAYERS.padNumbers, false);
    expect(host.scene.isLayerVisible(PSEUDO_LAYERS.padNumbers)).toBe(false);
    expect(host.scene.isLayerVisible(PSEUDO_LAYERS.padNetNames)).toBe(true);
    host.setCamera({ zoom: 1e-6 });
    host.setCamera({ zoom: 5e-5 });
    expect(host.scene.isLayerVisible(PSEUDO_LAYERS.padNumbers)).toBe(false);
    // labels are never picked
    const num = [...host.scene.items()].find((i) => i.id.endsWith('@label:number'))!;
    host.camera.setViewport(800, 600);
    host.setCamera({ x: num.bbox.x + num.bbox.w / 2, y: num.bbox.y + num.bbox.h / 2, zoom: 5e-5 });
    expect(host.pick(400, 300).some((h) => h.id.includes('@label:'))).toBe(false);
    // turning labels off removes them; the threshold can move
    host.setLabelOptions({ padNumbers: false, netNames: false });
    expect(has('@label:number')).toBe(false);
    expect(host.labelOptions).toEqual({});
    host.setLabelOptions({ netNames: true, minPxPerMm: 100 });
    expect(has('@label:net')).toBe(true);
    expect(has('@label:number')).toBe(false);
    expect(host.labelsVisible).toBe(false); // 50 px/mm < 100
    host.setCamera({ zoom: 2e-4 });
    expect(host.labelsVisible).toBe(true);
    // a plain host emits nothing
    const plain = new BoardCanvasHost(KICAD_DEFAULT_THEME);
    plain.setStore(new MemoryStore(syntheticBoard()));
    expect([...plain.scene.items()].some((i) => i.id.includes('@label:'))).toBe(false);
    plain.unmount();
    host.unmount();
  });
});
