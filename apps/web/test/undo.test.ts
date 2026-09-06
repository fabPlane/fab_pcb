import './setup';
import { describe, expect, test } from 'bun:test';
import { CommandServiceImpl, MockCommitBackend } from '@/services/CommandService';
import { buildBoard } from '@/services/mock/kitchenSink';
import { MemoryItemStore } from '@/services/MemoryItemStore';
import { mm } from '@/lib/units';

function setup() {
  const { store, ids } = buildBoard();
  const commands = new CommandServiceImpl(new MockCommitBackend());
  return { store, ids, commands };
}

const widthOf = (store: MemoryItemStore, id: string) => (store.get(id)!.proto as { width: { valueNm: number } }).width.valueNm;

describe('CommandService undo/redo', () => {
  test('commit applies the patch, records history, undo/redo replay inverse and forward ops', async () => {
    const { store, ids, commands } = setup();
    const t1 = ids.t1!;
    expect(widthOf(store, t1)).toBe(mm(0.25));
    const revBefore = store.revision;

    await commands.run(store, 'Edit track width', (tx) => tx.update(t1, [{ path: ['width', 'valueNm'], value: mm(0.5) }]));
    expect(widthOf(store, t1)).toBe(mm(0.5));
    expect(commands.canUndo()).toBe(true);
    expect(commands.canRedo()).toBe(false);
    expect(commands.history().undo[0]!.message).toBe('Edit track width');
    expect(store.revision).toBeGreaterThan(revBefore);

    const undone = await commands.undo();
    expect(undone?.message).toBe('Edit track width');
    expect(widthOf(store, t1)).toBe(mm(0.25));
    expect(commands.canUndo()).toBe(false);
    expect(commands.canRedo()).toBe(true);

    await commands.redo();
    expect(widthOf(store, t1)).toBe(mm(0.5));
    expect(commands.canRedo()).toBe(false);
  });

  test('a new commit after undo clears the redo stack', async () => {
    const { store, ids, commands } = setup();
    const t1 = ids.t1!;
    await commands.run(store, 'A', (tx) => tx.update(t1, [{ path: ['width', 'valueNm'], value: 1 }]));
    await commands.run(store, 'B', (tx) => tx.update(t1, [{ path: ['width', 'valueNm'], value: 2 }]));
    await commands.undo();
    expect(commands.history().redo).toHaveLength(1);
    await commands.run(store, 'C', (tx) => tx.update(t1, [{ path: ['width', 'valueNm'], value: 3 }]));
    expect(commands.history().redo).toHaveLength(0);
    expect(commands.history().undo.map((e) => e.message)).toEqual(['A', 'C']);
    await commands.undo();
    await commands.undo();
    expect(widthOf(store, t1)).toBe(mm(0.25));
  });

  test('drop rolls the store back and records nothing', async () => {
    const { store, ids, commands } = setup();
    const t1 = ids.t1!;
    const tx = commands.begin(store, 'Move preview');
    tx.update(t1, [{ path: ['width', 'valueNm'], value: 7 }]);
    tx.update(t1, [{ path: ['width', 'valueNm'], value: 8 }]);
    expect(widthOf(store, t1)).toBe(8);
    await tx.drop();
    expect(widthOf(store, t1)).toBe(mm(0.25));
    expect(commands.canUndo()).toBe(false);
    expect(() => tx.update(t1, [])).toThrow(/closed/);
  });

  test('multiple updates to one item collapse into a single op pair', async () => {
    const { store, ids, commands } = setup();
    const t1 = ids.t1!;
    await commands.run(store, 'Drag', (tx) => {
      for (let i = 1; i <= 10; i++) tx.update(t1, [{ path: ['width', 'valueNm'], value: i }]);
    });
    const entry = commands.history().undo[0]!;
    expect(entry.forward).toHaveLength(1);
    expect(entry.inverse).toHaveLength(1);
    expect((entry.inverse[0]!.item.proto as { width: { valueNm: number } }).width.valueNm).toBe(mm(0.25));
    await commands.undo();
    expect(widthOf(store, t1)).toBe(mm(0.25));
  });

  test('delete and create are each other’s inverse, children included', async () => {
    const { store, ids, commands } = setup();
    const r1 = ids.R1!;
    const pads = [...store.all()].filter((i) => i.parent === r1);
    expect(pads).toHaveLength(2);
    await commands.run(store, 'Delete R1', (tx) => {
      tx.delete(r1);
      for (const p of pads) tx.delete(p.id);
    });
    expect(store.get(r1)).toBeUndefined();
    expect([...store.byNet('VCC')].some((i) => i.parent === r1)).toBe(false);
    await commands.undo();
    expect(store.get(r1)).toBeDefined();
    expect([...store.all()].filter((i) => i.parent === r1)).toHaveLength(2);
    expect(store.get(pads[0]!.id)?.net).toBe(pads[0]!.net);
    await commands.redo();
    expect(store.get(r1)).toBeUndefined();
  });

  test('create then delete inside one transaction is a no-op (no history entry)', async () => {
    const { store, commands } = setup();
    await commands.run(store, 'Nothing', (tx) => {
      tx.create({ id: 'tmp', type: 'KOT_PCB_TEXT', proto: { id: { value: 'tmp' } } });
      tx.delete('tmp');
    });
    expect(commands.canUndo()).toBe(false);
    expect(store.get('tmp')).toBeUndefined();
  });

  test('updates keep layer/net metadata in sync with the proto and refresh the bbox', async () => {
    const { store, ids, commands } = setup();
    const t1 = ids.t1!;
    const before = store.get(t1)!;
    await commands.run(store, 'Relayer', (tx) => tx.update(t1, [{ path: ['layer'], value: 'BL_B_Cu' }, { path: ['net', 'name'], value: 'GND' }]));
    const after = store.get(t1)!;
    expect(after.layer).toBe('BL_B_Cu');
    expect(after.net).toBe('GND');
    expect([...store.byLayer('BL_B_Cu')].some((i) => i.id === t1)).toBe(true);
    await commands.run(store, 'Stretch', (tx) => tx.update(t1, [{ path: ['end', 'xNm'], value: mm(40) }]));
    expect(store.get(t1)!.bbox!.w).toBeGreaterThan(before.bbox!.w);
    const fp = ids.R1!;
    const fpBefore = store.get(fp)!.bbox!;
    await commands.run(store, 'Nudge', (tx) => tx.update(fp, [{ path: ['position', 'xNm'], value: mm(20) }]));
    expect(store.get(fp)!.bbox!.x - fpBefore.x).toBe(mm(8));
  });

  test('history change subscribers fire on commit, undo, redo and clear', async () => {
    const { store, ids, commands } = setup();
    let n = 0;
    const off = commands.onHistoryChange(() => n++);
    await commands.run(store, 'A', (tx) => tx.update(ids.t1!, [{ path: ['width', 'valueNm'], value: 1 }]));
    await commands.undo();
    await commands.redo();
    commands.clearHistory();
    off();
    expect(n).toBe(4);
  });
});
