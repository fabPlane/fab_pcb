// DocumentService over `@kicad-web/client`'s object model. Owns the open Project / Board /
// Schematic / FootprintDocuments of the session, their ItemStores (filled by the client's
// DocumentSync), and the derived read models the panels want (layers, nets, board setup,
// net classes, text variables, variants). Dirty flags come from `GetDocumentRevision`,
// polled every 2 s while idle because the bridge does not forward KiCad's PUB events socket
// yet (`GetServerInfo.events_socket_url` is set, nothing relays it).

import { create } from '@bufbuild/protobuf';
import {
  BoardLayer,
  BoardStackupLayerType,
  DocumentType,
  KiCadObjectType,
  type BoardStackupLayer,
  type CustomRule,
  type NetClass,
} from '@kicad-web/proto';
import {
  Board,
  FootprintDocument,
  KiCadApiError,
  Project,
  Schematic,
  SheetHandle,
  flattenHierarchy,
  type KiCad,
  type Commit,
  type DocumentSync,
} from '@kicad-web/client';
import { NetClassSchema } from '@kicad-web/proto';
import type { DocumentKind, ItemStore } from '@/contracts';
import { layerDisplayName } from '@/lib/enums';
import type { BoardSetup, DesignRules, DocumentService, LayerInfo, NetInfo, NetclassInfo, SheetInfo, StackupLayer, TextVariable, VariantInfo } from '../types';

/** Anything the commit backend can open a KiCad commit on. */
export interface CommitTarget {
  kind: DocumentKind;
  beginCommit(): Promise<Commit>;
}

export interface OpenOptions {
  /** Existence probe for sibling files (`<name>.kicad_pcb` next to a `.kicad_pro`); the bridge file API. */
  exists?: (path: string) => Promise<boolean>;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

const REVISION_POLL_MS = 2000;

const num = (v: bigint | number | undefined): number => (typeof v === 'bigint' ? Number(v) : (v ?? 0));
const dist = (v: { valueNm?: bigint | number } | undefined): number => num(v?.valueNm);

function layerKind(id: string): LayerInfo['kind'] {
  if (id.endsWith('_Cu')) return 'copper';
  if (id === 'BL_Edge_Cuts' || id === 'BL_Margin') return 'edge';
  if (/User|Eco/.test(id)) return 'user';
  return 'technical';
}

function stackupType(t: BoardStackupLayerType, layer: BoardLayer): StackupLayer['type'] {
  switch (t) {
    case BoardStackupLayerType.BSLT_COPPER:
      return 'copper';
    case BoardStackupLayerType.BSLT_SILKSCREEN:
      return 'silkscreen';
    case BoardStackupLayerType.BSLT_SOLDERMASK:
      return 'soldermask';
    case BoardStackupLayerType.BSLT_SOLDERPASTE:
      return 'soldermask';
    case BoardStackupLayerType.BSLT_DIELECTRIC:
      return 'core';
    default:
      return layer >= BoardLayer.BL_F_Cu && layer <= BoardLayer.BL_B_Cu ? 'copper' : 'prepreg';
  }
}

function colourCss(c: { r?: number; g?: number; b?: number; a?: number } | undefined): string {
  if (!c || (c.a ?? 0) === 0) return '';
  const h = (v: number | undefined) =>
    Math.round((v ?? 0) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function customRulesText(rules: CustomRule[]): string {
  const lines = ['(version 1)'];
  for (const r of rules) {
    lines.push(`(rule "${r.name}"`);
    if (r.condition) lines.push(`  (condition "${r.condition}")`);
    for (const c of r.constraints) lines.push(`  (constraint ${JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))})`);
    lines.push(')');
  }
  return lines.join('\n');
}

export class KicadDocumentService implements DocumentService {
  kicad: KiCad | null = null;
  project: Project | null = null;
  boardDoc: Board | null = null;
  schematicDoc: Schematic | null = null;
  private sheetHandles = new Map<string, SheetHandle>();
  private sheetList: SheetInfo[] = [];
  private rootSheetKey = '';
  private footprintDocs = new Map<string, FootprintDocument>();
  private footprintPending = new Set<string>();
  private layerList: LayerInfo[] = [];
  private netList: NetInfo[] = [];
  private setup: BoardSetup = { copperLayers: 2, thicknessNm: 1_600_000, stackup: [], rules: emptyRules(), customRules: '' };
  private netclassList: NetclassInfo[] = [];
  private textVars: TextVariable[] = [];
  private variantList: VariantInfo[] = [];
  private dirty: Record<DocumentKind, boolean> = { board: false, schematic: false, footprint: false, symbol: false };
  private known: Partial<Record<DocumentKind, bigint | undefined>> = {};
  private saved: Partial<Record<DocumentKind, bigint | undefined>> = {};
  private subs = new Set<() => void>();
  private storeSubs: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private busy = 0;
  private opts: OpenOptions = {};
  /** Copper layer ids front to back, for the renderer. */
  copperLayers: string[] = ['BL_F_Cu', 'BL_B_Cu'];
  /** Enabled layer ids (BoardLayer names). */
  enabledLayerIds: string[] = [];

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }

  private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.opts.log?.(message, level);
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Opens the documents of `path` on a connected server. The bridge preloads the file it was
   * given (`kicad-cli api-server <path>`): a `.kicad_pcb` / `.kicad_sch` is already open, a
   * `.kicad_pro` loads only the project, so the board / root schematic next to it are opened
   * here when they exist.
   */
  async open(kicad: KiCad, path: string, opts: OpenOptions = {}): Promise<void> {
    await this.close();
    this.kicad = kicad;
    this.opts = opts;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const base = path.split('/').pop()!.replace(/\.kicad_(pro|pcb|sch)$/, '');
    const exists = opts.exists ?? (async () => false);

    // Documents the preload left open.
    const openBoard = (await kicad.openDocuments(DocumentType.DOCTYPE_PCB))[0];
    const openSch = (await kicad.openDocuments(DocumentType.DOCTYPE_SCHEMATIC))[0];
    if (openBoard) this.boardDoc = kicad.boardFrom(openBoard);
    if (openSch) this.schematicDoc = kicad.schematicFrom(openSch);

    if (!this.boardDoc && (path.endsWith('.kicad_pcb') || (path.endsWith('.kicad_pro') && (await exists(`${dir}/${base}.kicad_pcb`))))) {
      const p = path.endsWith('.kicad_pcb') ? path : `${dir}/${base}.kicad_pcb`;
      try {
        this.boardDoc = await kicad.openBoard(p);
      } catch (e) {
        this.log(`OpenDocument(board ${p}) failed: ${describe(e)}`, 'warn');
      }
    }
    if (!this.schematicDoc && (path.endsWith('.kicad_sch') || (path.endsWith('.kicad_pro') && (await exists(`${dir}/${base}.kicad_sch`))))) {
      const p = path.endsWith('.kicad_sch') ? path : `${dir}/${base}.kicad_sch`;
      try {
        this.schematicDoc = await kicad.openSchematic(p);
      } catch (e) {
        this.log(`OpenDocument(schematic ${p}) failed: ${describe(e)}`, 'warn');
      }
    }
    const spec = this.boardDoc?.specifier ?? this.schematicDoc?.specifier;
    this.project = spec ? kicad.projectFrom(spec) : new Project(kicad, await kicad.openDocument(DocumentType.DOCTYPE_PROJECT, path).catch(() => create_spec()));
    // The handler set grows when a board/schematic is opened; refresh the capability table.
    kicad.client.invalidateCapabilities();

    await Promise.all([this.loadBoard(), this.loadSchematic()]);
    await this.loadProjectData();
    this.startPolling();
    this.emit();
  }

  async close(): Promise<void> {
    this.stopPolling();
    for (const off of this.storeSubs) off();
    this.storeSubs = [];
    this.boardDoc?.documentSync.dispose();
    for (const h of this.sheetHandles.values()) h.documentSync.dispose();
    for (const f of this.footprintDocs.values()) f.documentSync.dispose();
    this.kicad = null;
    this.project = null;
    this.boardDoc = null;
    this.schematicDoc = null;
    this.sheetHandles.clear();
    this.sheetList = [];
    this.rootSheetKey = '';
    this.footprintDocs.clear();
    this.footprintPending.clear();
    this.layerList = [];
    this.netList = [];
    this.netclassList = [];
    this.textVars = [];
    this.variantList = [];
    this.dirty = { board: false, schematic: false, footprint: false, symbol: false };
    this.known = {};
    this.saved = {};
    this.emit();
  }

  private async loadBoard(): Promise<void> {
    const board = this.boardDoc;
    if (!board) return;
    await board.documentSync.load();
    this.storeSubs.push(board.store.subscribe(() => this.onStoreChanged('board')));
    const [enabled, rev] = await Promise.all([board.enabledLayers(), board.revision()]);
    this.known.board = this.saved.board = rev;
    const ids = enabled.layers.map((l) => BoardLayer[l]).filter((n): n is string => !!n);
    this.enabledLayerIds = ids;
    this.copperLayers = ids.filter((l) => l.endsWith('_Cu'));
    const names = await Promise.all(enabled.layers.map((l) => board.layerName(l).catch(() => '')));
    this.layerList = enabled.layers.map((l, i) => {
      const id = BoardLayer[l] ?? String(l);
      return { id, name: names[i] || layerDisplayName(id), kind: layerKind(id) };
    });
    await Promise.all([this.loadNets(), this.loadSetup()]);
  }

  private async loadNets(): Promise<void> {
    const board = this.boardDoc;
    if (!board) return;
    try {
      const nets = (await board.nets()).map((n) => n.name).filter(Boolean);
      let classes = new Map<string, NetClass>();
      try {
        classes = await board.netClassForNets(nets);
      } catch (e) {
        this.log(`GetNetClassForNets failed: ${describe(e)}`, 'warn');
      }
      this.netList = nets
        .map((name) => ({ name, netclass: classes.get(name)?.name ?? 'Default', items: [...board.store.byNet(name)].length }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.log(`GetNets failed: ${describe(e)}`, 'warn');
    }
  }

  private async loadSetup(): Promise<void> {
    const board = this.boardDoc;
    if (!board) return;
    try {
      const [stackup, rules, custom, enabled] = await Promise.all([board.stackup(), board.designRules(), board.customRules().catch(() => null), board.enabledLayers()]);
      const layers: StackupLayer[] = stackup.layers.map((l: BoardStackupLayer, i: number) => {
        const id = l.type === BoardStackupLayerType.BSLT_DIELECTRIC ? `dielectric${i}` : (BoardLayer[l.layer] ?? `layer${i}`);
        return { layer: id, name: l.userName || (id.startsWith('BL_') ? layerDisplayName(id) : l.materialName || 'Dielectric'), material: l.materialName, thicknessNm: dist(l.thickness), type: stackupType(l.type, l.layer) };
      });
      const c = rules.rules.constraints;
      this.setup = {
        copperLayers: enabled.copperLayerCount,
        thicknessNm: layers.reduce((a, l) => a + l.thicknessNm, 0),
        stackup: layers,
        rules: {
          minClearanceNm: dist(c?.minClearance),
          minTrackWidthNm: dist(c?.minTrackWidth),
          minViaDiameterNm: dist(c?.minViaSize),
          minViaDrillNm: dist(c?.minThroughDrill),
          minHoleToHoleNm: dist(c?.holeToHoleMin),
          copperToEdgeNm: dist(c?.copperEdgeClearance),
          minAnnularWidthNm: dist(c?.minViaAnnularWidth),
          minTextHeightNm: dist(c?.minSilkTextHeight),
          minTextThicknessNm: dist(c?.minSilkTextThickness),
        },
        customRules: custom ? customRulesText(custom.rules) : '',
      };
    } catch (e) {
      this.log(`board setup: ${describe(e)}`, 'warn');
    }
  }

  private async loadSchematic(): Promise<void> {
    const sch = this.schematicDoc;
    if (!sch) return;
    const top = await sch.hierarchy();
    const toInfo = (s: (typeof top)[number]): SheetInfo => {
      const handle = sch.sheet(s.path!, s);
      const key = this.sheetKey(handle);
      this.sheetHandles.set(key, handle);
      return { path: key, name: s.name || 'Root', file: s.filename, page: s.pageNumber, children: s.children.map(toInfo) };
    };
    this.sheetList = top.map(toInfo);
    this.rootSheetKey = this.sheetList[0]?.path ?? '';
    await Promise.all(
      flattenHierarchy(top).map(async ({ sheet }) => {
        const h = sch.sheet(sheet.path!, sheet);
        await h.documentSync.load();
        this.storeSubs.push(h.store.subscribe(() => this.onStoreChanged('schematic')));
      }),
    );
    this.known.schematic = this.saved.schematic = await sch.revision();
  }

  private async loadProjectData(): Promise<void> {
    const project = this.project;
    if (!project) return;
    const [classes, vars] = await Promise.all([project.netClasses().catch((e) => (this.log(`GetNetClasses: ${describe(e)}`, 'warn'), [] as NetClass[])), project.textVariables().catch(() => ({}))]);
    this.netclassList = classes.map(netclassInfo);
    this.textVars = Object.entries(vars).map(([name, value]) => ({ name, value }));
    const doc = this.boardDoc ?? this.schematicDoc;
    if (doc) {
      try {
        const [list, current] = await Promise.all([doc.variants.list(), doc.variants.current()]);
        this.variantList = list.map((v) => ({ name: v.name, description: v.description, current: v.name === current }));
      } catch (e) {
        this.log(`GetVariants: ${describe(e)}`, 'warn');
      }
    }
  }

  private sheetKey(h: SheetHandle): string {
    return `/${h.path.path.map((k) => k.value).join('/')}`;
  }

  // ------------------------------------------------------------------ revisions / dirty

  private onStoreChanged(kind: DocumentKind): void {
    if (!this.dirty[kind]) {
      this.dirty[kind] = true;
      this.emit();
    }
  }

  /** Marks a request in flight so the poll does not race a commit. */
  beginActivity(): () => void {
    this.busy++;
    return () => {
      this.busy--;
    };
  }

  /** Records KiCad's revision after one of our own commits so the poll does not re-read the store. */
  async afterCommit(kind: DocumentKind): Promise<void> {
    const doc = kind === 'board' ? this.boardDoc : kind === 'schematic' ? this.schematicDoc : null;
    if (!doc) return;
    try {
      this.known[kind] = await doc.revision();
    } catch {
      /* revision unsupported */
    }
    this.dirty[kind] = this.known[kind] === undefined ? true : this.known[kind] !== this.saved[kind];
    this.emit();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(), REVISION_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.busy > 0 || !this.kicad) return;
    this.polling = true;
    try {
      for (const kind of ['board', 'schematic'] as const) {
        const doc = kind === 'board' ? this.boardDoc : this.schematicDoc;
        if (!doc) continue;
        const rev = await doc.revision();
        if (rev === undefined) continue;
        if (this.known[kind] !== undefined && rev !== this.known[kind]) {
          this.log(`${kind} changed on the server (revision ${this.known[kind]} -> ${rev}); re-reading items`);
          this.known[kind] = rev;
          if (kind === 'board') await this.boardDoc!.documentSync.refresh();
          else for (const h of this.sheetHandles.values()) await h.documentSync.refresh();
          this.dirty[kind] = rev !== this.saved[kind];
          this.emit();
        } else if (this.known[kind] === undefined) {
          this.known[kind] = rev;
        }
      }
    } catch (e) {
      if (!(e instanceof KiCadApiError)) this.log(`revision poll: ${describe(e)}`, 'warn');
    } finally {
      this.polling = false;
    }
  }

  // ------------------------------------------------------------------ DocumentService

  board(): ItemStore | null {
    return this.boardDoc?.store ?? null;
  }

  sheets(): SheetInfo[] {
    return this.sheetList;
  }

  sheet(path: string): ItemStore | null {
    const key = path === '/' || path === '' ? this.rootSheetKey : path;
    return this.sheetHandles.get(key)?.store ?? null;
  }

  sheetHandle(path: string): SheetHandle | undefined {
    const key = path === '/' || path === '' ? this.rootSheetKey : path;
    return this.sheetHandles.get(key);
  }

  footprint(libId: string): ItemStore | null {
    const doc = this.footprintDocs.get(libId);
    if (doc) return doc.store;
    if (this.kicad && !this.footprintPending.has(libId)) {
      this.footprintPending.add(libId);
      void this.kicad
        .openFootprint(libId)
        .then(async (fp) => {
          await fp.documentSync.load();
          this.footprintDocs.set(libId, fp);
          this.storeSubs.push(fp.store.subscribe(() => this.onStoreChanged('footprint')));
          this.emit();
        })
        .catch((e) => this.log(`OpenDocument(footprint ${libId}) failed: ${describe(e)}`, 'error'))
        .finally(() => this.footprintPending.delete(libId));
    }
    return null;
  }

  openFootprints(): string[] {
    return [...this.footprintDocs.keys()];
  }

  layers(): LayerInfo[] {
    return this.layerList;
  }

  nets(): NetInfo[] {
    return this.netList;
  }

  boardSetup(): BoardSetup {
    return this.setup;
  }

  async setBoardSetup(setup: BoardSetup): Promise<void> {
    const board = this.boardDoc;
    if (!board) return;
    const r = setup.rules;
    const nm = (v: number) => ({ valueNm: BigInt(Math.round(v)) });
    await board.setDesignRules({
      constraints: {
        minClearance: nm(r.minClearanceNm),
        minTrackWidth: nm(r.minTrackWidthNm),
        minViaSize: nm(r.minViaDiameterNm),
        minThroughDrill: nm(r.minViaDrillNm),
        holeToHoleMin: nm(r.minHoleToHoleNm),
        copperEdgeClearance: nm(r.copperToEdgeNm),
        minViaAnnularWidth: nm(r.minAnnularWidthNm),
        minSilkTextHeight: nm(r.minTextHeightNm),
        minSilkTextThickness: nm(r.minTextThicknessNm),
      },
    });
    await this.loadSetup();
    await this.afterCommit('board');
    this.emit();
  }

  netclasses(): NetclassInfo[] {
    return this.netclassList;
  }

  async setNetclasses(list: NetclassInfo[]): Promise<void> {
    const project = this.project;
    if (!project) return;
    const nm = (v: number) => ({ valueNm: BigInt(Math.round(v)) });
    await project.setNetClasses(
      list.map((n) =>
        create(NetClassSchema, {
          name: n.name,
          board: { clearance: nm(n.clearanceNm), trackWidth: nm(n.trackWidthNm), diffPairTrackWidth: nm(n.diffPairWidthNm), diffPairGap: nm(n.diffPairGapNm) },
          schematic: { wireWidth: nm(n.wireWidthNm), busWidth: nm(n.busWidthNm) },
        }),
      ),
    );
    this.netclassList = (await project.netClasses()).map(netclassInfo);
    this.emit();
  }

  textVariables(): TextVariable[] {
    return this.textVars;
  }

  async setTextVariables(list: TextVariable[]): Promise<void> {
    const project = this.project;
    if (!project) return;
    const vars: Record<string, string> = {};
    for (const v of list) vars[v.name] = v.value;
    await project.setTextVariables(vars, 1 /* MMM_REPLACE */);
    this.textVars = Object.entries(await project.textVariables()).map(([name, value]) => ({ name, value }));
    this.emit();
  }

  variants(): VariantInfo[] {
    return this.variantList;
  }

  async setVariants(list: VariantInfo[]): Promise<void> {
    const doc = this.boardDoc ?? this.schematicDoc;
    if (!doc) return;
    const before = new Map(this.variantList.map((v) => [v.name, v]));
    for (const v of list) {
      const prev = before.get(v.name);
      if (!prev) await doc.variants.add(v.name, v.description);
      else if (prev.description !== v.description) await doc.variants.setDescription(v.name, v.description);
      before.delete(v.name);
    }
    for (const gone of before.keys()) await doc.variants.delete(gone);
    const current = list.find((v) => v.current);
    if (current && !this.variantList.find((v) => v.current && v.name === current.name)) await doc.variants.setCurrent(current.name);
    const [all, cur] = await Promise.all([doc.variants.list(), doc.variants.current()]);
    this.variantList = all.map((v) => ({ name: v.name, description: v.description, current: v.name === cur }));
    this.emit();
  }

  async save(kind: DocumentKind): Promise<void> {
    const doc = kind === 'board' ? this.boardDoc : kind === 'schematic' ? this.schematicDoc : null;
    if (!doc) {
      if (kind === 'footprint') for (const fp of this.footprintDocs.values()) await fp.save();
      this.dirty[kind] = false;
      this.emit();
      return;
    }
    const done = this.beginActivity();
    try {
      await doc.save();
      this.saved[kind] = this.known[kind] = await doc.revision();
      this.dirty[kind] = false;
      this.emit();
    } finally {
      done();
    }
  }

  isDirty(kind: DocumentKind): boolean {
    return this.dirty[kind] ?? false;
  }

  /** `RefillZones` on every zone, then re-reads the zones (filled polygons change). */
  async refillZones(): Promise<void> {
    const board = this.boardDoc;
    if (!board) return;
    const done = this.beginActivity();
    try {
      await board.refillZones();
      await board.documentSync.refresh();
      await this.afterCommit('board');
    } finally {
      done();
    }
  }

  // ------------------------------------------------------------------ for the other services

  /** The document / sheet a store belongs to (commit target), or undefined for foreign stores. */
  targetFor(store: ItemStore): (CommitTarget & { kind: DocumentKind }) | undefined {
    if (this.boardDoc && store === this.boardDoc.store) return this.boardDoc;
    for (const h of this.sheetHandles.values()) if (h.store === store) return h;
    for (const f of this.footprintDocs.values()) if (store === f.store) return f;
    return undefined;
  }

  /** Every schematic sheet handle (root first). */
  sheetHandles_(): SheetHandle[] {
    return [...this.sheetHandles.values()];
  }

  /** Item types of a board store the renderer draws through the parent footprint. */
  static readonly FOOTPRINT_CHILD_TYPES: readonly KiCadObjectType[] = [KiCadObjectType.KOT_PCB_PAD, KiCadObjectType.KOT_PCB_FIELD];
}

function emptyRules(): DesignRules {
  return { minClearanceNm: 0, minTrackWidthNm: 0, minViaDiameterNm: 0, minViaDrillNm: 0, minHoleToHoleNm: 0, copperToEdgeNm: 0, minAnnularWidthNm: 0, minTextHeightNm: 0, minTextThicknessNm: 0 };
}

function netclassInfo(n: NetClass): NetclassInfo {
  return {
    name: n.name,
    clearanceNm: dist(n.board?.clearance),
    trackWidthNm: dist(n.board?.trackWidth),
    viaDiameterNm: dist(n.board?.viaStack?.drill?.diameter ? { valueNm: n.board.viaStack.drill.diameter.xNm } : undefined),
    viaDrillNm: dist(n.board?.viaStack?.drill?.diameter ? { valueNm: n.board.viaStack.drill.diameter.xNm } : undefined),
    diffPairWidthNm: dist(n.board?.diffPairTrackWidth),
    diffPairGapNm: dist(n.board?.diffPairGap),
    wireWidthNm: dist(n.schematic?.wireWidth),
    busWidthNm: dist(n.schematic?.busWidth),
    colour: colourCss(n.board?.color) || colourCss(n.schematic?.color),
  };
}

function create_spec() {
  return { $typeName: 'kiapi.common.types.DocumentSpecifier' as const, type: DocumentType.DOCTYPE_PROJECT, identifier: { case: undefined }, project: undefined };
}

export function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
