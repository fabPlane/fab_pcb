// Real canvases: `BoardCanvasHost` / `SchematicCanvasHost` from `@fp-pcb/renderer` with
// their adapter contexts fed from KiCad:
//   - `copperLayers` from GetBoardEnabledLayers,
//   - `padPolygons` from GetPadShapeAsPolygon (one request per copper layer, cached per pad/layer),
//   - `textShapes` from GetTextAsShapes (all board texts, text boxes, table cells and footprint
//     fields; or every text the schematic plotter draws -- pin names / numbers, symbol fields and
//     library texts, sheet fields and pins, labels and their fields, texts, text boxes, table
//     cells -- built by the renderer's `schematicTextRequests` and batched 200 per request;
//     cached by a content hash so an edit only re-tessellates what changed; a few symbol fields
//     go through GetTextExtents first, see the renderer's textRequests.ts),
//   - `decodeAny` via the proto registry.
// Board hosts also feed the ratsnest overlay from `GetRatsnest` (`host.setRatsnest`), refreshed
// after every store diff that touches copper. DRC/ERC markers go through `host.setMarkers` /
// `host.focusMarker`; the app's DRC panel drives those directly.
// The host first paints with the renderer's fallbacks and `setAdapterContext` upgrades it
// once the server shapes arrive; later store diffs only re-fetch the affected texts and
// `rebuildItems` them.

import { BoardLayer, unpackAny, type GraphicShape, type PolygonWithHoles, type Text, type TextBox } from '@fp-pcb/proto';
import { BoardCanvasHost, SchematicCanvasHost, dimensionText, resolveTextRequests, schematicTextRequests, type SchTextRequest, type SchematicAdapterContext, type Theme } from '@fp-pcb/renderer';
import type { CanvasHost, DocumentKind, ItemStore, StoredItem } from '@/contracts';
import type { KicadDocumentService } from './KicadDocumentService';

const TEXT_BATCH = 200;

interface TextRef {
  /** adapter key (see renderer README "Render item ids") */
  key: string;
  /** exactly one of the two: a plain text, or a text box / table cell laid out at its box */
  text?: Text;
  textbox?: TextBox;
  /** schematic requests (renderer `schematicTextRequests`) bring their own content hash ... */
  hash?: string;
  /** ... and some symbol fields a `GetTextExtents` stage that yields `text` (`resolveTextRequests`) */
  measure?: SchTextRequest['measure'];
  place?: SchTextRequest['place'];
}

function hashAttrs(a: Text['attributes']): string {
  return [a?.angle?.valueDegrees, a?.size?.xNm, a?.size?.yNm, a?.strokeWidth?.valueNm, a?.horizontalAlignment, a?.verticalAlignment, a?.italic, a?.bold, a?.mirrored, a?.fontName, a?.lineSpacing].join(
    '|',
  );
}

function hashText(r: TextRef): string {
  if (r.hash) return r.hash;
  if (r.textbox) {
    const b = r.textbox;
    return [
      'box',
      b.text,
      b.topLeft?.xNm,
      b.topLeft?.yNm,
      b.bottomRight?.xNm,
      b.bottomRight?.yNm,
      b.marginLeft?.valueNm,
      b.marginTop?.valueNm,
      b.marginRight?.valueNm,
      b.marginBottom?.valueNm,
      hashAttrs(b.attributes),
    ].join('|');
  }
  const t = r.text;
  return [t?.text, t?.position?.xNm, t?.position?.yNm, hashAttrs(t?.attributes)].join('|');
}

/** Texts a board store item contributes, keyed the way the board adapter looks them up. */
function boardTexts(it: StoredItem): TextRef[] {
  const p = it.proto as Record<string, any>;
  const out: TextRef[] = [];
  const push = (key: string | undefined, text: Text | undefined) => {
    if (key && text && text.text) out.push({ key, text });
  };
  const pushBox = (key: string | undefined, textbox: TextBox | undefined) => {
    if (key && textbox && textbox.text) out.push({ key, textbox });
  };
  switch (it.type) {
    case 'KOT_PCB_TEXT':
      push(it.id, p.text);
      break;
    case 'KOT_PCB_TEXTBOX':
      pushBox(it.id, p.textbox);
      break;
    case 'KOT_PCB_TABLE':
      for (const cell of p.cells ?? []) pushBox(cell?.textBox?.id?.value, cell?.textBox?.textbox);
      break;
    case 'KOT_PCB_FIELD':
      push(p.text?.id?.value, p.text?.text);
      break;
    case 'KOT_PCB_DIMENSION': {
      // The plotter draws `resolved_text` ("26.5000 mm"), not the bare measurement in `text.text`,
      // so the glyphs must be laid out for that string or they come out short and off-centre. An
      // empty string means the dimension plots no text at all, so no request is made.
      const shown = dimensionText(p);
      if (shown && p.text) out.push({ key: it.id, text: { ...(p.text as Text), text: shown } });
      break;
    }
    case 'KOT_PCB_FOOTPRINT':
      for (const f of [p.referenceField, p.valueField, p.datasheetField, p.descriptionField, ...(p.userFields ?? [])]) push(f?.text?.id?.value, f?.text?.text);
      for (const child of p.definition?.items ?? []) {
        const c = child as Record<string, any>;
        if (c?.$typeName === 'kiapi.board.types.BoardText') push(c.id?.value, c.text);
        if (c?.$typeName === 'kiapi.board.types.BoardTextBox') pushBox(c.id?.value, c.textbox);
      }
      break;
    default:
      break;
  }
  return out;
}

/** Adapter options of the schematic host; the text requests are built with the same ones so they are placed as drawn. */
// Pins in `definition.items` are library-local since upstream KiCad 3cbac44524 (the instance
// transform is applied by the adapter); the previous servers sent sheet coordinates.
const SCH_ADAPTER: SchematicAdapterContext = { symbolPinsAbsolute: false, decodeAny: (any) => unpackAny(any as never) };

/**
 * Texts a schematic store item contributes, keyed for the schematic adapter: pin names and
 * numbers, symbol fields (some measured first), library texts, sheet fields and pins, labels
 * and their fields, plain text, text boxes and table cells -- built by the renderer from the
 * placement code that draws them (`schematicTextRequests`), the same requests the pixel-diff
 * harness makes.
 */
function schematicTexts(it: StoredItem): TextRef[] {
  return schematicTextRequests(it, SCH_ADAPTER).map((r) => ({
    key: r.key,
    hash: r.hash,
    text: r.text as Text | undefined,
    textbox: r.textbox as TextBox | undefined,
    measure: r.measure,
    place: r.place,
  }));
}

type TextCollector = (it: StoredItem) => TextRef[];

/**
 * Keeps GetTextAsShapes results for one store, re-fetching changed texts on store diffs.
 * `get(key)` is what the adapter context calls.
 */
export class TextShapeCache {
  private shapes = new Map<string, GraphicShape[]>();
  private hashes = new Map<string, string>();
  private inflight: Promise<void> | null = null;
  private queued = new Map<string, TextRef>();
  /** Called with the keys that arrived; re-targeted to whichever host currently shows the store. */
  onReady: (keys: string[], initial: boolean) => void = () => {};

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly collect: TextCollector,
    private readonly log: (m: string, level?: 'info' | 'warn' | 'error') => void,
  ) {}

  /** Text keys with shapes so far. */
  get size(): number {
    return this.shapes.size;
  }

  get = (key: string): GraphicShape[] | undefined => this.shapes.get(key);

  /** Queues every text of `items` whose hash is unknown or changed. */
  request(items: Iterable<StoredItem>, initial = false): void {
    for (const it of items) for (const ref of this.collect(it)) if (this.hashes.get(ref.key) !== hashText(ref)) this.queued.set(ref.key, ref);
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
      // symbol fields whose placement needs KiCad's text box: one GetTextExtents each, first
      const pending = batch.filter((r) => r.measure && !r.text && !r.textbox);
      if (pending.length) {
        try {
          await resolveTextRequests(pending as SchTextRequest[], (t) => kicad.textExtents(t as never));
        } catch (e) {
          this.log(`GetTextExtents failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
        }
      }
      const ready = batch.filter((r) => r.text || r.textbox);
      for (let i = 0; i < ready.length; i += TEXT_BATCH) {
        const slice = ready.slice(i, i + TEXT_BATCH);
        try {
          const res = await kicad.textAsShapes(slice.map((r) => (r.textbox ? { textbox: r.textbox } : { text: r.text! })));
          res.forEach((r, j) => {
            const ref = slice[j]!;
            this.shapes.set(ref.key, r.shapes?.shapes ?? []);
            this.hashes.set(ref.key, hashText(ref));
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
export class PadPolygonCache {
  private polys = new Map<string, PolygonWithHoles[]>();
  /** (pad, layer) keys fetched or in flight — a second host mounting the same store asks for nothing */
  private known = new Set<string>();
  /** Called after each batch that brought polygons; re-targeted to the host currently showing the store. */
  onReady: (fetched: number) => void = () => {};

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (m: string, level?: 'info' | 'warn' | 'error') => void,
  ) {}

  get = (padId: string, layer: string): PolygonWithHoles[] | undefined => this.polys.get(`${padId}/${layer}`);

  /** Pad/layer pairs with a polygon so far. */
  get size(): number {
    return this.polys.size;
  }

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
      for (const id of want) this.known.add(`${id}/${layer}`);
      try {
        const res = await board.padShapesAsPolygons(want, enumValue);
        for (const id of want) {
          const poly = res.get(id);
          if (poly) {
            this.polys.set(`${id}/${layer}`, [poly]);
            fetched++;
          }
        }
      } catch (e) {
        for (const id of want) this.known.delete(`${id}/${layer}`);
        this.log(`GetPadShapeAsPolygon(${layer}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
      }
    }
    if (fetched) this.onReady(fetched);
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

/** Store item types whose edits can change the ratsnest. */
const COPPER_TYPES = new Set(['KOT_PCB_TRACE', 'KOT_PCB_ARC', 'KOT_PCB_VIA', 'KOT_PCB_PAD', 'KOT_PCB_ZONE', 'KOT_PCB_FOOTPRINT']);

export interface BoardShapeCaches {
  pads: PadPolygonCache;
  texts: TextShapeCache;
}

/**
 * The server-shape caches belong to the store, not to the host: a canvas is mounted more than
 * once per store (React StrictMode mounts twice in dev, and every switch back to the board tab
 * remounts it), and each mount used to ask KiCad for every pad polygon and text shape again.
 */
const boardCaches = new WeakMap<ItemStore, BoardShapeCaches>();
export function boardCachesFor(store: ItemStore, docs: KicadDocumentService, log: (m: string, level?: 'info' | 'warn' | 'error') => void = () => {}): BoardShapeCaches {
  let c = boardCaches.get(store);
  if (!c) {
    c = { pads: new PadPolygonCache(docs, log), texts: new TextShapeCache(docs, boardTexts, log) };
    boardCaches.set(store, c);
  }
  return c;
}

/** Builds renderer hosts wired to the document service. Install with `setCanvasHostFactory`. */
export function createKicadCanvasFactory({ docs, theme, log = () => {} }: KicadCanvasOptions) {
  return (kind: DocumentKind, _storeKey: string, store: ItemStore): CanvasHost => {
    if (kind === 'schematic' || kind === 'symbol') return schematicHost(store);
    return boardHost(store, kind);
  };

  function boardHost(store: ItemStore, kind: DocumentKind): CanvasHost {
    const copperLayers = kind === 'board' ? docs.copperLayers : ['BL_F_Cu', 'BL_B_Cu'];
    const { pads, texts } = boardCachesFor(store, docs, log);
    let host!: BoardCanvasHost;
    let upgraded = false;
    // this host is the one showing the store now: server shapes that arrive go to it
    texts.onReady = (keys, initial) => {
      if (initial && !upgraded) {
        upgraded = true;
        host.setAdapterContext({ padPolygons: pads.get, textShapes: texts.get });
        log(`renderer: ${keys.length} text shapes from GetTextAsShapes`);
      } else host.rebuildItems(ownersOf(store, keys));
    };
    pads.onReady = (n) => {
      host.setAdapterContext({ padPolygons: pads.get, textShapes: texts.get });
      log(`renderer: ${n} pad polygons from GetPadShapeAsPolygon`);
    };
    host = new BoardCanvasHost(theme(), {
      copperLayers,
      // caches already filled by an earlier mount of this store feed the first paint directly
      adapter: { padPolygons: pads.get, textShapes: texts.get, footprintChildrenAbsolute: true, decodeAny: (any) => unpackAny(any as never) },
      pickTolerancePx: 5,
    });
    // Ratsnest overlay: GetRatsnest -> host.setRatsnest, coalesced so a burst of edits
    // triggers one request. Failures are logged and leave the last edges in place.
    let ratsnestPending: ReturnType<typeof setTimeout> | null = null;
    const refreshRatsnest = (delayMs = 0): void => {
      if (kind !== 'board') return;
      if (ratsnestPending) clearTimeout(ratsnestPending);
      ratsnestPending = setTimeout(() => {
        ratsnestPending = null;
        const board = docs.boardDoc;
        if (!board) return;
        void board
          .ratsnest()
          .then((r) => host.setRatsnest(r.edges.map((e) => ({ net: e.net, a: e.sourcePosition, b: e.targetPosition, source: e.source, target: e.target }))))
          .catch((e) => log(`GetRatsnest failed: ${e instanceof Error ? e.message : String(e)}`, 'warn'));
      }, delayMs);
    };
    const origMount = host.mount.bind(host);
    host.mount = (el, s, th) => {
      origMount(el, s, th);
      void host.ready.then(() => el.querySelector('canvas')?.setAttribute('aria-label', `${kind} canvas`));
      // Server shapes: pads per copper layer first (cheap, big visual win), then texts. Both
      // are no-ops for what an earlier mount already fetched.
      void pads.request(store.all(), copperLayers).then(() => texts.request(store.all(), true));
      refreshRatsnest();
    };
    const off = store.subscribe((diff) => {
      const changed = [...diff.added, ...diff.updated];
      if (changed.some((i) => COPPER_TYPES.has(i.type)) || diff.removed.length) refreshRatsnest(150);
      if (!changed.length) return;
      pads.invalidate(changed.map((i) => i.id));
      void pads.request(changed, copperLayers);
      texts.request(changed);
    });
    const origUnmount = host.unmount.bind(host);
    host.unmount = () => {
      off();
      if (ratsnestPending) clearTimeout(ratsnestPending);
      ratsnestPending = null;
      origUnmount();
    };
    return host;
  }

  function schematicHost(store: ItemStore): CanvasHost {
    let host!: SchematicCanvasHost;
    let upgraded = false;
    const texts = new TextShapeCache(docs, schematicTexts, log);
    texts.onReady = (keys, initial) => {
      if (initial && !upgraded) {
        upgraded = true;
        host.setAdapterContext({ textShapes: texts.get });
        log(`renderer: ${keys.length} schematic text shapes from GetTextAsShapes`);
      } else host.rebuildItems(ownersOf(host.currentStore as ItemStore, keys));
    };
    host = new SchematicCanvasHost(theme(), {
      adapter: { ...SCH_ADAPTER, textShapes: texts.get },
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
      // field / table-cell text ids live inside another item: find the one that carries them
      for (const type of ['KOT_PCB_FOOTPRINT', 'KOT_PCB_TABLE', 'KOT_SCH_TABLE']) {
        for (const it of store.byType(type)) if ((it.type.startsWith('KOT_SCH') ? schematicTexts(it) : boardTexts(it)).some((t) => t.key === k)) ids.add(it.id);
      }
    }
  }
  return [...ids];
}
