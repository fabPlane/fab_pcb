import { describe, expect, test } from 'bun:test';
import { boardItemToRenderItems, dimensionText, graphicShapeToPrims, imageInfo, renderIdToKiid, textFallbackPolygon } from '../src/board/boardAdapter.js';
import { BOARD_LAYER_ENUM, boardDrawOrder, boardLayerName, copperLayerList, flipLayer } from '../src/board/boardLayers.js';
import { boxContains } from '../src/core/model.js';
import { MM, arc, barcode, circle, dimension, footprint, graphic, polySet, rect, seg, syntheticBoard, table, text, textBox, track, v, via, zone } from './fixtures.js';

const L = BOARD_LAYER_ENUM;

describe('board adapter', () => {
  test('track -> one segment with width, layer name and net', () => {
    const [ri] = boardItemToRenderItems(track('t', 1, 2, 11, 2, 0.25));
    expect(ri).toBeDefined();
    expect(ri!.layer).toBe('BL_F_Cu');
    expect(ri!.net).toBe('GND');
    expect(ri!.prims).toEqual([{ kind: 'segment', a: { x: 1 * MM, y: 2 * MM }, b: { x: 11 * MM, y: 2 * MM }, width: 0.25 * MM }]);
    expect(ri!.bbox).toEqual({ x: 1 * MM - 125_000, y: 2 * MM - 125_000, w: 10 * MM + 250_000, h: 250_000 });
    expect(ri!.owner).toBe('t');
  });

  test('accepts number / string nm and enum names', () => {
    const [ri] = boardItemToRenderItems({
      id: 'x',
      type: 'KOT_PCB_TRACE',
      proto: { start: { xNm: 1000, yNm: '2000' }, end: { xNm: 3000, yNm: 4000 }, width: { valueNm: 100 }, layer: 'BL_In2_Cu' },
    });
    expect(ri!.prims[0]).toEqual({ kind: 'segment', a: { x: 1000, y: 2000 }, b: { x: 3000, y: 4000 }, width: 100 });
    expect(ri!.layer).toBe('BL_In2_Cu');
  });

  test('via -> annular rings per copper layer plus a hole decoration', () => {
    const items = boardItemToRenderItems(via('v', 5, 5, 0.8, 0.4), { copperLayers: copperLayerList(4) });
    const rings = items.filter((i) => i.layer.startsWith('BL_'));
    expect(rings.map((i) => i.layer).sort()).toEqual(['BL_B_Cu', 'BL_F_Cu']); // padstack lists F/B only
    expect(rings[0]!.prims[0]).toEqual({ kind: 'circle', c: { x: 5 * MM, y: 5 * MM }, r: 0.4 * MM, width: 0, fill: true });
    expect(rings[0]!.ref).toBe('v');
    expect(rings[0]!.cacheKey).toBeDefined();
    const hole = items.find((i) => i.layer === 'board.via_hole')!;
    expect(hole.pickable).toBe(false);
    expect(hole.prims[0]).toEqual({ kind: 'circle', c: { x: 5 * MM, y: 5 * MM }, r: 0.2 * MM, width: 0, fill: true });
    expect(renderIdToKiid(hole.id)).toBe('v');
    // a via without an explicit layer list spans the drill span
    const proto = via('v2', 0, 0).proto as { padStack: { layers: number[] } };
    proto.padStack.layers = [];
    const all = boardItemToRenderItems({ id: 'v2', type: 'KOT_PCB_VIA', proto }, { copperLayers: copperLayerList(4) });
    expect(all.filter((i) => i.layer.startsWith('BL_')).map((i) => i.layer)).toEqual(['BL_F_Cu', 'BL_In1_Cu', 'BL_In2_Cu', 'BL_B_Cu']);
  });

  test('footprint with two pads: pads on copper/mask/paste, fields, courtyard, anchor and pickable body', () => {
    const items = boardItemToRenderItems(footprint('R1', 'R1', 10, 10, 0));
    const byLayer = (l: string) => items.filter((i) => i.layer === l && i.prims.length);
    expect(byLayer('BL_F_Cu').length).toBe(2);
    expect(byLayer('BL_F_Mask').length).toBe(2);
    expect(byLayer('BL_F_Paste').length).toBe(2);
    expect(byLayer('BL_F_CrtYd').length).toBe(1);
    expect(byLayer('BL_F_SilkS').length).toBe(2); // silk line + reference text fallback box
    expect(byLayer('board.anchor').length).toBe(1);
    for (const it of items) expect(it.owner).toBe('R1');
    const p1 = byLayer('BL_F_Cu').find((i) => i.ref === 'R1-p1')!;
    expect(p1.net).toBe('GND');
    expect(p1.id).toBe('R1-p1@BL_F_Cu');
    expect(p1.anchor).toEqual({ x: 9.2 * MM, y: 10 * MM });
    const poly = p1.prims[0]!;
    expect(poly.kind).toBe('polygon');
    if (poly.kind === 'polygon') {
      expect(poly.fill).toBe(true);
      expect(poly.outline.length).toBeGreaterThan(4); // roundrect
      expect(boxContains(p1.bbox, { x: 9.2 * MM, y: 10 * MM })).toBe(true);
      expect(p1.bbox.w).toBeCloseTo(0.9 * MM, -2);
      expect(p1.bbox.h).toBeCloseTo(0.95 * MM, -2);
    }
    const p2 = byLayer('BL_F_Cu').find((i) => i.ref === 'R1-p2')!;
    expect(p2.cacheKey).toBe(p1.cacheKey); // identical padstack -> shared geometry
    // the value field is hidden, the reference is drawn
    expect(items.find((i) => i.id === 'R1-ref')).toBeDefined();
    expect(items.find((i) => i.id === 'R1-val')).toBeUndefined();
    // body item: no prims, bbox spans the children, picked by bbox
    const body = items.find((i) => i.id === 'R1')!;
    expect(body.prims).toEqual([]);
    expect(boxContains(body.bbox, { x: 9.2 * MM, y: 10 * MM })).toBe(true);
    expect(boxContains(body.bbox, { x: 11.5 * MM, y: 10.8 * MM })).toBe(true);
  });

  test('rotated pads follow KiCad rotation (positive = CCW on screen)', () => {
    const items = boardItemToRenderItems(footprint('R2', 'R2', 0, 0, 90));
    const p1 = items.find((i) => i.id === 'R2-p1@BL_F_Cu')!;
    // pad 1 sits at (-0.8, 0) rotated by +90 -> (0, +0.8) in y-down coordinates
    expect(p1.anchor!.x).toBeCloseTo(0, 0);
    expect(p1.anchor!.y).toBeCloseTo(0.8 * MM, 0);
    // pad is 0.9 wide x 0.95 tall unrotated; rotated 90 its bbox is 0.95 wide
    expect(p1.bbox.w).toBeCloseTo(0.95 * MM, -3);
    expect(p1.bbox.h).toBeCloseTo(0.9 * MM, -3);
  });

  test('relative footprint children get transformed and flipped to the back', () => {
    const fp = footprint('R3', 'R3', 0, 0, 0); // children absolute at origin == relative definition
    const proto = fp.proto as Record<string, unknown>;
    proto.position = { xNm: 30n * BigInt(MM), yNm: 20n * BigInt(MM) };
    proto.orientation = { valueDegrees: 0 };
    proto.layer = L.BL_B_Cu;
    const items = boardItemToRenderItems(fp, { footprintChildrenAbsolute: false });
    const p1 = items.find((i) => i.ref === 'R3-p1' && i.layer === 'BL_B_Cu')!;
    expect(p1).toBeDefined();
    expect(p1.anchor!.x).toBeCloseTo(29.2 * MM, 0);
    expect(p1.anchor!.y).toBeCloseTo(20 * MM, 0);
    expect(items.some((i) => i.layer === 'BL_B_Mask')).toBe(true);
    expect(items.some((i) => i.layer === 'BL_F_Cu')).toBe(false);
    expect(items.find((i) => i.ref === 'R3-crtyd')!.layer).toBe('BL_B_CrtYd');
  });

  test('pad polygons from the server take precedence over the padstack fallback', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 1 * MM, y: 0 },
      { x: 0, y: 1 * MM },
    ];
    const items = boardItemToRenderItems(footprint('R1', 'R1', 10, 10, 0), {
      padPolygons: (padId, layer) => (padId === 'R1-p1' && layer === 'BL_F_Cu' ? [tri] : undefined),
    });
    const p1 = items.find((i) => i.id === 'R1-p1@BL_F_Cu')!;
    expect(p1.prims).toEqual([{ kind: 'polygon', outline: tri, holes: [], fill: true, width: 0 }]);
    const p1mask = items.find((i) => i.id === 'R1-p1@BL_F_Mask')!;
    expect(p1mask.prims[0]!.kind).toBe('polygon');
    expect((p1mask.prims[0] as { outline: unknown[] }).outline.length).toBeGreaterThan(4);
    // protobuf-es PolygonWithHoles form
    const items2 = boardItemToRenderItems(footprint('R1', 'R1', 10, 10, 0), {
      padPolygons: () => [{ outline: { nodes: tri.map((p) => ({ geometry: { case: 'point' as const, value: { xNm: p.x, yNm: p.y } } })) }, holes: [] }],
    });
    expect((items2.find((i) => i.id === 'R1-p1@BL_F_Cu')!.prims[0] as { outline: unknown[] }).outline).toEqual(tri);
  });

  test('zone with a hole: filled mesh polygon per layer, outline, net; rule area hatched', () => {
    const items = boardItemToRenderItems(zone('z', [L.BL_B_Cu!, L.BL_In1_Cu!], [[0, 0], [10, 0], [10, 10], [0, 10]], [[4, 4], [6, 4], [6, 6], [4, 6]]));
    const fills = items.filter((i) => i.prims[0]!.kind === 'polygon' && (i.prims[0] as { fill: boolean }).fill);
    expect(fills.map((i) => i.layer).sort()).toEqual(['BL_B_Cu', 'BL_In1_Cu']);
    const fill = fills[0]!.prims[0]!;
    if (fill.kind === 'polygon') {
      expect(fill.outline.length).toBe(4);
      expect(fill.holes.length).toBe(1);
      expect(fill.holes[0]!.length).toBe(4);
      expect(fill.mesh).toBe(true);
    }
    expect(fills[0]!.net).toBe('GND');
    expect(fills[0]!.ref).toBe('z');
    const outlines = items.filter((i) => i.id.endsWith(':outline'));
    expect(outlines.length).toBe(2);
    expect((outlines[0]!.prims[0] as { fill: boolean; width: number }).fill).toBe(false);

    const ra = boardItemToRenderItems(zone('ra', [L.BL_F_Cu!], [[0, 0], [10, 0], [10, 10], [0, 10]], undefined, false, '', true));
    expect(ra.length).toBe(1);
    const segs = ra[0]!.prims.filter((p) => p.kind === 'segment');
    expect(segs.length).toBeGreaterThan(3); // hatch lines
    expect(ra[0]!.net).toBeUndefined();
  });

  test('graphic shapes: segment, rounded rect, arc, circle, dashed line, arrows', () => {
    expect(boardItemToRenderItems(graphic('s', L.BL_F_SilkS!, seg(0, 0, 5, 0), 0.12))[0]!.prims).toEqual([
      { kind: 'segment', a: { x: 0, y: 0 }, b: { x: 5 * MM, y: 0 }, width: 0.12 * MM },
    ]);
    const rr = boardItemToRenderItems(graphic('r', L.BL_Edge_Cuts!, rect(0, 0, 10, 5, 1), 0.05))[0]!.prims[0]!;
    expect(rr.kind).toBe('polygon');
    if (rr.kind === 'polygon') {
      expect(rr.fill).toBe(false);
      expect(rr.outline.length).toBe(36);
      expect(rr.width).toBe(0.05 * MM);
    }
    const filledRect = boardItemToRenderItems(graphic('rf', L.BL_F_Cu!, rect(0, 0, 2, 2), 0, true))[0]!.prims;
    expect(filledRect.length).toBe(1);
    expect((filledRect[0] as { fill: boolean }).fill).toBe(true);
    const a = boardItemToRenderItems(graphic('a', L.BL_Cmts_User!, arc(0, 0, 1, 1, 2, 0), 0.1))[0]!.prims[0]!;
    expect(a.kind).toBe('arc');
    const c = boardItemToRenderItems(graphic('c', L.BL_F_Fab!, circle(1, 1, 0.5), 0.1))[0]!.prims[0]!;
    expect(c).toEqual({ kind: 'circle', c: { x: 1 * MM, y: 1 * MM }, r: 0.5 * MM, width: 0.1 * MM, fill: false });
    // dashed segment
    const dashed = graphicShapeToPrims({ attributes: { stroke: { width: { valueNm: 100_000 }, style: 3 } }, geometry: seg(0, 0, 10, 0) });
    expect(dashed.length).toBeGreaterThan(3);
    expect(dashed.every((p) => p.kind === 'segment')).toBe(true);
    // arrow ending
    const arrow = graphicShapeToPrims({ attributes: { stroke: { width: { valueNm: 100_000 } } }, geometry: seg(0, 0, 10, 0), endEnding: { style: 2 } });
    expect(arrow.length).toBe(2);
    expect(arrow[1]!.kind).toBe('polygon');
    // flat-field oneof form also works
    const flat = graphicShapeToPrims({ attributes: {}, segment: { start: { xNm: 0, yNm: 0 }, end: { xNm: 1, yNm: 1 } } });
    expect(flat[0]!.kind).toBe('segment');
  });

  test('text: fallback box honours size/alignment; server shapes are used when present', () => {
    const t = text('t', L.BL_F_SilkS!, 3, 28, 'abc', 2);
    const [fallback] = boardItemToRenderItems(t);
    expect(fallback!.layer).toBe('BL_F_SilkS');
    expect(fallback!.cacheKey).toContain('text|abc');
    const poly = fallback!.prims[0]!;
    if (poly.kind === 'polygon') {
      expect(poly.outline[0]!.x).toBeCloseTo(3 * MM, 0); // left aligned
      expect(poly.outline[2]!.y).toBeCloseTo(28 * MM, 0); // bottom aligned
    }
    const box = textFallbackPolygon({ position: { xNm: 0, yNm: 0 }, text: 'ab', attributes: { size: { xNm: 1000, yNm: 1000 }, horizontalAlignment: 2, verticalAlignment: 2 } });
    expect(box[0]!.x).toBeCloseTo(-box[1]!.x, 6); // centred
    const glyphs = [
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    ];
    const [shaped] = boardItemToRenderItems(t, { textShapes: (id) => (id === 't' ? glyphs : undefined) });
    expect(shaped!.prims).toEqual([{ kind: 'text-shapes', polys: glyphs }]);
    expect(shaped!.cacheKey).toBeUndefined();
    // GetTextAsShapes CompoundShape form (stroke font -> segments)
    const [stroked] = boardItemToRenderItems(t, { textShapes: () => [{ attributes: { stroke: { width: { valueNm: 1000 } } }, geometry: seg(0, 0, 1, 1) }] });
    expect(stroked!.prims[0]!.kind).toBe('segment');
  });

  test('dimension: crossbar, extension lines, arrows and text', () => {
    const [ri] = boardItemToRenderItems(dimension('d', 0, 0, 10, 0, -3));
    expect(ri!.layer).toBe('BL_Dwgs_User');
    const segs = ri!.prims.filter((p) => p.kind === 'segment');
    expect(segs.length).toBe(3 + 4); // crossbar + 2 extension lines + 2 arrows x 2 lines
    const cross = segs[0]!;
    if (cross.kind === 'segment') {
      expect(cross.a.y).toBeCloseTo(-3 * MM, 0);
      expect(cross.b.y).toBeCloseTo(-3 * MM, 0);
      expect(Math.abs(cross.b.x - cross.a.x)).toBeCloseTo(10 * MM, 0);
    }
    expect(ri!.prims.some((p) => p.kind === 'polygon')).toBe(true); // text fallback box
  });

  test('dimension: outward arrow heads trail into the crossbar, inward ones out of it with a tail', () => {
    // PCB_DIM_ALIGNED::updateGeometry -- outward: drawAnArrow( crossBarStart, EDA_ANGLE( dimension ) ),
    // so the head at the left end has its legs running right, into the dimension.
    const legs = (item: ReturnType<typeof dimension>) =>
      boardItemToRenderItems(item)[0]!
        .prims.filter((p) => p.kind === 'segment')
        .slice(3) // crossbar + two extension lines first
        .map((p) => (p.kind === 'segment' ? p.b.x - p.a.x : 0));
    // start at x = 0, end at x = 10: outward legs point +x at the start end
    const outward = legs(dimension('d', 0, 0, 10, 0, -3));
    expect(outward.length).toBe(4);
    expect(outward.slice(0, 2).every((dx) => dx > 0)).toBe(true);
    expect(outward.slice(2).every((dx) => dx < 0)).toBe(true);
    // inward: the other way round, plus a tail of two arrow lengths on each
    const inward = legs(dimension('d', 0, 0, 10, 0, -3, undefined, { inward: true }));
    expect(inward.length).toBe(6);
    expect(inward.slice(0, 3).every((dx) => dx < 0)).toBe(true);
    expect(inward.slice(3).every((dx) => dx > 0)).toBe(true);
    expect(Math.abs(inward[2]!)).toBeCloseTo(2 * 1.27 * MM, 0); // INWARD_ARROW_LENGTH_TO_HEAD_RATIO
  });

  test('dimension: resolved_text is the plotted string, empty means no text at all', () => {
    // `text.text` is the bare measurement; field 26 carries what the plotter draws
    const shapes = [{ attributes: { stroke: { width: { valueNm: 150_000 } } }, segment: { start: { xNm: 4 * MM, yNm: -4 * MM }, end: { xNm: 6 * MM, yNm: -4 * MM } } }];
    const withGlyphs = (item: ReturnType<typeof dimension>) => boardItemToRenderItems(item, { textShapes: () => shapes as never })[0]!;

    const resolved = dimension('d', 0, 0, 10, 0, -3, undefined, { resolvedText: '10.00 mm' });
    expect(dimensionText(resolved.proto as Record<string, unknown>)).toBe('10.00 mm');
    // the server glyphs (laid out for the resolved string) are drawn, not the metrics box
    const ri = withGlyphs(resolved);
    expect(ri.prims.filter((p) => p.kind === 'segment').length).toBe(7 + 1);
    expect(ri.prims.some((p) => p.kind === 'polygon')).toBe(false);

    // no glyphs: the fallback box is sized from the resolved string, not the measurement
    const long = boardItemToRenderItems(dimension('d', 0, 0, 10, 0, -3, undefined, { resolvedText: '10.00 millimetres' }))[0]!;
    const short = boardItemToRenderItems(dimension('d', 0, 0, 10, 0, -3, undefined, { resolvedText: '10.00' }))[0]!;
    const boxW = (r: typeof long) => {
      const p = r.prims.find((q) => q.kind === 'polygon');
      return p?.kind === 'polygon' ? Math.max(...p.outline.map((c) => c.x)) - Math.min(...p.outline.map((c) => c.x)) : 0;
    };
    expect(boxW(long)).toBeGreaterThan(boxW(short));

    // empty resolved_text: the geometry is drawn, the text is not (a centre dimension)
    const blank = withGlyphs(dimension('d', 0, 0, 10, 0, -3, undefined, { resolvedText: '' }));
    expect(dimensionText({ resolvedText: '' })).toBe('');
    expect(blank.prims.filter((p) => p.kind === 'segment').length).toBe(7);
    expect(blank.prims.some((p) => p.kind === 'polygon')).toBe(false);

    // older server: no field at all -> the bare measurement, and centre dimensions plot nothing
    const old = dimension('d', 0, 0, 10, 0, -3);
    expect('resolvedText' in (old.proto as object)).toBe(false);
    expect(dimensionText(old.proto as Record<string, unknown>)).toBe('10.00');
    expect(withGlyphs(old).prims.filter((p) => p.kind === 'segment').length).toBe(7 + 1);
    const centre = dimension('c', 0, 0, 0, 0, 0, undefined, { style: { case: 'center', value: { center: v(5, 5), end: v(5, 8) } } });
    expect(dimensionText(centre.proto as Record<string, unknown>)).toBe('');
    expect(withGlyphs(centre).prims.length).toBe(2); // the two arms of the cross, no text

    // the leader's text border is sized from the resolved string too, and dropped when it is empty
    const leaderStyle = (case_ = 'leader') => ({ case: case_, value: { start: v(0, 0), end: v(5, 5), borderStyle: 2 } });
    const leader = boardItemToRenderItems(dimension('l', 0, 0, 5, 5, 0, undefined, { resolvedText: 'Leader', style: leaderStyle() }))[0]!;
    expect(leader.prims.some((p) => p.kind === 'polygon')).toBe(true);
    const bare = boardItemToRenderItems(dimension('l', 0, 0, 5, 5, 0, undefined, { resolvedText: '', style: leaderStyle() }))[0]!;
    expect(bare.prims.some((p) => p.kind === 'polygon')).toBe(false);
  });

  test('knockout text and text boxes are filled from knockout_shapes, with the old drawing as fallback', () => {
    // BoardText.knockout_shapes (field 8) / BoardTextBox.knockout_shapes (field 9): the margin
    // box minus the glyphs, which no amount of GetTextAsShapes glyph strokes can reproduce.
    const glyph = { attributes: { stroke: { width: { valueNm: 150_000 } } }, segment: { start: { xNm: 11 * MM, yNm: 11 * MM }, end: { xNm: 12 * MM, yNm: 11 * MM } } };
    const shapes = () => [glyph] as never;

    const ko = text('t', L.BL_F_Cu!, 10, 10, 'Knocked out');
    (ko.proto as Record<string, unknown>).knockout = true;
    (ko.proto as Record<string, unknown>).knockoutShapes = polySet([[9, 9, 20, 12]]);
    const ri = boardItemToRenderItems(ko, { textShapes: shapes })[0]!;
    // the box-minus-glyphs polygon replaces the glyph strokes entirely
    expect(ri.prims.length).toBe(1);
    expect(ri.prims[0]).toMatchObject({ kind: 'polygon', fill: true, width: 0 });
    expect(ri.bbox).toEqual({ x: 9 * MM, y: 9 * MM, w: 11 * MM, h: 3 * MM });
    // older server (no field, or an empty PolySet): the glyph strokes, as before
    delete (ko.proto as Record<string, unknown>).knockoutShapes;
    expect(boardItemToRenderItems(ko, { textShapes: shapes })[0]!.prims[0]!.kind).toBe('segment');
    (ko.proto as Record<string, unknown>).knockoutShapes = { polygons: [] };
    expect(boardItemToRenderItems(ko, { textShapes: shapes })[0]!.prims[0]!.kind).toBe('segment');

    // a text box knocks out the box *and its border*, so the border stroke goes too
    const kb = textBox('tb', 10, 10, 20, 15, 'Multiline\nknockout\nbox');
    (kb.proto as Record<string, unknown>).knockout = true;
    (kb.proto as Record<string, unknown>).knockoutShapes = polySet([[10, 10, 20, 15], [12, 12, 13, 13]]);
    const box = boardItemToRenderItems(kb, { textShapes: shapes })[0]!;
    expect(box.prims.length).toBe(2);
    expect(box.prims.every((p) => p.kind === 'polygon' && p.fill)).toBe(true);
    delete (kb.proto as Record<string, unknown>).knockoutShapes;
    const plain = boardItemToRenderItems(kb, { textShapes: shapes })[0]!;
    expect(plain.prims.some((p) => p.kind === 'polygon' && !p.fill)).toBe(true); // the border
    expect(plain.prims.some((p) => p.kind === 'segment')).toBe(true); // the glyph strokes

    // and a knocked-out table cell (PCB_TABLECELL is a BoardTextBox) does the same
    const tbl = table('tbl', 0, 0, 10, 5, ['a', 'b']);
    const cells = (tbl.proto as { cells: Array<{ textBox: Record<string, unknown> }> }).cells;
    cells[0]!.textBox.knockout = true;
    cells[0]!.textBox.knockoutShapes = polySet([[0, 0, 10, 5]]);
    const cell = boardItemToRenderItems(tbl, { textShapes: shapes })[0]!;
    expect(cell.prims.filter((p) => p.kind === 'polygon' && p.fill).length).toBe(1);
  });

  test('misc items: point, group via itemBBox, image header parsing, unknown types', () => {
    const [pt] = boardItemToRenderItems({ id: 'p', type: 'KOT_PCB_POINT', proto: { position: { xNm: 1000, yNm: 1000 }, size: { valueNm: 200 }, layer: 3 } });
    expect(pt!.layer).toBe('board.points');
    expect(pt!.prims.length).toBe(3);
    const [grp] = boardItemToRenderItems(
      { id: 'g', type: 'KOT_PCB_GROUP', proto: { items: [{ value: 'a' }, { value: 'b' }] } },
      { itemBBox: (id) => (id === 'a' ? { x: 0, y: 0, w: 10, h: 10 } : { x: 20, y: 20, w: 5, h: 5 }) },
    );
    expect(grp!.bbox).toEqual({ x: 0, y: 0, w: 25, h: 25 });
    expect(grp!.prims).toEqual([]);
    expect(boardItemToRenderItems({ id: 'g2', type: 'KOT_PCB_GROUP', proto: { items: [] } })).toEqual([]);
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0x64]);
    expect(imageInfo(png)).toEqual({ w: 300, h: 100, mime: 'image/png' });
    const [img] = boardItemToRenderItems({ id: 'i', type: 'KOT_PCB_REFERENCE_IMAGE', proto: { layer: 43, position: { xNm: 0, yNm: 0 }, imageScale: { value: 2 }, imageData: png } });
    expect(img!.prims[0]!.kind).toBe('image');
    if (img!.prims[0]!.kind === 'image') {
      expect(img!.prims[0]!.w).toBeCloseTo(300 * (25.4e6 / 300) * 2, 3);
      expect(img!.prims[0]!.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    }
    expect(boardItemToRenderItems({ id: 'm', type: 'KOT_PCB_MARKER', proto: {} })).toEqual([]);
    // type derived from $typeName when the store gives none
    const [tr] = boardItemToRenderItems({ id: 'x', type: '', proto: track('x', 0, 0, 1, 0).proto });
    expect(tr!.prims[0]!.kind).toBe('segment');
  });

  test('barcode: the server-encoded symbol wins, the placeholder is the fallback', () => {
    const modules: Array<[number, number, number, number]> = [
      [10, 10, 11, 11],
      [12, 10, 13, 11],
      [10, 12, 11, 13],
    ];
    const [ri] = boardItemToRenderItems(barcode('bc', 11.5, 11.5, 4, 4, { modules }));
    expect(ri!.layer).toBe('BL_F_SilkS');
    // one filled polygon per dark module, in board coordinates, and nothing else
    expect(ri!.prims.length).toBe(3);
    for (const p of ri!.prims) expect(p).toMatchObject({ kind: 'polygon', fill: true, width: 0 });
    expect((ri!.prims[0] as { outline: Array<{ x: number; y: number }> }).outline[0]).toEqual({ x: 10 * MM, y: 10 * MM });
    expect(ri!.bbox).toEqual({ x: 10 * MM, y: 10 * MM, w: 3 * MM, h: 3 * MM });

    // older servers send no `shapes`: frame + placeholder bars, as before
    const [old] = boardItemToRenderItems(barcode('bc', 11.5, 11.5, 4, 4));
    expect(old!.prims.length).toBe(10);
    expect(old!.prims[0]).toMatchObject({ kind: 'polygon', fill: false });
    expect(old!.prims.filter((p) => 'fill' in p && p.fill).length).toBe(9);
    // an empty PolySet is treated as absent too
    const empty = barcode('bc', 11.5, 11.5, 4, 4);
    (empty.proto as Record<string, unknown>).shapes = { polygons: [] };
    expect(boardItemToRenderItems(empty)[0]!.prims.length).toBe(10);
  });

  test('text box: server glyphs replace the fallback and the box edges are dropped', () => {
    const box = textBox('tb', 10, 10, 20, 15, 'Hi');
    const corners = [
      { x: 10 * MM, y: 10 * MM },
      { x: 20 * MM, y: 10 * MM },
      { x: 20 * MM, y: 15 * MM },
      { x: 10 * MM, y: 15 * MM },
    ];
    const glyph = { attributes: { stroke: { width: { valueNm: 150_000 } } }, segment: { start: { xNm: 11 * MM, yNm: 11 * MM }, end: { xNm: 12 * MM, yNm: 11 * MM } } };
    // GetTextAsShapes appends the four box edges whatever border_enabled says
    const edges = corners.map((c, i) => ({ attributes: { stroke: { width: { valueNm: 150_000 } } }, segment: { start: { xNm: c.x, yNm: c.y }, end: { xNm: corners[(i + 1) % 4]!.x, yNm: corners[(i + 1) % 4]!.y } } }));
    const shapes = [glyph, ...edges];

    // no server shapes: only the border rectangle, which stands in for the text
    const fallback = boardItemToRenderItems(box)[0]!;
    expect(fallback.prims.length).toBe(1);
    expect(fallback.prims.every((p) => !('fill' in p && p.fill))).toBe(true);

    const ri = boardItemToRenderItems(box, { textShapes: () => shapes as never })[0]!;
    // the glyph survives; the four edges do not (the border comes from border_stroke instead)
    expect(ri.prims.length).toBe(2);
    expect(ri.prims.filter((p) => p.kind === 'segment')).toEqual([{ kind: 'segment', a: { x: 11 * MM, y: 11 * MM }, b: { x: 12 * MM, y: 11 * MM }, width: 150_000 }]);
    expect(ri.prims[0]!.kind).toBe('polygon'); // the border, from the box corners

    // border_enabled false -> nothing but the glyphs once they are real
    const borderless = textBox('tb2', 10, 10, 20, 15, 'Hi', { border: false });
    const noBorder = boardItemToRenderItems(borderless, { textShapes: () => shapes as never })[0]!;
    expect(noBorder.prims.length).toBe(1);
    expect(noBorder.prims[0]!.kind).toBe('segment');
    expect(boardItemToRenderItems(borderless)[0]!.prims.length).toBe(1); // the stand-in outline
  });

  test('text box: a rotated box turns its corners about the box centre', () => {
    const ri = boardItemToRenderItems(textBox('tb', 10, 10, 20, 16, 'Hi', { angle: 90 }))[0]!;
    const pts = (ri.prims[0] as { outline: Array<{ x: number; y: number }> }).outline;
    // 90 deg about (15, 13): (10,10) -> (12,18), (20,10) -> (12,8)
    expect(pts[0]!.x).toBeCloseTo(12 * MM, -3);
    expect(pts[0]!.y).toBeCloseTo(18 * MM, -3);
    expect(pts[1]!.x).toBeCloseTo(12 * MM, -3);
    expect(pts[1]!.y).toBeCloseTo(8 * MM, -3);
    // the same corners are what a server reply's border edges are matched against
    const edges = pts.map((c, i) => ({ segment: { start: { xNm: c.x, yNm: c.y }, end: { xNm: pts[(i + 1) % 4]!.x, yNm: pts[(i + 1) % 4]!.y } } }));
    // a reply that is nothing but those edges leaves no glyphs, so the stand-in outline is kept
    const withShapes = boardItemToRenderItems(textBox('tb', 10, 10, 20, 16, 'Hi', { angle: 90, border: false }), { textShapes: () => edges as never })[0]!;
    expect(withShapes.prims.length).toBe(1);
    expect((withShapes.prims[0] as { outline: Array<{ x: number; y: number }> }).outline).toEqual(pts);
  });

  test('table: cells draw text only, the table draws its own borders and separators', () => {
    const t = table('tbl', 0, 0, 10, 5, ['a', 'b']);
    const noShapes = boardItemToRenderItems(t)[0]!;
    // external border (dashed) + one column separator, and no per-cell rectangles
    expect(noShapes.layer).toBe('BL_Dwgs_User');
    expect(noShapes.bbox).toMatchObject({ x: -75_000, y: -75_000 });
    const seg1 = noShapes.prims.filter((p) => p.kind === 'segment');
    expect(seg1.length).toBeGreaterThan(0);
    const glyph = [{ segment: { start: { xNm: 1 * MM, yNm: 1 * MM }, end: { xNm: 2 * MM, yNm: 1 * MM } } }];
    const withShapes = boardItemToRenderItems(t, { textShapes: (key) => (key === 'tbl-c0' ? (glyph as never) : undefined) })[0]!;
    expect(withShapes.prims.length).toBe(noShapes.prims.length + 1);
  });

  test('synthetic board converts without errors and covers many layers', () => {
    const all = syntheticBoard().flatMap((it) => boardItemToRenderItems(it));
    const layers = new Set(all.map((i) => i.layer));
    for (const l of ['BL_F_Cu', 'BL_B_Cu', 'BL_F_SilkS', 'BL_B_SilkS', 'BL_Edge_Cuts', 'BL_F_CrtYd', 'BL_B_CrtYd', 'board.via_hole', 'BL_Dwgs_User', 'BL_Cmts_User', 'BL_F_Fab']) {
      expect(layers.has(l)).toBe(true);
    }
    expect(all.length).toBeGreaterThan(30);
  });
});

describe('board layers', () => {
  test('enum <-> name normalisation', () => {
    expect(boardLayerName(3)).toBe('BL_F_Cu');
    expect(boardLayerName(34)).toBe('BL_B_Cu');
    expect(boardLayerName(98)).toBe('BL_User_45');
    expect(boardLayerName(62)).toBe('BL_Rescue');
    expect(boardLayerName('F.Cu')).toBe('BL_F_Cu');
    expect(boardLayerName('BL_In1_Cu')).toBe('BL_In1_Cu');
    expect(boardLayerName(999)).toBe('BL_UNKNOWN');
    expect(BOARD_LAYER_ENUM.BL_User_10).toBe(63);
    expect(flipLayer('BL_F_SilkS')).toBe('BL_B_SilkS');
    expect(flipLayer('BL_Edge_Cuts')).toBe('BL_Edge_Cuts');
    expect(copperLayerList(4)).toEqual(['BL_F_Cu', 'BL_In1_Cu', 'BL_In2_Cu', 'BL_B_Cu']);
  });

  test('draw order follows pcbnew: front on top for a front view, flipped for back view, active layer raised', () => {
    const idx = (order: string[], l: string) => order.indexOf(l);
    const front = boardDrawOrder({ copperLayers: copperLayerList(4) });
    expect(idx(front, 'BL_F_Cu')).toBeGreaterThan(idx(front, 'BL_In1_Cu'));
    expect(idx(front, 'BL_In1_Cu')).toBeGreaterThan(idx(front, 'BL_In2_Cu'));
    expect(idx(front, 'BL_In2_Cu')).toBeGreaterThan(idx(front, 'BL_B_Cu'));
    expect(idx(front, 'BL_F_SilkS')).toBeGreaterThan(idx(front, 'BL_F_Cu'));
    expect(idx(front, 'board.via_hole')).toBeGreaterThan(idx(front, 'BL_F_Fab'));
    expect(idx(front, 'BL_Edge_Cuts')).toBeGreaterThan(idx(front, 'board.via_hole'));
    expect(idx(front, 'BL_Dwgs_User')).toBe(front.length - 1 - 12); // topmost drawing layer before labels / grid items / overlays / markers (ALWAYS_TOP)
    expect(new Set(front).size).toBe(front.length);

    const back = boardDrawOrder({ copperLayers: copperLayerList(4), flipped: true, activeLayer: 'BL_B_Cu' });
    expect(idx(back, 'BL_B_Cu')).toBeGreaterThan(idx(back, 'BL_F_Cu'));
    expect(idx(back, 'BL_In2_Cu')).toBeGreaterThan(idx(back, 'BL_In1_Cu'));
    expect(idx(back, 'BL_B_SilkS')).toBeGreaterThan(idx(back, 'BL_B_Cu'));

    const activeBack = boardDrawOrder({ copperLayers: copperLayerList(2), activeLayer: 'BL_B_Cu' });
    expect(idx(activeBack, 'BL_B_Cu')).toBeGreaterThan(idx(activeBack, 'BL_F_Cu'));
    expect(idx(activeBack, 'BL_B_SilkS')).toBeGreaterThan(idx(activeBack, 'BL_F_SilkS'));
    expect(idx(activeBack, 'board.via_hole')).toBeGreaterThan(idx(activeBack, 'BL_B_Cu'));

    const activeInner = boardDrawOrder({ copperLayers: copperLayerList(4), activeLayer: 'BL_In2_Cu' });
    expect(idx(activeInner, 'BL_In2_Cu')).toBeGreaterThan(idx(activeInner, 'BL_F_Fab'));

    const activeUser = boardDrawOrder({ activeLayer: 'BL_Cmts_User' });
    expect(idx(activeUser, 'BL_Cmts_User')).toBeGreaterThan(idx(activeUser, 'BL_Dwgs_User'));
  });
});
