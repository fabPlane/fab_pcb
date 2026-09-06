import './setup';
import { describe, expect, test } from 'bun:test';
import { MemoryItemStore } from '@/services/MemoryItemStore';
import type { StoredItem } from '@/contracts';

const item = (id: string, type: string, extra: Partial<StoredItem> = {}): StoredItem => ({ id, type, proto: { id: { value: id } }, ...extra });

describe('MemoryItemStore', () => {
  test('indexes by type, layer and net and emits one diff per batch', () => {
    const store = new MemoryItemStore('board', {}, 'board');
    const diffs: number[] = [];
    store.subscribe((d) => diffs.push(d.added.length + d.updated.length + d.removed.length));
    store.batch(() => {
      store.insert(item('t1', 'KOT_PCB_TRACE', { layer: 'BL_F_Cu', net: 'SIG' }));
      store.insert(item('t2', 'KOT_PCB_TRACE', { layer: 'BL_B_Cu', net: 'SIG' }));
      store.insert(item('v1', 'KOT_PCB_VIA', { layer: 'BL_F_Cu', net: 'GND' }));
    });
    expect(diffs).toEqual([3]);
    expect(store.revision).toBe(1);
    expect([...store.byType('KOT_PCB_TRACE')].map((i) => i.id)).toEqual(['t1', 't2']);
    expect([...store.byLayer('BL_F_Cu')].map((i) => i.id).sort()).toEqual(['t1', 'v1']);
    expect([...store.byNet('SIG')]).toHaveLength(2);
  });

  test('replace re-indexes and remove drops from every index', () => {
    const store = new MemoryItemStore('board', {}, 'board');
    store.insert(item('t1', 'KOT_PCB_TRACE', { layer: 'BL_F_Cu', net: 'SIG' }));
    store.replace(item('t1', 'KOT_PCB_TRACE', { layer: 'BL_B_Cu', net: 'GND' }));
    expect([...store.byLayer('BL_F_Cu')]).toHaveLength(0);
    expect([...store.byNet('GND')]).toHaveLength(1);
    expect(store.revision).toBe(2);
    store.remove('t1');
    expect(store.get('t1')).toBeUndefined();
    expect([...store.byType('KOT_PCB_TRACE')]).toHaveLength(0);
    expect([...store.byNet('GND')]).toHaveLength(0);
    expect(store.revision).toBe(3);
  });

  test('an empty batch does not bump the revision', () => {
    const store = new MemoryItemStore('board', {}, 'board');
    store.batch(() => {});
    store.remove('missing');
    expect(store.revision).toBe(0);
  });
});
