import './setup';
import { describe, expect, test } from 'bun:test';
import { flipItem, rotateItem, translateItem } from '@/lib/geometry';
import { buildBoard } from '@/services/mock/kitchenSink';
import { mm } from '@/lib/units';

describe('geometry', () => {
  const { store, ids } = buildBoard();

  test('translate moves every positional vector but not sizes, and shifts bbox', () => {
    const pad = store.get(ids['R1.1']!)!;
    const moved = translateItem(pad, mm(1), mm(2));
    const p = moved.proto as { position: { xNm: number; yNm: number }; padStack: { copperLayers: { size: { xNm: number } }[] } };
    const o = pad.proto as typeof p;
    expect(p.position.xNm - o.position.xNm).toBe(mm(1));
    expect(p.position.yNm - o.position.yNm).toBe(mm(2));
    expect(p.padStack.copperLayers[0]!.size.xNm).toBe(o.padStack.copperLayers[0]!.size.xNm);
    expect(moved.bbox!.x - pad.bbox!.x).toBe(mm(1));
    expect(pad.proto).not.toBe(moved.proto);
  });

  test('rotate 90° about the footprint centre bumps orientation and swaps bbox extents', () => {
    const fp = store.get(ids.R1!)!;
    const c = { x: fp.bbox!.x + fp.bbox!.w / 2, y: fp.bbox!.y + fp.bbox!.h / 2 };
    const r = rotateItem(fp, c.x, c.y, 90);
    expect((r.proto as { orientation: { valueDegrees: number } }).orientation.valueDegrees).toBe(90);
    expect(Math.round(r.bbox!.w)).toBe(Math.round(fp.bbox!.h));
    expect(Math.round(r.bbox!.h)).toBe(Math.round(fp.bbox!.w));
  });

  test('flip mirrors x, swaps front/back layers', () => {
    const fp = store.get(ids.R1!)!;
    const f = flipItem(fp, mm(30));
    expect(f.layer).toBe('BL_B_Cu');
    expect((f.proto as { layer: string }).layer).toBe('BL_B_Cu');
    expect((f.proto as { position: { xNm: number } }).position.xNm).toBe(mm(60) - (fp.proto as { position: { xNm: number } }).position.xNm);
    const pad = store.get(ids['R1.1']!)!;
    const fpad = flipItem(pad, mm(30));
    expect((fpad.proto as { padStack: { layers: string[] } }).padStack.layers).toEqual(['BL_B_Cu', 'BL_B_Paste', 'BL_B_Mask']);
  });
});
