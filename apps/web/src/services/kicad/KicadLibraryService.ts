// Library access for the placement tools and the footprint editor. The headless api-server
// keeps one document per KiCad face: opening a library footprint (`OpenDocument(DOCTYPE_FOOTPRINT)`)
// on the project's server unloads the board and every board handler answers AS_UNHANDLED from
// then on (measured; see docs/screenshots/README). Library documents therefore live in a second
// bridge session on the same project (so the project's fp-lib-table / sym-lib-table apply),
// opened lazily on first use and closed with the project.

import { KiCadObjectType, type SchematicSymbol as SchematicSymbolDefinition } from '@kicad-web/proto';
import type { FootprintDocument, KiCad, LibSymbol } from '@kicad-web/client';
import type { LibraryFootprint } from '@/lib/create';
import type { KicadSessionService } from './KicadSessionService';

export class KicadLibraryService {
  private aux: { id: string; kicad: KiCad; close(): Promise<void> } | null = null;
  private opening: Promise<KiCad> | null = null;
  private footprints = new Map<string, LibraryFootprint>();
  private symbols = new Map<string, SchematicSymbolDefinition>();

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

  async close(): Promise<void> {
    const aux = this.aux;
    this.aux = null;
    this.footprints.clear();
    this.symbols.clear();
    if (aux) await aux.close();
  }
}
