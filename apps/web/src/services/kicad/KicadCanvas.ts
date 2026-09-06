// Real canvases: `BoardCanvasHost` / `SchematicCanvasHost` from `@kicad-web/renderer` with
// their adapter contexts fed from KiCad:
//   - `copperLayers` from GetBoardEnabledLayers,
//   - `padPolygons` from GetPadShapeAsPolygon (one request per copper layer, cached per pad/layer),
//   - `textShapes` from GetTextAsShapes (all board texts + footprint fields, or all sheet texts,
//     labels and symbol fields in one batched request; cached by a hash of the text so an edit
//     only re-tessellates what changed),
//   - `decodeAny` via the proto registry.
// The host first paints with the renderer's fallbacks and `setAdapterContext` upgrades it
// once the server shapes arrive; later store diffs only re-fetch the affected texts and
// `rebuildItems` them.

import { BoardLayer, unpackAny, type GraphicShape, type PolygonWithHoles, type Text } from '@kicad-web/proto';
import { BoardCanvasHost, SchematicCanvasHost, type Theme } from '@kicad-web/renderer';
import type { CanvasHost, DocumentKind, ItemStore, StoredItem } from '@/contracts';
import type { KicadDocumentService } from './KicadDocumentService';

const TEXT_BATCH = 200;

interface TextRef {
  /** adapter key (see renderer README "Render item ids") */
  key: string;
  text: Text;
}

function hashText(t: Text): string {
  const a = t.attributes;
  const p = t.position;
  return [t.text, p?.xNm, p?.yNm, a?.angle?.valueDegrees, a?.size?.xNm, a?.size?.yNm, a?.strokeWidth?.valueNm, a?.horizontalAlignment, a?.verticalAlignment, a?.italic, a?.bold, a?.mirrored, a?.fontName, a?.lineSpacing].join('|');
}

/** Texts a board store item contributes, keyed the way the board adapter looks them up. */
function boardTexts(it: StoredItem): TextRef[] {
  const p = it.proto as Record<string, any>;
  const out: TextRef[] = [];
  const push = (key: string | undefined, text: Text | undefined) => {
    if (key && text && text.text) out.push({ key, text });
  };
  switch (it.type) {
    case 'KOT_PCB_TEXT':
      push(it.id, p.text);
      break;
    case 'KOT_PCB_FIELD':
      push(p.text?.id?.value, p.text?.text);
      break;
    case 'KOT_PCB_FOOTPRINT':
      for (const f of [p.referenceField, p.valueField, p.datasheetField, p.descriptionField, ...(p.userFields ?? [])]) push(f?.text?.id?.value, f?.text?.text);
      for (const child of p.definition?.items ?? []) {
        const c = child as Record<string, any>;
        if (c?.$typeName === 'kiapi.board.types.BoardText') push(c.id?.value, c.text);
      }
      break;
    default:
      break;
  }
  return out;
}

/** Texts a schematic store item contributes, keyed for the schematic adapter. */
function schematicTexts(it: StoredItem): TextRef[] {
  const p = it.proto as Record<string, any>;
  const out: TextRef[] = [];
  const push = (key: string | undefined, text: Text | undefined) => {
    if (key && text && text.text && text.attributes?.visible !== false) out.push({ key, text });
  };
  switch (it.type) {
    case 'KOT_SCH_TEXT':
      push(it.id, p.text);
      break;
    case 'KOT_SCH_SYMBOL':
      for (const f of [p.referenceField, p.valueField, p.footprintField, p.datasheetField, p.descriptionField, ...(p.userFields ?? [])]) {
        if (f?.visible === false) continue;
        push(`${it.id}:field:${f?.name}`, f?.text);
      }
      break;
    default:
      break;
  }
  return out;
}

type TextCollector = (it: StoredItem) => TextRef[];

/**
 * Keeps GetTextAsShapes results for one store, re-fetching changed texts on store diffs.
 * `get(key)` is what the adapter context calls.
 */
class TextShapeCache {
  private shapes = new Map<string, GraphicShape[]>();
  private hashes = new Map<string, string>();
  private inflight: Promise<void> | null = null;
  private queued = new Map<string, TextRef>();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly collect: TextCollector,
    private readonly onReady: (keys: string[], initial: boolean) => void,
    private readonly log: (m: string, level?: 'info' | 'warn' | 'error') => void,
  ) {}

  get = (key: string): GraphicShape[] | undefined => this.shapes.get(key);

  /** Queues every text of `items` whose hash is unknown or changed. */
  request(items: Iterable<StoredItem>, initial = false): void {
    for (const it of items) for (const ref of this.collect(it)) if (this.hashes.get(ref.key) !== hashText(ref.text)) this.queued.set(ref.key, ref);
    void this.flush(initial);
  }

  private async flush(initial: boolean): Promise<void> {
    if (this.inflight || this.queued.size === 0) return;
    const kicad = this.docs.kicad;
    if (!kicad) return;
    const batch = [...this.queued.values()];
    this.queued.clear();
    this.inflight = (async () => {
      const done: string[] = [];
      for (let i = 0; i < batch.length; i += TEXT_BATCH) {
        const slice = batch.slice(i, i + TEXT_BATCH);
        try {
          const res = await kicad.textAsShapes(slice.map((r) => ({ text: r.text })));
          res.forEach((r, j) => {
            const ref = slice[j]!;
            this.shapes.set(ref.key, r.shapes?.shapes ?? []);
            this.hashes.set(ref.key, hashText(ref.text));
            done.push(ref.key);
          });
        } catch (e) {
          this.log(`GetTextAsShapes failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
        }
      }
      if (done.length) this.onReady(done, initial);
    })().finally(() => {
      this.inflight = null;
      if (this.queued.size) void this.flush(false);
    });
  }
}

/** GetPadShapeAsPolygon results per (pad, copper layer). */
class PadPolygonCache {
  private polys = new Map<string, PolygonWithHoles[]>();
  private known = new Set<string>();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (m: string, level?: 'info' | 'warn' | 'error') => void,
  ) {}

  get = (padId: string, layer: string): PolygonWithHoles[] | undefined => this.polys.get(`${padId}/${layer}`);

  /** Fetches polygons for every pad in `items` (top-level pads and footprint children) on every copper layer. */
  async request(items: Iterable<StoredItem>, layers: readonly string[]): Promise<number> {
    const board = this.docs.boardDoc;
    if (!board) return 0;
    const ids = new Set<string>();
    for (const it of items) {
      if (it.type === 'KOT_PCB_PAD') ids.add(it.id);
      if (it.type === 'KOT_PCB_FOOTPRINT') {
        for (const child of ((it.proto as Record<string, any>).definition?.items ?? []) as Record<string, any>[]) {
          if (child?.$typeName === 'kiapi.board.types.Pad' && child.id?.value) ids.add(child.id.value);
        }
      }
    }
    const list = [...ids];
    let fetched = 0;
    for (const layer of layers) {
      const enumValue = BoardLayer[layer as keyof typeof BoardLayer];
      if (typeof enumValue !== 'number') continue;
      const want = list.filter((id) => !this.known.has(`${id}/${layer}`));
      if (!want.length) continue;
      try {
        const res = await board.padShapesAsPolygons(want, enumValue);
        for (const id of want) {
          const key = `${id}/${layer}`;
          this.known.add(key);
          const poly = res.get(id);
          if (poly) {
            this.polys.set(key, [poly]);
            fetched++;
          }
        }
      } catch (e) {
        this.log(`GetPadShapeAsPolygon(${layer}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
    }
    return fetched;
  }

  /** Forgets pads that changed so they are re-fetched. */
  invalidate(ids: string[]): void {
    for (const key of [...this.known]) if (ids.some((id) => key.startsWith(`${id}/`))) this.known.delete(key);
  }
}

export interface KicadCanvasOptions {
  docs: KicadDocumentService;
  theme: () => Theme;
  log?: (m: string, level?: 'info' | 'warn' | 'error') => void;
}

/** Builds renderer hosts wired to the document service. Install with `setCanvasHostFactory`. */
export function createKicadCanvasFactory({ docs, theme, log = () => {} }: KicadCanvasOptions) {
  return (kind: DocumentKind, _storeKey: string, store: ItemStore): CanvasHost => {
    if (kind === 'schematic' || kind === 'symbol') return schematicHost(store);
    return boardHost(store, kind);
  };

  function boardHost(store: ItemStore, kind: DocumentKind): CanvasHost {
    const copperLayers = kind === 'board' ? docs.copperLayers : ['BL_F_Cu', 'BL_B_Cu'];
    const pads = new PadPolygonCache(docs, log);
    let host!: BoardCanvasHost;
    let upgraded = false;
    const texts = new TextShapeCache(
      docs,
      boardTexts,
      (keys, initial) => {
        if (initial && !upgraded) {
          upgraded = true;
          host.setAdapterContext({ padPolygons: pads.get, textShapes: texts.get });
          log(`renderer: ${keys.length} text shapes from GetTextAsShapes`);
        } else host.rebuildItems(ownersOf(store, keys));
      },
      log,
    );
    host = new BoardCanvasHost(theme(), {
      copperLayers,
      adapter: { padPolygons: pads.get, textShapes: texts.get, footprintChildrenAbsolute: true },
      pickTolerancePx: 5,
    });
    const origMount = host.mount.bind(host);
    host.mount = (el, s, th) => {
      origMount(el, s, th);
      void host.ready.then(() => el.querySelector('canvas')?.setAttribute('aria-label', `${kind} canvas`));
      // Server shapes: pads per copper layer first (cheap, big visual win), then texts.
      void (async () => {
        const n = await pads.request(store.all(), copperLayers);
        if (n) {
          host.setAdapterContext({ padPolygons: pads.get, textShapes: texts.get });
          log(`renderer: ${n} pad polygons from GetPadShapeAsPolygon`);
        }
        texts.request(store.all(), true);
      })();
    };
    const off = store.subscribe((diff) => {
      const changed = [...diff.added, ...diff.updated];
      if (!changed.length) return;
      pads.invalidate(changed.map((i) => i.id));
      void pads.request(changed, copperLayers).then((n) => n && host.rebuildItems(changed.map((i) => i.id)));
      texts.request(changed);
    });
    const origUnmount = host.unmount.bind(host);
    host.unmount = () => {
      off();
      origUnmount();
    };
    return host;
  }

  function schematicHost(store: ItemStore): CanvasHost {
    let host!: SchematicCanvasHost;
    let upgraded = false;
    const texts = new TextShapeCache(
      docs,
      schematicTexts,
      (keys, initial) => {
        if (initial && !upgraded) {
          upgraded = true;
          host.setAdapterContext({ textShapes: texts.get });
          log(`renderer: ${keys.length} schematic text shapes from GetTextAsShapes`);
        } else host.rebuildItems(ownersOf(host.currentStore as ItemStore, keys));
      },
      log,
    );
    host = new SchematicCanvasHost(theme(), {
      adapter: { textShapes: texts.get, decodeAny: (any) => unpackAny(any as never), symbolPinsAbsolute: true },
      pickTolerancePx: 5,
    });
    let off: (() => void) | null = null;
    const watch = (s: ItemStore) => {
      off?.();
      off = s.subscribe((diff) => texts.request([...diff.added, ...diff.updated]));
      texts.request(s.all(), true);
    };
    const origMount = host.mount.bind(host);
    host.mount = (el, s, th) => {
      origMount(el, s, th);
      void host.ready.then(() => el.querySelector('canvas')?.setAttribute('aria-label', 'schematic canvas'));
      watch(s as ItemStore);
    };
    const origSetStore = host.setStore.bind(host);
    host.setStore = (s) => {
      origSetStore(s);
      watch(s as ItemStore);
    };
    const origUnmount = host.unmount.bind(host);
    host.unmount = () => {
      off?.();
      off = null;
      origUnmount();
    };
    void store;
    return host;
  }
}

/** Store items owning the given text keys (`<kiid>`, `<kiid>:field:...`). */
function ownersOf(store: ItemStore | undefined, keys: string[]): string[] {
  if (!store) return [];
  const ids = new Set<string>();
  for (const k of keys) {
    const owner = k.split(':')[0]!;
    if (store.get(owner)) ids.add(owner);
    else {
      // field text ids live inside footprints: find the footprint that carries them
      for (const it of store.byType('KOT_PCB_FOOTPRINT')) if (boardTexts(it).some((t) => t.key === k)) ids.add(it.id);
    }
  }
  return [...ids];
}
