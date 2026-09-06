// DocumentService over `@kicad-web/client`'s object model. Owns the open Project / Board /
// Schematic / FootprintDocuments of the session, their ItemStores (filled by the client's
// DocumentSync), and the derived read models the panels want (layers, nets, board setup,
// net classes, text variables, variants). Dirty flags and foreign changes come from KiCad's
// events (`KiCadEvents` over the bridge's relay of the PUB socket: DocumentChanged re-syncs the
// listed KIIDs via GetItemsById, DocumentSaved clears dirty); `GetDocumentRevision` is polled
// every 2 s only while the bridge reports its events subscription disconnected.

import { create } from '@bufbuild/protobuf';
import {
  BoardLayer,
  BoardStackupLayerType,
  DocumentType,
  KiCadObjectType,
  type BoardStackup,
  type BoardStackupLayer,
  type CustomRule,
  type DocumentChanged,
  type DocumentSaved,
  type DocumentSpecifier,
  type NetClass,
} from '@kicad-web/proto';
import {
  Board,
  FootprintDocument,
  KiCadApiError,
  KiCadEvents,
  Project,
  Schematic,
  SheetHandle,
  WebSocketTransport,
  flattenHierarchy,
  toStoredItem,
  type ChangedIds,
  type KiCad,
  type Commit,
  type DocumentSync,
  type Item,
} from '@kicad-web/client';
import { NetClassSchema } from '@kicad-web/proto';
import type { DocumentKind, ItemStore, StoredItem } from '@/contracts';
import { layerDisplayName } from '@/lib/enums';
import type { BoardSetup, CustomRuleInfo, DesignRules, DocumentService, LayerInfo, NetInfo, NetclassInfo, SheetInfo, StackupLayer, TextVariable, VariantInfo } from '../types';
import { applyBoardSetup, readPageInfo, writePageInfo } from './KicadBoardSetup';
import type { PageInfo } from '../types';

/** Anything the commit backend can open a KiCad commit on. */
export interface CommitTarget {
  kind: DocumentKind;
  beginCommit(): Promise<Commit>;
}

export interface OpenOptions {
  /** Existence probe for sibling files (`<name>.kicad_pcb` next to a `.kicad_pro`); the bridge file API. */
  exists?: (path: string) => Promise<boolean>;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /**
   * KiCad event source. Default: `KiCadEvents.fromTransport()` when the client's transport is a
   * `WebSocketTransport` (the bridge relays the events socket); `null` disables events (poll only).
   */
  events?: KiCadEvents | null;
  /** KiCad announced `ServerShutdown`; the bridge's `server-state` follows once the process exits. */
  onServerShutdown?: () => void;
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
  /**
   * Opens library footprint documents somewhere that does not disturb the board: the headless
   * server unloads its board when a DOCTYPE_FOOTPRINT is opened on it (KicadLibraryService).
   */
  openFootprintDocument: ((libId: string) => Promise<FootprintDocument>) | null = null;
  /** Raw setup messages kept for writeback (UpdateBoardStackup / SetCustomDesignRules). */
  rawStackup: BoardStackup | null = null;
  rawCustomRules: CustomRule[] = [];
  private layerList: LayerInfo[] = [];
  private netList: NetInfo[] = [];
  private setup: BoardSetup = { copperLayers: 2, thicknessNm: 1_600_000, stackup: [], rules: emptyRules(), customRules: '', customRuleList: [], origin: { grid: { x: 0, y: 0 }, drill: { x: 0, y: 0 } } };
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
  private events: KiCadEvents | null = null;
  private ownsEvents = false;
  private eventSubs: (() => void)[] = [];
  /** DocumentChanged handlers run one at a time, in arrival order. */
  private eventQueue: Promise<void> = Promise.resolve();
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
    const base = path
      .split('/')
      .pop()!
      .replace(/\.kicad_(pro|pcb|sch)$/, '');
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
    this.attachEvents(kicad, opts);
    this.startPolling();
    this.emit();
  }

  async close(): Promise<void> {
    this.stopPolling();
    this.detachEvents();
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
      this.netList = nets.map((name) => ({ name, netclass: classes.get(name)?.name ?? 'Default', items: [...board.store.byNet(name)].length })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      this.log(`GetNets failed: ${describe(e)}`, 'warn');
    }
  }

  private async loadSetup(): Promise<void> {
    const board = this.boardDoc;
    if (!board) return;
    try {
      const [stackup, rules, custom, enabled, gridOrigin, drillOrigin] = await Promise.all([
        board.stackup(),
        board.designRules(),
        board.customRules().catch(() => null),
        board.enabledLayers(),
        board.origin('grid').catch(() => ({ x: 0, y: 0 })),
        board.origin('drill').catch(() => ({ x: 0, y: 0 })),
      ]);
      this.rawStackup = stackup;
      this.rawCustomRules = custom?.rules ?? [];
      const layers: StackupLayer[] = stackup.layers.map((l: BoardStackupLayer, i: number) => {
        const id = l.type === BoardStackupLayerType.BSLT_DIELECTRIC ? `dielectric${i}` : (BoardLayer[l.layer] ?? `layer${i}`);
        return {
          layer: id,
          name: l.userName || (id.startsWith('BL_') ? layerDisplayName(id) : l.materialName || 'Dielectric'),
          material: l.materialName,
          thicknessNm: dist(l.thickness),
          type: stackupType(l.type, l.layer),
        };
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
        customRuleList: (custom?.rules ?? []).map<CustomRuleInfo>((r) => ({ name: r.name, condition: r.condition, comments: r.comments ?? '', severity: r.severity, constraints: r.constraints.length })),
        customRulesError: custom?.errorText || undefined,
        origin: { grid: gridOrigin, drill: drillOrigin },
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

  /** Re-reads `GetSchematicHierarchy` after a sheet was added or removed; new sheets get stores. */
  async reloadHierarchy(): Promise<void> {
    const sch = this.schematicDoc;
    if (!sch) return;
    const top = await sch.hierarchy();
    const toInfo = (s: (typeof top)[number]): SheetInfo => {
      const handle = sch.sheet(s.path!, s);
      const key = this.sheetKey(handle);
      if (!this.sheetHandles.has(key)) {
        this.sheetHandles.set(key, handle);
        void handle.documentSync.load().then(() => {
          this.storeSubs.push(handle.store.subscribe(() => this.onStoreChanged('schematic')));
          this.emit();
        });
      }
      return { path: key, name: s.name || 'Root', file: s.filename, page: s.pageNumber, children: s.children.map(toInfo) };
    };
    this.sheetList = top.map(toInfo);
    this.emit();
  }

  /** Forgets an open footprint document (after the library session closed). */
  closeFootprint(libId: string): void {
    const doc = this.footprintDocs.get(libId);
    if (!doc) return;
    doc.documentSync.dispose();
    this.footprintDocs.delete(libId);
    this.emit();
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

  /**
   * Full re-read of a document after a server-side change *we* asked for outside a commit — undo,
   * teardrops, annotate, global deletion, the netlist updater. The `DocumentChanged` relay skips
   * those: it sees our own client name and assumes the commit backend already applied the diff,
   * which is only true for edits that went through `BeginCommit`.
   */
  async resyncDocument(kind: 'board' | 'schematic'): Promise<void> {
    if (kind === 'board' ? !this.boardDoc : !this.schematicDoc) return;
    const done = this.beginActivity();
    try {
      await this.resync(kind, undefined, {}, false);
    } catch (e) {
      this.log(`re-sync of the ${kind} failed: ${describe(e)}`, 'warn');
    } finally {
      done();
    }
    await this.afterCommit(kind);
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

  // ------------------------------------------------------------------ KiCad events

  /** True while KiCad events flow (bridge subscribed); the revision poll is then a no-op. */
  get eventsLive(): boolean {
    return this.events?.state === 'open';
  }

  private attachEvents(kicad: KiCad, opts: OpenOptions): void {
    this.detachEvents();
    let events = opts.events;
    if (events === undefined) {
      const t = kicad.client.transport;
      events = t instanceof WebSocketTransport ? KiCadEvents.fromTransport(t) : null;
      this.ownsEvents = events !== null;
    }
    if (!events) return;
    this.events = events;
    const queued = (fn: () => Promise<void>) => {
      this.eventQueue = this.eventQueue.then(fn).catch((e) => this.log(`event handler: ${describe(e)}`, 'warn'));
    };
    this.eventSubs.push(
      events.on('documentChanged', (ev) => queued(() => this.onDocumentChanged(ev))),
      events.on('documentSaved', (ev) => queued(async () => this.onDocumentSaved(ev))),
      events.on('serverShutdown', () => {
        this.log('KiCad server is shutting down', 'warn');
        this.stopPolling();
        this.opts.onServerShutdown?.();
      }),
      events.onGap((g) => {
        this.log(`missed KiCad events (sequence ${g.expected} -> ${g.received}); re-checking revisions`, 'warn');
        queued(() => this.poll(true));
      }),
      events.onStateChange((s) => {
        this.log(`KiCad events ${s === 'open' ? 'connected' : s === 'connecting' ? 'disconnected (polling GetDocumentRevision)' : 'closed'}`);
        // Anything that happened while events were down is caught by one revision check.
        if (s === 'open') queued(() => this.poll(true));
      }),
      events.onError((e) => this.log(`undecodable KiCad event: ${e.message}`, 'warn')),
    );
    this.log(`KiCad events ${this.eventsLive ? 'connected' : 'not connected (polling GetDocumentRevision)'}`);
  }

  private detachEvents(): void {
    for (const off of this.eventSubs) off();
    this.eventSubs = [];
    if (this.events && this.ownsEvents) void this.events.close();
    this.events = null;
    this.ownsEvents = false;
  }

  private kindOf(doc: DocumentSpecifier | undefined): DocumentKind | undefined {
    switch (doc?.type) {
      case DocumentType.DOCTYPE_PCB:
        return this.boardDoc ? 'board' : undefined;
      case DocumentType.DOCTYPE_SCHEMATIC:
        return this.schematicDoc ? 'schematic' : undefined;
      case DocumentType.DOCTYPE_FOOTPRINT:
        return 'footprint';
      case DocumentType.DOCTYPE_SYMBOL:
        return 'symbol';
      default:
        return undefined;
    }
  }

  private async onDocumentChanged(ev: DocumentChanged): Promise<void> {
    const kind = this.kindOf(ev.document);
    if (!kind || !this.kicad) return;
    const own = ev.clientName !== '' && ev.clientName === this.kicad.client.clientName;
    const ids: ChangedIds = { created: ev.created.map((k) => k.value), updated: ev.updated.map((k) => k.value), deleted: ev.deleted.map((k) => k.value) };
    const n = ids.created!.length + ids.updated!.length + ids.deleted!.length;
    if (!own) {
      // Foreign change (another client, or an API command outside a commit): pull the items.
      this.log(
        `${kind} changed on the server (revision ${ev.revision}${ev.clientName ? ` by ${ev.clientName}` : ''}${ev.message ? `, "${ev.message}"` : ''}); ${n ? `re-reading ${n} item(s)` : 're-reading the document'}`,
      );
      const done = this.beginActivity();
      try {
        await this.resync(kind, ev.document, ids, n > 0);
      } catch (e) {
        this.log(`re-sync after DocumentChanged failed: ${describe(e)}`, 'warn');
      } finally {
        done();
      }
    }
    if (kind === 'board' || kind === 'schematic') {
      this.known[kind] = ev.revision;
      this.dirty[kind] = this.saved[kind] === undefined || ev.revision !== this.saved[kind];
    } else if (!own) {
      this.dirty[kind] = true;
    }
    this.emit();
  }

  private async resync(kind: DocumentKind, doc: DocumentSpecifier | undefined, ids: ChangedIds, partial: boolean): Promise<void> {
    if (kind === 'board') {
      await (partial ? this.boardDoc!.documentSync.syncIds(ids) : this.boardDoc!.documentSync.refresh());
      return;
    }
    if (kind === 'schematic') {
      const handles = [...this.sheetHandles.values()];
      const named = doc?.identifier.case === 'sheetPath' ? this.sheetHandles.get(`/${doc.identifier.value.path.map((k) => k.value).join('/')}`) : undefined;
      if (partial && named) return named.documentSync.syncIds(ids);
      if (partial) {
        // No sheet in the event: route known ids to the sheet holding them; unknown created ids
        // could be on any sheet, so fall back to reloading them all.
        const unknownCreated = ids.created!.some((id) => !handles.some((h) => h.store.get(id) !== undefined));
        if (!unknownCreated) {
          for (const h of handles) {
            const mine = (list: readonly string[] | undefined) => (list ?? []).filter((id) => h.store.get(id) !== undefined);
            const sub: ChangedIds = { updated: [...mine(ids.created), ...mine(ids.updated)], deleted: mine(ids.deleted) };
            if (sub.updated!.length + sub.deleted!.length) await h.documentSync.syncIds(sub);
          }
          return;
        }
      }
      for (const h of handles) await h.documentSync.refresh();
      return;
    }
    if (kind === 'footprint') {
      const libId = doc?.identifier.case === 'libId' ? `${doc.identifier.value.libraryNickname}:${doc.identifier.value.entryName}` : undefined;
      for (const [id, fp] of this.footprintDocs) if (!libId || id === libId) await fp.documentSync.refresh();
    }
  }

  private onDocumentSaved(ev: DocumentSaved): void {
    const kind = this.kindOf(ev.document);
    if (!kind) return;
    if (kind === 'board' || kind === 'schematic') this.saved[kind] = this.known[kind] = ev.revision;
    this.dirty[kind] = false;
    this.log(`${kind} saved${ev.path ? ` to ${ev.path}` : ''} (revision ${ev.revision})`);
    this.emit();
  }

  // ------------------------------------------------------------------ revision poll (fallback)

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(), REVISION_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Compares revisions and reloads changed documents. Skipped while events are live unless `force`. */
  private async poll(force = false): Promise<void> {
    if (this.polling || this.busy > 0 || !this.kicad) return;
    if (!force && this.eventsLive) return;
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
    const open = this.openFootprintDocument ?? (this.kicad ? (id: string) => this.kicad!.openFootprint(id) : null);
    if (open && !this.footprintPending.has(libId)) {
      this.footprintPending.add(libId);
      void open(libId)
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
    const done = this.beginActivity();
    try {
      await applyBoardSetup(board, this.setup, setup, { stackup: this.rawStackup, customRules: this.rawCustomRules }, (m, l) => this.log(m, l));
      await this.loadSetup();
      await this.afterCommit('board');
      this.emit();
    } finally {
      done();
    }
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

  /** GetPageSettings + GetTitleBlockInfo of the board or the schematic. */
  async pageInfo(kind: 'board' | 'schematic'): Promise<PageInfo> {
    const doc = kind === 'board' ? this.boardDoc : this.schematicDoc;
    if (!doc) throw new Error(`no ${kind} is open`);
    return readPageInfo(doc);
  }

  async setPageInfo(kind: 'board' | 'schematic', info: PageInfo): Promise<void> {
    const doc = kind === 'board' ? this.boardDoc : this.schematicDoc;
    if (!doc) throw new Error(`no ${kind} is open`);
    const done = this.beginActivity();
    try {
      const before = await readPageInfo(doc).catch(() => null);
      await writePageInfo(doc, before, info, (m, l) => this.log(m, l));
      await this.afterCommit(kind);
    } finally {
      done();
    }
  }

  /** KiCad event source (for `Job.wait`), null while events are off. */
  get kicadEvents(): KiCadEvents | null {
    return this.events;
  }

  /** `SaveItemsToString`: KiCad clipboard s-expression text for board items or items of one sheet. */
  async saveItemsToString(kind: DocumentKind, id: string, ids: string[]): Promise<string> {
    if (kind === 'board' && this.boardDoc) return this.boardDoc.saveItemsToString(ids);
    if (kind === 'schematic' && this.schematicDoc) {
      const h = this.sheetHandle(id);
      if (!h) throw new Error(`sheet ${id} is not open`);
      return this.schematicDoc.saveItemsToString(ids, h.scope);
    }
    throw new Error(`no ${kind} is open`);
  }

  /**
   * `ParseAndCreateItemsFromString`: KiCad pastes clipboard-style text with fresh ids in a commit of
   * its own; the store follows through DocumentSync. Returns the canonical items.
   */
  async parseAndCreate(kind: DocumentKind, id: string, text: string): Promise<StoredItem[]> {
    const done = this.beginActivity();
    try {
      let items: Item[];
      if (kind === 'board' && this.boardDoc) items = await this.boardDoc.parseAndCreate(text);
      else if (kind === 'schematic' && this.schematicDoc) {
        const h = this.sheetHandle(id);
        if (!h) throw new Error(`sheet ${id} is not open`);
        items = await this.schematicDoc.parseAndCreate(text, h.scope);
      } else throw new Error(`no ${kind} is open`);
      await this.afterCommit(kind);
      this.log(`ParseAndCreateItemsFromString: ${items.length} item(s) created on the ${kind}`);
      return items.map(toStoredItem);
    } finally {
      done();
    }
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
    viaDiameterNm: num(n.board?.viaStack?.copperLayers[0]?.size?.xNm),
    viaDrillNm: num(n.board?.viaStack?.drill?.diameter?.xNm),
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
