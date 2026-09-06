// Optional service surfaces added in batch 3: the library browser, the board net / bulk tools,
// the schematic workflow (annotate, sync to board, fields table), KiCad's own settings and
// server-side undo. They hang off `Services` as optional members because only the KiCad service
// graph implements them — the mock leaves them undefined and the UI degrades to a notice.

import type { ItemStore } from '@/contracts';

// ------------------------------------------------------------------------------- libraries

export type LibraryKind = 'symbol' | 'footprint' | 'designBlock';

/** One row of KiCad's `fp-lib-table` / `sym-lib-table` (`GetLibraryTables`). */
export interface LibraryTableEntry {
  nickname: string;
  uri: string;
  description: string;
  scope: 'global' | 'project' | 'unknown';
  enabled: boolean;
}

/** One entry of a library (`ListLibraryEntries`), with the summary KiCad attaches. */
export interface LibraryEntrySummary {
  /** `nickname:name` */
  libId: string;
  nickname: string;
  name: string;
  description: string;
  keywords: string;
  /** symbols */
  unitCount?: number;
  isPower?: boolean;
  /** footprints */
  padCount?: number;
  /** 'through hole' | 'smd' | 'unspecified' (FootprintMountingStyle). */
  mounting?: string;
  /** Symbols: the library's default footprint, used to seed "Assign footprints". */
  defaultFootprint?: string;
}

export interface LibraryService {
  /** `GetLibraryTables`: global rows first, then the project's. Cached per kind. */
  tables(kind: LibraryKind): Promise<LibraryTableEntry[]>;
  /** `ListLibraryEntries` for one library; cached per library, filtered in memory. */
  entries(kind: LibraryKind, nickname: string, filter?: string): Promise<LibraryEntrySummary[]>;
  /** A throwaway single-item store for the preview canvas (footprint instance / symbol instance). */
  preview(kind: 'footprint' | 'symbol', libId: string): Promise<ItemStore | null>;
  /** Drops cached entry lists (all, one kind, or one library). */
  invalidate(kind?: LibraryKind, nickname?: string): void;
}

// ----------------------------------------------------------------------------- board tools

export interface UnroutedInfo {
  unroutedCount: number;
  unroutedNetCount: number;
}

/** One row of `GetNetLengths`. */
export interface NetLengthRow {
  net: string;
  netclass: string;
  /** Sum over every copper layer, nm. */
  totalNm: number;
  padCount: number;
  viaCount: number;
  delayPs: number;
  byLayer: { layer: string; lengthNm: number }[];
}

export interface TeardropOptions {
  vias?: boolean;
  pthPads?: boolean;
  smdPads?: boolean;
  trackToTrack?: boolean;
  roundShapesOnly?: boolean;
  nets?: string[];
}

export interface GlobalDeleteOptions {
  types: string[];
  layers?: string[];
  locked?: 'all' | 'locked' | 'unlocked';
  boardEdges?: boolean;
  teardrops?: boolean;
}

export interface FootprintUpdateReport {
  updatedCount: number;
  unchangedCount: number;
  missing: string[];
  messages: string[];
}

export interface BoardToolsService {
  unrouted(): Promise<UnroutedInfo>;
  netLengths(nets?: string[]): Promise<NetLengthRow[]>;
  setTeardrops(opts: TeardropOptions): Promise<number>;
  removeTeardrops(): Promise<number>;
  autoplace(ids?: string[], opts?: { includeOffboard?: boolean }): Promise<{ placedCount: number; ok: boolean; result: string }>;
  globalDeletion(opts: GlobalDeleteOptions): Promise<number>;
  updateFootprintsFromLibrary(refs?: string[], opts?: { onlyChanged?: boolean }): Promise<FootprintUpdateReport>;
  /** `Get|SetDrcSeverities` / the ERC twins, keyed by the rule-type enum name. */
  severities(kind: 'drc' | 'erc'): Promise<{ rule: string; severity: RuleSeverityName }[]>;
  setSeverities(kind: 'drc' | 'erc', changes: { rule: string; severity: RuleSeverityName }[]): Promise<void>;
}

export type RuleSeverityName = 'error' | 'warning' | 'ignore';

// ------------------------------------------------------------------------- schematic tools

export interface AnnotateOptions {
  scope: 'all' | 'sheet' | 'selection';
  sortOrder: 'x' | 'y' | 'unsorted';
  numbering: 'incremental' | 'sheetX100' | 'sheetX1000';
  startNumber: number;
  resetExisting: boolean;
  recursive: boolean;
  items?: string[];
  sheetPath?: string;
}

export interface AnnotateReport {
  annotatedCount: number;
  symbolCount: number;
  errorCount: number;
  messages: string[];
}

export interface SyncReport {
  errorCount: number;
  warningCount: number;
  newFootprintCount: number;
  report: string;
  dryRun: boolean;
}

export interface SyncOptions {
  dryRun?: boolean;
  matchMode?: 'uuid' | 'reference';
  deleteExtraFootprints?: boolean;
  updateFootprints?: boolean;
  updateFields?: boolean;
  removeExtraFields?: boolean;
}

/** One row of `GetSymbolFieldsTable`. */
export interface FieldsRow {
  id: string;
  sheet: string;
  reference: string;
  unit: number;
  fields: Record<string, string>;
  excludedFromBom: boolean;
  excludedFromBoard: boolean;
  doNotPopulate: boolean;
}

export interface FieldsTable {
  rows: FieldsRow[];
  /** Every field name seen, Reference / Value / Footprint / Datasheet first. */
  columns: string[];
}

export interface FieldEditInput {
  id: string;
  field: string;
  value: string;
}

export interface SchematicToolsService {
  annotate(opts: AnnotateOptions): Promise<AnnotateReport>;
  clearAnnotation(opts: Pick<AnnotateOptions, 'scope' | 'items' | 'recursive'>): Promise<AnnotateReport>;
  syncToBoard(opts?: SyncOptions): Promise<SyncReport>;
  fieldsTable(opts?: { includePowerSymbols?: boolean }): Promise<FieldsTable>;
  setFields(edits: FieldEditInput[]): Promise<{ updatedCount: number; errors: string[] }>;
  assignFootprints(assignments: { reference: string; footprint: string }[]): Promise<{ assignedCount: number; unmatchedReferences: string[] }>;
}

// ----------------------------------------------------------------------- KiCad app settings

export interface ColorThemeInfo {
  name: string;
  filename: string;
  readOnly: boolean;
}

export interface AppDefaults {
  /** 'mm' | 'in' | 'mil' when KiCad's UnitSystem maps onto ours. */
  units?: 'mm' | 'in' | 'mil';
  colorTheme: string;
  /** Grid spacings KiCad offers, nanometres (square grids only). */
  gridsNm: number[];
  currentGridNm?: number;
  gridVisible: boolean;
}

export interface ServerSettingsService {
  /** `ListColorThemes`. */
  colorThemes(): Promise<ColorThemeInfo[]>;
  /** `GetColorTheme` turned into a renderer `Theme` (nulls when the server has no such theme). */
  colorTheme(name: string): Promise<import('@kicad-web/renderer').Theme | null>;
  /** `GetAppSettings` for the PCB or schematic editor. */
  appSettings(app: 'board' | 'schematic'): Promise<AppDefaults | null>;
}

// -------------------------------------------------------------------------- server undo

/** One entry of KiCad's own undo stack (`GetUndoStack`), oldest first. */
export interface UndoStackEntry {
  description: string;
  /** The API client that made the commit (empty for KiCad's own edits). */
  clientName: string;
  itemCount: number;
}

export interface ServerUndoStacks {
  undo: UndoStackEntry[];
  redo: UndoStackEntry[];
}

export interface ServerUndoService {
  /** Whether KiCad's own `Undo` is advertised for the active document. */
  mode(): Promise<'server' | 'client'>;
  /** Cached answer of `mode()` (undefined until first probe). */
  cachedMode(): 'server' | 'client' | undefined;
  stacks(): Promise<ServerUndoStacks>;
  undo(): Promise<{ via: 'server' | 'client' | 'none'; applied: number; label?: string }>;
  redo(): Promise<{ via: 'server' | 'client' | 'none'; applied: number; label?: string }>;
  onChange(cb: () => void): () => void;
}
