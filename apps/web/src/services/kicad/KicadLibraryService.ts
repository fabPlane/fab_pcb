// Library access for the placement tools and the footprint editor. The headless api-server
// keeps one document per KiCad face: opening a library footprint (`OpenDocument(DOCTYPE_FOOTPRINT)`)
// on the project's server unloads the board and every board handler answers AS_UNHANDLED from
// then on (measured; see docs/screenshots/README). Library documents therefore live in a second
// bridge session on the same project (so the project's fp-lib-table / sym-lib-table apply),
// opened lazily on first use and closed with the project.

import { FootprintMountingStyle, KiCadObjectType, LibraryTableScope, type SchematicSymbol as SchematicSymbolDefinition } from '@fp-pcb/proto';
import type { FootprintDocument, KiCad, LibSymbol } from '@fp-pcb/client';
import type { ItemStore } from '@/contracts';
import { makeFootprintInstance, makeSymbolInstance, type LibraryFootprint } from '@/lib/create';
import { MemoryItemStore } from '../MemoryItemStore';
import type { LibraryEntrySummary, LibraryKind, LibraryService, LibraryTableEntry } from '../extras';
import type { KicadSessionService } from './KicadSessionService';

/**
 * `ListLibraryEntries` loads the library on demand, so a big library's first listing is slow;
 * the unfiltered list is therefore cached for the life of the session and filtered in memory.
 */
const cacheKey = (kind: LibraryKind, nickname: string) => `${kind}:${nickname}`;

const MOUNTING: Record<number, string> = {
  [FootprintMountingStyle.FMS_THROUGH_HOLE]: 'through hole',
  [FootprintMountingStyle.FMS_SMD]: 'smd',
  [FootprintMountingStyle.FMS_UNSPECIFIED]: 'unspecified',
};

const SCOPES: Record<number, LibraryTableEntry['scope']> = {
  [LibraryTableScope.LTS_GLOBAL]: 'global',
  [LibraryTableScope.LTS_PROJECT]: 'project',
};

export class KicadLibraryService implements LibraryService {
  private aux: { id: string; kicad: KiCad; close(): Promise<void> } | null = null;
  private opening: Promise<KiCad> | null = null;
  private footprints = new Map<string, LibraryFootprint>();
  private symbols = new Map<string, SchematicSymbolDefinition>();
  private tableCache = new Map<LibraryKind, Promise<LibraryTableEntry[]>>();
  private entryCache = new Map<string, Promise<LibraryEntrySummary[]>>();
  private previews = new Map<string, ItemStore>();

  constructor(
    private readonly session: KicadSessionService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  /** The library session's KiCad handle (spawned on first call). */
  kicad(): Promise<KiCad> {
    if (this.aux) return Promise.resolve(this.aux.kicad);
    this.opening ??= (async () => {
      const path = this.session.session?.projectPath ?? null;
      const aux = await this.session.openAuxSession(path, 'library');
      this.aux = aux;
      return aux.kicad;
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  get isOpen(): boolean {
    return this.aux !== null;
  }

  /** Pads / shapes / texts and the mandatory fields of a library footprint (local coordinates). */
  async footprint(libId: string): Promise<LibraryFootprint> {
    const cached = this.footprints.get(libId);
    if (cached) return cached;
    const kicad = await this.kicad();
    const doc = await kicad.openFootprint(libId);
    const items = await doc.getAllItems();
    const lib: LibraryFootprint = {
      libId,
      items: items.filter((i) => i.type !== KiCadObjectType.KOT_PCB_FIELD).map((i) => i.proto),
      fields: items.filter((i) => i.type === KiCadObjectType.KOT_PCB_FIELD).map((i) => i.proto),
    };
    this.footprints.set(libId, lib);
    this.log(`library: ${libId}: ${lib.items.length} items, ${lib.fields.length} fields`);
    return lib;
  }

  /** The library symbol definition (`GetItems(KOT_LIB_SYMBOL)` on a headless symbol document). */
  async symbol(libId: string): Promise<SchematicSymbolDefinition> {
    const cached = this.symbols.get(libId);
    if (cached) return cached;
    const kicad = await this.kicad();
    const doc = await kicad.openSymbol(libId);
    const lib: LibSymbol | undefined = await doc.libSymbol();
    if (!lib) throw new Error(`${libId}: the symbol document returned no KOT_LIB_SYMBOL`);
    this.symbols.set(libId, lib.proto);
    this.log(`library: ${libId}: ${lib.proto.items.length} children, ${lib.unitCount} unit(s)`);
    return lib.proto;
  }

  /** Opens a footprint for editing (its own document in the library session). */
  async openFootprintDocument(libId: string): Promise<FootprintDocument> {
    const kicad = await this.kicad();
    this.footprints.delete(libId);
    return kicad.openFootprint(libId);
  }

  // ------------------------------------------------------------------- library browser

  /** `GetLibraryTables`: the rows of the global and project tables, global first. */
  tables(kind: LibraryKind): Promise<LibraryTableEntry[]> {
    let p = this.tableCache.get(kind);
    if (!p) {
      p = (async () => {
        const kicad = await this.kicad();
        const rows = await kicad.libraries.tables(kind);
        this.log(`GetLibraryTables(${kind}): ${rows.length} libraries`);
        return rows.map((r) => ({
          nickname: r.nickname,
          uri: r.uri,
          description: r.description,
          scope: SCOPES[r.scope] ?? ('unknown' as const),
          enabled: r.enabled !== false,
        }));
      })().catch((e: unknown) => {
        this.tableCache.delete(kind);
        throw e;
      });
      this.tableCache.set(kind, p);
    }
    return p;
  }

  /** `ListLibraryEntries` (cached unfiltered per library); `filter` is applied in memory. */
  async entries(kind: LibraryKind, nickname: string, filter = ''): Promise<LibraryEntrySummary[]> {
    const key = cacheKey(kind, nickname);
    let p = this.entryCache.get(key);
    if (!p) {
      p = (async () => {
        const kicad = await this.kicad();
        const t0 = Date.now();
        const list = await kicad.libraries.entries(kind, nickname, '');
        this.log(`ListLibraryEntries(${kind} ${nickname}): ${list.length} entries in ${Date.now() - t0} ms`);
        return list.map((e): LibraryEntrySummary => {
          const info = e.info;
          const sym = info?.case === 'symbol' ? info.value : undefined;
          const fp = info?.case === 'footprint' ? info.value : undefined;
          return {
            libId: `${nickname}:${e.name}`,
            nickname,
            name: e.name,
            description: e.description,
            keywords: e.keywords,
            unitCount: sym?.unitCount,
            isPower: sym?.isPower,
            padCount: fp?.padCount,
            mounting: fp ? (MOUNTING[fp.mountingStyle] ?? undefined) : undefined,
            defaultFootprint: sym?.footprint || undefined,
          };
        });
      })().catch((e: unknown) => {
        this.entryCache.delete(key);
        throw e;
      });
      this.entryCache.set(key, p);
    }
    const all = await p;
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.keywords.toLowerCase().includes(q));
  }

  /**
   * A single-item store for the browser's preview canvas: the library footprint / symbol placed
   * at the origin, so the existing `BoardCanvasHost` / `SchematicCanvasHost` render it unchanged.
   */
  async preview(kind: 'footprint' | 'symbol', libId: string): Promise<ItemStore | null> {
    const key = `${kind}:${libId}`;
    const cached = this.previews.get(key);
    if (cached) return cached;
    const store = new MemoryItemStore(kind === 'footprint' ? 'footprint' : 'symbol', null, `preview:${key}`);
    // Empty reference / value: the preview is about the geometry, and an unresolved text still
    // costs a placeholder box in the renderer's fallback pass, which throws off `zoomToFit`.
    const at = { x: 0, y: 0 };
    if (kind === 'footprint') {
      const lib = await this.footprint(libId);
      store.insert(makeFootprintInstance(at, 'BL_F_Cu', lib, '', ''));
    } else {
      const def = await this.symbol(libId);
      store.insert(makeSymbolInstance(at, def, '', ''));
    }
    this.previews.set(key, store);
    return store;
  }

  invalidate(kind?: LibraryKind, nickname?: string): void {
    if (!kind) {
      this.tableCache.clear();
      this.entryCache.clear();
      this.previews.clear();
      return;
    }
    this.tableCache.delete(kind);
    if (nickname) this.entryCache.delete(cacheKey(kind, nickname));
    else for (const k of [...this.entryCache.keys()]) if (k.startsWith(`${kind}:`)) this.entryCache.delete(k);
  }

  async close(): Promise<void> {
    const aux = this.aux;
    this.aux = null;
    this.footprints.clear();
    this.symbols.clear();
    this.tableCache.clear();
    this.entryCache.clear();
    this.previews.clear();
    if (aux) await aux.close();
  }
}
