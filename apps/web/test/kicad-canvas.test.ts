/**
 * KicadCanvas server-shape caches (GetPadShapeAsPolygon / GetTextAsShapes) are per store, not
 * per host: a second mount of the same store (React StrictMode's double mount, switching back
 * to the board tab) must not ask KiCad for every pad polygon again, and results still in flight
 * land on the host that is showing the store now.
 */
import { describe, expect, test } from 'bun:test';
import type { ItemStore, StoreDiff, StoredItem } from '@/contracts';
import { PadPolygonCache, TextShapeCache, boardCachesFor } from '@/services/kicad/KicadCanvas';
import type { KicadDocumentService } from '@/services/kicad/KicadDocumentService';

/** Just what the caches read (`all()`); passed as an ItemStore where the factory wants one. */
class FakeStore {
  readonly kind = 'board' as const;
  private items = new Map<string, StoredItem>();
  constructor(items: StoredItem[]) {
    for (const it of items) this.items.set(it.id, it);
  }
  all(): Iterable<StoredItem> {
    return this.items.values();
  }
  byType(type: string): Iterable<StoredItem> {
    return [...this.items.values()].filter((i) => i.type === type);
  }
  get(id: string): StoredItem | undefined {
    return this.items.get(id);
  }
  subscribe(_cb: (diff: StoreDiff) => void): () => void {
    return () => {};
  }
  asStore(): ItemStore {
    return this as unknown as ItemStore;
  }
}

const pad = (id: string, x = 0): StoredItem =>
  ({ id, type: 'KOT_PCB_PAD', layer: 'BL_F_Cu', proto: { $typeName: 'kiapi.board.types.Pad', id: { value: id }, position: { xNm: BigInt(x), yNm: 0n } }, item: null }) as unknown as StoredItem;

/** A document service that answers pad polygons after `release()` and counts the requests. */
function fakeDocs() {
  const calls: Array<{ ids: string[]; layer: number }> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const docs = {
    copperLayers: ['BL_F_Cu', 'BL_B_Cu'],
    boardDoc: {
      async padShapesAsPolygons(ids: string[], layer: number) {
        calls.push({ ids: [...ids], layer });
        await gate;
        return new Map(ids.map((id) => [id, { outline: { nodes: [] }, holes: [] }]));
      },
    },
    kicad: {
      async textAsShapes(reqs: unknown[]) {
        return reqs.map(() => ({ shapes: { shapes: [] } }));
      },
    },
  } as unknown as KicadDocumentService;
  return { docs, calls, release: () => release() };
}

describe('KicadCanvas shape caches', () => {
  test('boardCachesFor hands the same caches to every host of one store', () => {
    const { docs } = fakeDocs();
    const store = new FakeStore([pad('p1')]);
    const a = boardCachesFor(store.asStore(), docs);
    const b = boardCachesFor(store.asStore(), docs);
    expect(b.pads).toBe(a.pads);
    expect(b.texts).toBe(a.texts);
    expect(boardCachesFor(new FakeStore([]).asStore(), docs).pads).not.toBe(a.pads);
    expect(a.pads).toBeInstanceOf(PadPolygonCache);
    expect(a.texts).toBeInstanceOf(TextShapeCache);
  });

  test('a second request for the same pads sends nothing, even while the first is in flight, and onReady goes to the current host', async () => {
    const { docs, calls, release } = fakeDocs();
    const store = new FakeStore([pad('p1'), pad('p2', 1_000_000)]);
    const { pads } = boardCachesFor(store.asStore(), docs);
    const ready: string[] = [];
    pads.onReady = () => ready.push('host-1');
    const first = pads.request(store.all(), docs.copperLayers);
    // the "remount": a new host takes over the store before KiCad has answered
    pads.onReady = () => ready.push('host-2');
    const second = pads.request(store.all(), docs.copperLayers);
    release();
    // 2 pads x 2 copper layers arrive once in total, whichever call carried which layer
    expect((await first) + (await second)).toBe(4);
    const asked = calls.map((c) => `${c.layer}:${c.ids.join(',')}`).sort();
    expect(asked).toEqual(['34:p1,p2', '3:p1,p2']); // F.Cu = 3, B.Cu = 34: one request per layer, never repeated
    expect(new Set(ready)).toEqual(new Set(['host-2'])); // the polygons reached the host that shows the store now
    expect(pads.get('p1', 'BL_F_Cu')).toBeDefined();
    expect(pads.get('p2', 'BL_B_Cu')).toBeDefined();
    expect(pads.size).toBe(4);
  });

  test('invalidate re-fetches only the pads named', async () => {
    const { docs, calls, release } = fakeDocs();
    release();
    const store = new FakeStore([pad('p1'), pad('p2')]);
    const pads = new PadPolygonCache(docs, () => {});
    await pads.request(store.all(), ['BL_F_Cu']);
    pads.invalidate(['p2']);
    await pads.request(store.all(), ['BL_F_Cu']);
    expect(calls.map((c) => c.ids)).toEqual([['p1', 'p2'], ['p2']]);
  });

  test('a failed request is forgotten so the next mount retries it', async () => {
    const calls: string[][] = [];
    let fail = true;
    const docs = {
      boardDoc: {
        async padShapesAsPolygons(ids: string[]) {
          calls.push([...ids]);
          if (fail) throw new Error('AS_BUSY');
          return new Map(ids.map((id) => [id, { outline: { nodes: [] }, holes: [] }]));
        },
      },
    } as unknown as KicadDocumentService;
    const warnings: string[] = [];
    const pads = new PadPolygonCache(docs, (m, level) => level === 'warn' && warnings.push(m));
    const store = new FakeStore([pad('p1')]);
    expect(await pads.request(store.all(), ['BL_F_Cu'])).toBe(0);
    expect(warnings[0]).toMatch(/GetPadShapeAsPolygon\(BL_F_Cu\) failed: AS_BUSY/);
    fail = false;
    expect(await pads.request(store.all(), ['BL_F_Cu'])).toBe(1);
    expect(calls).toEqual([['p1'], ['p1']]);
  });
});
