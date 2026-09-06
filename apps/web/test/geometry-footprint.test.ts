import './setup';
import { describe, expect, test } from 'bun:test';
import { create } from '@bufbuild/protobuf';
import { BoardLayer, FootprintInstanceSchema, PadSchema, PadStackShape, PadStackType, packAny, unpackAny, type Any, type FootprintInstance, type Pad } from '@kicad-web/proto';
import type { StoredItem } from '@/contracts';
import { flipItem, mapDefinitionItems, rotateItem, translateItem } from '@/lib/geometry';

const FP = { x: 125_200_000, y: 90_900_000 };
const PAD = { x: 124_375_000, y: 90_900_000 }; // (-825000, 0) from the anchor

function makePad(): Pad {
  return create(PadSchema, {
    id: { value: 'bbbbbbbb-0000-4000-8000-000000000001' },
    number: '1',
    position: { xNm: BigInt(PAD.x), yNm: BigInt(PAD.y) },
    padStack: {
      type: PadStackType.PST_NORMAL,
      layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_F_Paste, BoardLayer.BL_F_Mask],
      angle: { valueDegrees: 0 },
      copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: PadStackShape.PSS_RECTANGLE, size: { xNm: 1000000n, yNm: 950000n } }],
    },
  });
}

function makeItem(): StoredItem {
  const id = 'cccccccc-0000-4000-8000-000000000001';
  const proto = create(FootprintInstanceSchema, {
    id: { value: id },
    position: { xNm: BigInt(FP.x), yNm: BigInt(FP.y) },
    orientation: { valueDegrees: 0 },
    layer: BoardLayer.BL_F_Cu,
    definition: { id: { libraryNickname: 'Resistor_SMD', entryName: 'R_0402_1005Metric' }, items: [packAny(PadSchema, makePad())] },
    referenceField: { name: 'Reference', visible: true, text: { layer: BoardLayer.BL_F_SilkS, text: { text: 'R1', position: { xNm: BigInt(FP.x), yNm: BigInt(FP.y - 1_430_000) } } } },
  });
  return { id, type: 'KOT_PCB_FOOTPRINT', layer: 'BL_F_Cu', proto, bbox: { x: 124_200_000, y: 90_000_000, w: 2_000_000, h: 1_800_000 } };
}

const fp = (item: StoredItem) => item.proto as FootprintInstance;
const padOf = (item: StoredItem): Pad => {
  const raw = fp(item).definition!.items[0]! as Any;
  expect(raw.$typeName).toBe('google.protobuf.Any');
  return unpackAny(raw) as Pad;
};

describe('geometry: footprint instances with packed children', () => {
  test('the fixture unpacks to the pad at its absolute position', () => {
    const item = makeItem();
    const pad = padOf(item);
    expect(pad.$typeName).toBe('kiapi.board.types.Pad');
    expect(pad.position).toMatchObject({ xNm: 124375000n, yNm: 90900000n });
  });

  test('translateItem moves the anchor, the fields and the packed pad by the same delta', () => {
    const item = makeItem();
    const moved = translateItem(item, 5_000_000, 0);
    expect(fp(moved).position).toMatchObject({ xNm: 130200000n, yNm: 90900000n });
    expect(fp(moved).referenceField?.text?.text?.position).toMatchObject({ xNm: 130200000n, yNm: BigInt(FP.y - 1_430_000) });

    const pad = padOf(moved);
    expect(pad.position).toMatchObject({ xNm: 129375000n, yNm: 90900000n });
    expect(pad.number).toBe('1');
    expect(pad.padStack?.copperLayers[0]?.size).toMatchObject({ xNm: 1000000n, yNm: 950000n });
    expect(pad.padStack?.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_F_Paste, BoardLayer.BL_F_Mask]);

    expect(moved.bbox).toEqual({ ...item.bbox!, x: item.bbox!.x + 5_000_000 });
    expect(moved.layer).toBe('BL_F_Cu');
    // the source item is untouched
    expect(fp(item).position?.xNm).toBe(125200000n);
    expect(padOf(item).position?.xNm).toBe(124375000n);
    expect(moved.proto).not.toBe(item.proto);
  });

  test('translateItem in y too', () => {
    const moved = translateItem(makeItem(), -1_000_000, 2_500_000);
    expect(fp(moved).position).toMatchObject({ xNm: 124200000n, yNm: 93400000n });
    expect(padOf(moved).position).toMatchObject({ xNm: 123375000n, yNm: 93400000n });
  });

  test('rotateItem 90° about the anchor keeps the anchor, bumps orientation and swings the pad onto the y axis', () => {
    const item = makeItem();
    const r = rotateItem(item, FP.x, FP.y, 90);
    expect(fp(r).position).toMatchObject({ xNm: 125200000n, yNm: 90900000n });
    expect(fp(r).orientation?.valueDegrees).toBe(90);

    const pad = padOf(r);
    // the (-825000, 0) offset becomes a pure y offset of the same length
    expect(pad.position?.xNm).toBe(125200000n);
    const dy = Number(pad.position!.yNm) - FP.y;
    expect(Math.abs(dy)).toBe(825_000);
    // KiCad y-down convention as implemented: rotating (-x, 0) by +90 lands at (0, +x)
    expect(pad.position?.yNm).toBe(91725000n);
    expect(pad.padStack?.angle?.valueDegrees).toBe(90);
    expect(pad.padStack?.copperLayers[0]?.size).toMatchObject({ xNm: 1000000n, yNm: 950000n });

    // bbox extents swap
    expect(Math.round(r.bbox!.w)).toBe(item.bbox!.h);
    expect(Math.round(r.bbox!.h)).toBe(item.bbox!.w);
    // the source item is untouched
    expect(fp(item).orientation?.valueDegrees).toBe(0);
    expect(padOf(item).position?.yNm).toBe(90900000n);
  });

  test('rotateItem 180° puts the pad on the other side; four quarter turns come back', () => {
    const item = makeItem();
    const r = rotateItem(item, FP.x, FP.y, 180);
    expect(fp(r).orientation?.valueDegrees).toBe(180);
    expect(padOf(r).position).toMatchObject({ xNm: 126025000n, yNm: 90900000n });

    let cur = item;
    for (let i = 0; i < 4; i++) cur = rotateItem(cur, FP.x, FP.y, 90);
    expect(fp(cur).orientation?.valueDegrees).toBe(0);
    expect(padOf(cur).position).toMatchObject({ xNm: 124375000n, yNm: 90900000n });
  });

  test('flipItem swaps the footprint and pad layers and mirrors x about the centre', () => {
    const item = makeItem();
    const f = flipItem(item, FP.x);
    expect(f.layer).toBe('BL_B_Cu');
    expect(fp(f).layer).toBe(BoardLayer.BL_B_Cu);
    expect(fp(f).position).toMatchObject({ xNm: 125200000n, yNm: 90900000n });
    expect(fp(f).referenceField?.text?.layer).toBe(BoardLayer.BL_B_SilkS);

    const pad = padOf(f);
    expect(pad.position).toMatchObject({ xNm: 126025000n, yNm: 90900000n });
    expect(pad.padStack?.layers).toEqual([BoardLayer.BL_B_Cu, BoardLayer.BL_B_Paste, BoardLayer.BL_B_Mask]);
    expect(pad.padStack?.copperLayers[0]?.size).toMatchObject({ xNm: 1000000n, yNm: 950000n });

    expect(f.bbox).toEqual({ ...item.bbox!, x: 2 * FP.x - item.bbox!.x - item.bbox!.w });
    // the source item is untouched
    expect(item.layer).toBe('BL_F_Cu');
    expect(padOf(item).padStack?.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_F_Paste, BoardLayer.BL_F_Mask]);
  });

  test('flipItem about a different centre moves the anchor and the pad consistently; flipping twice restores', () => {
    const item = makeItem();
    const cx = 100_000_000;
    const f = flipItem(item, cx);
    expect(fp(f).position).toMatchObject({ xNm: BigInt(2 * cx - FP.x), yNm: 90900000n });
    expect(padOf(f).position).toMatchObject({ xNm: BigInt(2 * cx - PAD.x), yNm: 90900000n });

    const back = flipItem(f, cx);
    expect(back.layer).toBe('BL_F_Cu');
    expect(fp(back).layer).toBe(BoardLayer.BL_F_Cu);
    expect(fp(back).position).toMatchObject({ xNm: 125200000n, yNm: 90900000n });
    expect(padOf(back).position).toMatchObject({ xNm: 124375000n, yNm: 90900000n });
    expect(padOf(back).padStack?.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_F_Paste, BoardLayer.BL_F_Mask]);
  });
});

describe('geometry: mapDefinitionItems', () => {
  test('already-decoded children are edited in place and kept by reference', () => {
    const child = { $typeName: 'kiapi.board.types.Pad', position: { xNm: 1n, yNm: 2n } };
    const proto: Record<string, unknown> = { definition: { items: [child] } };
    const seen: unknown[] = [];
    mapDefinitionItems(proto, (c) => {
      seen.push(c);
      (c.position as { xNm: bigint }).xNm = 99n;
    });
    const items = (proto.definition as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toBe(child);
    expect(seen[0]).toBe(child);
    expect(child.position.xNm).toBe(99n);
  });

  test('packed children are unpacked, edited and repacked; the original Any is not mutated', () => {
    const original = packAny(PadSchema, makePad());
    const proto: Record<string, unknown> = { definition: { items: [original] } };
    mapDefinitionItems(proto, (c) => {
      (c.position as { xNm: bigint }).xNm = 5n;
    });
    const items = (proto.definition as { items: Any[] }).items;
    expect(items[0]).not.toBe(original);
    expect((unpackAny(items[0]!) as Pad).position?.xNm).toBe(5n);
    expect((unpackAny(original) as Pad).position?.xNm).toBe(124375000n);
  });

  test('no definition or empty items is a no-op', () => {
    let calls = 0;
    const none: Record<string, unknown> = { position: { xNm: 0n, yNm: 0n } };
    mapDefinitionItems(none, () => calls++);
    const empty: Record<string, unknown> = { definition: { items: [] } };
    mapDefinitionItems(empty, () => calls++);
    expect(calls).toBe(0);
    expect((empty.definition as { items: unknown[] }).items).toEqual([]);
  });
});
