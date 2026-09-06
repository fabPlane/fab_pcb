import './setup';
import { describe, expect, test } from 'bun:test';
import { applyPatch, applyPatches, getPath, inversePatch } from '@/lib/patch';

describe('patch', () => {
  const track = { id: { value: 'a' }, width: { valueNm: 250_000 }, start: { xNm: 1, yNm: 2 }, layers: ['BL_F_Cu', 'BL_B_Cu'] };

  test('applyPatch returns a new object and shares untouched branches', () => {
    const next = applyPatch(track, { path: ['width', 'valueNm'], value: 300_000 });
    expect(next.width.valueNm).toBe(300_000);
    expect(track.width.valueNm).toBe(250_000);
    expect(next.start).toBe(track.start);
    expect(next.id).toBe(track.id);
  });

  test('array patches set, append and remove slots', () => {
    const set = applyPatch(track, { path: ['layers', 1], value: 'BL_In1_Cu' });
    expect(set.layers).toEqual(['BL_F_Cu', 'BL_In1_Cu']);
    const appended = applyPatch(track, { path: ['layers', 2], value: 'BL_B_Cu' });
    expect(appended.layers).toHaveLength(3);
    const removed = applyPatch(track, { path: ['layers', 0], value: undefined });
    expect(removed.layers).toEqual(['BL_B_Cu']);
  });

  test('inversePatch restores the previous value', () => {
    const patch = { path: ['start', 'xNm'], value: 99 };
    const inv = inversePatch(track, patch);
    const roundTrip = applyPatches(track, [patch, inv]);
    expect(roundTrip).toEqual(track);
    expect(getPath(roundTrip, ['start', 'xNm'])).toBe(1);
  });

  test('creates intermediate objects for missing paths', () => {
    const next = applyPatch({} as Record<string, unknown>, { path: ['a', 'b', 0], value: 1 });
    expect(next).toEqual({ a: { b: [1] } });
  });
});
