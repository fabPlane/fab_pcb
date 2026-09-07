/**
 * BoardCanvasHost without a renderer (`setStore` builds the scene headlessly, like scene.test):
 * footprint children that the store holds as items of their own are drawn from the store, owned
 * by the footprint; definition copies (`google.protobuf.Any` from the KiCad API) are decoded and
 * drawn only for children the store does not hold; hover callbacks fire on every pointer move.
 *
 * Regression for the demo boards (docs/board-practice.md): every footprint came with its
 * `definition.items` as Any, which the adapter could not read, while the store's own pads were
 * skipped because the definition was non-empty — no pads, silk or courtyards were drawn at all.
 */
import { describe, expect, test } from 'bun:test';
import { BoardCanvasHost } from '../src/board/BoardCanvasHost.js';
import type { ItemStoreLike, StoreDiffLike, StoredItemLike } from '../src/core/host.js';
import { boxContains } from '../src/core/model.js';
import { MM, footprint, fpShape, pad, seg } from './fixtures.js';
import { BOARD_LAYER_ENUM } from '../src/board/boardLayers.js';

/** Wraps a definition child the way the API delivers it: an Any with the message as payload. */
const asAny = (msg: Record<string, unknown>) => ({ $typeName: 'google.protobuf.Any', typeUrl: `type.googleapis.com/${msg.$typeName}`, value: msg });
const decodeAny = (a: unknown) => (a as { value: unknown }).value;

class FakeStore implements ItemStoreLike {
  readonly kind = 'board';
  private items = new Map<string, StoredItemLike>();
  private subs = new Set<(d: StoreDiffLike) => void>();
  constructor(items: StoredItemLike[]) {
    for (const it of items) this.items.set(it.id, it);
  }
  all(): Iterable<StoredItemLike> {
    return this.items.values();
  }
  get(id: string): StoredItemLike | undefined {
    return this.items.get(id);
  }
  subscribe(cb: (d: StoreDiffLike) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(diff: Partial<StoreDiffLike>): void {
    const d: StoreDiffLike = { added: [], updated: [], removed: [], ...diff };
    for (const it of [...d.added, ...d.updated]) this.items.set(it.id, it);
    for (const id of d.removed) this.items.delete(id);
    for (const cb of this.subs) cb(d);
  }
}

/** R1 at (10, 10) whose definition children arrive as Any, plus its pads as store items. */
function board(): { fp: StoredItemLike; pads: StoredItemLike[]; store: FakeStore } {
  const fp = footprint('R1', 'R1', 10, 10, 0);
  const def = (fp.proto as { definition: { items: Record<string, unknown>[] } }).definition;
  def.items = def.items.map(asAny);
  // the store's copy of pad 1 carries the board's net, the definition copy still says GND
  const p1 = pad('R1-p1', '1', 9.2, 10, 0.9, 0.95, { net: 'SIGNAL_A', shape: 5 });
  const p2 = pad('R1-p2', '2', 10.8, 10, 0.9, 0.95, { net: 'VCC', shape: 5 });
  const pads: StoredItemLike[] = [
    { id: 'R1-p1', type: 'KOT_PCB_PAD', layer: 'BL_F_Cu', net: 'SIGNAL_A', parent: 'R1', proto: p1 },
    { id: 'R1-p2', type: 'KOT_PCB_PAD', layer: 'BL_F_Cu', net: 'VCC', parent: 'R1', proto: p2 },
  ];
  return { fp, pads, store: new FakeStore([fp, ...pads]) };
}

describe('BoardCanvasHost footprint children', () => {
  test('store pads render once, owned by the footprint, with the store net; Any silk decodes', () => {
    const { store } = board();
    const host = new BoardCanvasHost(undefined, { adapter: { decodeAny } });
    host.setStore(store);
    const p1 = host.getRenderItem('R1-p1@BL_F_Cu')!;
    expect(p1).toBeDefined();
    expect(p1.net).toBe('SIGNAL_A'); // from the store item, not the definition copy (GND)
    expect(p1.owner).toBe('R1');
    expect(p1.ref).toBe('R1-p1');
    // the definition's silk / courtyard were Any: decoded and drawn under the footprint
    expect(host.getRenderItem('R1-silk')).toBeDefined();
    expect(host.getRenderItem('R1-crtyd')?.owner).toBe('R1');
    // the footprint body still spans its pads (they are counted even though the store draws them)
    const body = host.getRenderItem('R1')!;
    expect(body.prims).toEqual([]);
    expect(boxContains(body.bbox, { x: 9.2 * MM, y: 10 * MM })).toBe(true);
    expect(boxContains(body.bbox, { x: 10.8 * MM, y: 10 * MM })).toBe(true);
    // one pad-1 copper item in the whole scene
    let copies = 0;
    for (const it of (host as unknown as { scene: { items(): Iterable<{ id: string }> } }).scene.items()) if (it.id === 'R1-p1@BL_F_Cu') copies++;
    expect(copies).toBe(1);
  });

  test('without decodeAny the store pads still render and Any children are skipped, not fatal', () => {
    const { store } = board();
    const host = new BoardCanvasHost();
    host.setStore(store);
    expect(host.getRenderItem('R1-p1@BL_F_Cu')?.net).toBe('SIGNAL_A');
    expect(host.getRenderItem('R1-silk')).toBeUndefined();
    expect(host.getRenderItem('R1')).toBeDefined();
  });

  test('selecting the footprint selects the pads the store draws for it', () => {
    const { store } = board();
    const host = new BoardCanvasHost(undefined, { adapter: { decodeAny } });
    host.setStore(store);
    host.setSelection(['R1']);
    expect((host as unknown as { selectionIds: string[] }).selectionIds.sort()).toEqual(['R1', 'R1-p1', 'R1-p2']);
  });

  test('removing a store pad hands it back to the definition; adding one takes it over', () => {
    const { store, pads } = board();
    const host = new BoardCanvasHost(undefined, { adapter: { decodeAny } });
    host.setStore(store);
    store.emit({ removed: ['R1-p1'] });
    // the footprint was rebuilt: pad 1 now comes from the (decoded) definition copy
    expect(host.getRenderItem('R1-p1@BL_F_Cu')?.net).toBe('GND');
    expect(host.getRenderItem('R1-p2@BL_F_Cu')?.net).toBe('VCC');
    store.emit({ added: [pads[0]!] });
    expect(host.getRenderItem('R1-p1@BL_F_Cu')?.net).toBe('SIGNAL_A');
  });

  test('a through-hole *.Cu pad draws only the board’s copper layers', () => {
    const p = pad('J1-1', '1', 5, 5, 1.6, 1.6, { smd: false, net: 'GND', shape: 1 });
    // KiCad lists every inner layer for `*.Cu`: 3 = F.Cu, 4..33 = In1..In30, 34 = B.Cu, 41/42 masks
    (p.padStack as { layers: number[] }).layers = [3, 42, 34, 41, ...Array.from({ length: 30 }, (_, i) => 4 + i)];
    const store = new FakeStore([{ id: 'J1-1', type: 'KOT_PCB_PAD', layer: 'BL_F_Cu', net: 'GND', proto: p }]);
    const host = new BoardCanvasHost(undefined, { copperLayers: ['BL_F_Cu', 'BL_B_Cu'] });
    host.setStore(store);
    const copper: string[] = [];
    for (const it of (host as unknown as { scene: { items(): Iterable<{ id: string; layer: string }> } }).scene.items()) if (/_Cu$/.test(it.layer)) copper.push(it.layer);
    expect(copper.sort()).toEqual(['BL_B_Cu', 'BL_F_Cu']);
  });
});

describe('BoardCanvasHost pick', () => {
  test('among exact hits the active layer wins: pad over the fab line crossing it, fab line when F.Fab is active', () => {
    const { store, fp } = board();
    // a thin F.Fab line through pad 1's centre (tiny bbox: it would win the smallest-area rule)
    const def = (fp.proto as { definition: { items: Record<string, unknown>[] } }).definition;
    def.items.push(asAny(fpShape('R1-fabline', BOARD_LAYER_ENUM.BL_F_Fab!, seg(9.0, 10, 9.4, 10), 0.05)));
    const host = new BoardCanvasHost(undefined, { adapter: { decodeAny } });
    host.setStore(store);
    host.setCamera({ x: 10 * MM, y: 10 * MM, zoom: 100 / MM });
    expect(host.getRenderItem('R1-fabline')?.layer).toBe('BL_F_Fab');
    const p = host.worldToScreen(9.2 * MM, 10 * MM);
    const top = host.pick(p.x, p.y, 5).map((h) => h.id);
    expect(top[0]).toBe('R1-p1@BL_F_Cu');
    expect(top).toContain('R1-fabline');
    host.setActiveLayer('BL_F_Fab');
    expect(host.pick(p.x, p.y, 5)[0]!.id).toBe('R1-fabline');
    // a hit on no active-layer item keeps the nearest-then-smallest order
    host.setActiveLayer('BL_B_Cu');
    expect(host.pick(p.x, p.y, 5)[0]!.id).toBe('R1-fabline');
  });
});

describe('BoardCanvasHost hover', () => {
  test('hover callbacks fire on every pointer move, not only when the hovered item changes', () => {
    const { store } = board();
    class Probe extends BoardCanvasHost {
      hover(x: number, y: number): void {
        this.updateHover({ clientX: x, clientY: y, currentTarget: null } as unknown as PointerEvent);
      }
    }
    const host = new Probe(undefined, { adapter: { decodeAny } });
    host.setStore(store);
    host.setCamera({ x: 10 * MM, y: 10 * MM, zoom: 100 / MM }); // 100 px per mm
    const calls: Array<string | null> = [];
    host.onHover((hit) => calls.push(hit?.ref ?? null));
    const p = host.worldToScreen(9.2 * MM, 10 * MM);
    host.hover(p.x, p.y);
    host.hover(p.x + 2, p.y + 1); // still on pad 1
    host.hover(p.x + 4, p.y + 2);
    expect(calls).toEqual(['R1-p1', 'R1-p1', 'R1-p1']);
  });
});
