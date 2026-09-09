// The service boundary. UI code only ever talks to these interfaces, obtained from the
// `ServicesProvider`. `services/mock/*` implements them in memory; the real
// implementations (wrapping `@fp-pcb/client`) will live in `services/kicad/*`.

import type { DocumentKind, ItemStore, StoredItem } from '@/contracts';
import type { Patch } from '@/lib/patch';

// ---------------------------------------------------------------------------- session

export type SessionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

export interface SessionInfo {
  id: string;
  projectPath: string;
  projectName: string;
  kicadVersion: string;
  kicadToken: string;
  state: SessionState;
  error?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
  modified?: string; // ISO
  fileType?: 'project' | 'board' | 'schematic' | 'footprint' | 'symbol-lib' | 'other';
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpened: string; // ISO
  boards: number;
  sheets: number;
}

export interface SessionService {
  readonly session: SessionInfo | null;
  onChange(cb: (s: SessionInfo | null) => void): () => void;
  /** POST /sessions {path} then open the WebSocket /ws?session=<id>. */
  connect(projectPath: string): Promise<SessionInfo>;
  /** DELETE /sessions/:id */
  disconnect(): Promise<void>;
  /** GET /files/<path> (directory listing restricted to the workspace root). */
  listFiles(path: string): Promise<FileEntry[]>;
  workspaceRoot(): string;
  recentProjects(): Promise<RecentProject[]>;
  createProject(directory: string, name: string): Promise<string>; // returns project path
}

// -------------------------------------------------------------------------- documents

export interface LayerInfo {
  id: string; // 'BL_F_Cu'
  name: string; // user name, e.g. 'F.Cu'
  kind: 'copper' | 'technical' | 'user' | 'edge';
}

export interface NetInfo {
  name: string;
  netclass: string;
  items: number;
}

export interface SheetInfo {
  path: string; // '/' or '/<uuid>/...' (SheetPath.path_human_readable)
  name: string;
  file: string;
  page: string;
  children: SheetInfo[];
}

export interface NetclassInfo {
  name: string;
  clearanceNm: number;
  trackWidthNm: number;
  viaDiameterNm: number;
  viaDrillNm: number;
  diffPairWidthNm: number;
  diffPairGapNm: number;
  wireWidthNm: number;
  busWidthNm: number;
  colour: string;
}

export interface StackupLayer {
  layer: string;
  name: string;
  material: string;
  thicknessNm: number;
  type: 'copper' | 'core' | 'prepreg' | 'soldermask' | 'silkscreen';
}

export interface DesignRules {
  minClearanceNm: number;
  minTrackWidthNm: number;
  minViaDiameterNm: number;
  minViaDrillNm: number;
  minHoleToHoleNm: number;
  copperToEdgeNm: number;
  minAnnularWidthNm: number;
  minTextHeightNm: number;
  minTextThicknessNm: number;
}

export interface CustomRuleInfo {
  name: string;
  condition: string;
  comments: string;
  /** DrcSeverity enum value */
  severity: number;
  /** number of constraints (edited structurally in KiCad; shown read-only here) */
  constraints: number;
}

export interface BoardSetup {
  copperLayers: number;
  thicknessNm: number;
  stackup: StackupLayer[];
  rules: DesignRules;
  customRules: string; // .kicad_dru text (read-only rendering of the structured rules)
  /** Structured custom rules (SetCustomDesignRules writeback: name / condition / comments / severity). */
  customRuleList: CustomRuleInfo[];
  customRulesError?: string;
  /** Grid and drill/place origins (SetBoardOrigin), nm. */
  origin: { grid: { x: number; y: number }; drill: { x: number; y: number } };
}

export interface PageInfo {
  /** PageSize enum name, e.g. 'PS_A4' */
  pageSize: string;
  orientation: 'landscape' | 'portrait';
  userWidthNm: number;
  userHeightNm: number;
  drawingSheet: string;
  title: string;
  date: string;
  revision: string;
  company: string;
  comments: string[];
}

export interface TextVariable {
  name: string;
  value: string;
}

export interface VariantInfo {
  name: string;
  description: string;
  current: boolean;
}

export interface DocumentService {
  onChange(cb: () => void): () => void;
  board(): ItemStore | null;
  sheets(): SheetInfo[];
  sheet(path: string): ItemStore | null;
  footprint(libId: string): ItemStore | null;
  openFootprints(): string[];
  layers(): LayerInfo[];
  nets(): NetInfo[];
  boardSetup(): BoardSetup;
  setBoardSetup(setup: BoardSetup): Promise<void>;
  netclasses(): NetclassInfo[];
  setNetclasses(list: NetclassInfo[]): Promise<void>;
  textVariables(): TextVariable[];
  setTextVariables(list: TextVariable[]): Promise<void>;
  variants(): VariantInfo[];
  setVariants(list: VariantInfo[]): Promise<void>;
  save(kind: DocumentKind): Promise<void>;
  isDirty(kind: DocumentKind): boolean;
}

// --------------------------------------------------------------------------- commands

export interface ItemOp {
  kind: 'create' | 'update' | 'delete';
  item: StoredItem; // for 'update' the full post-state; for 'delete' the pre-state
}

export interface HistoryEntry {
  id: number;
  message: string;
  storeKey: string; // which document the entry belongs to
  forward: ItemOp[];
  inverse: ItemOp[];
  at: number;
}

export interface Transaction {
  readonly id: number;
  readonly message: string;
  readonly store: ItemStore;
  /** Optimistically patch an item in the store; recorded for undo. */
  update(id: string, patches: Patch[]): void;
  /** Replace an item's proto wholesale (used by move preview). */
  replace(id: string, proto: unknown, meta?: Partial<Pick<StoredItem, 'layer' | 'net' | 'bbox'>>): void;
  create(item: StoredItem): void;
  delete(id: string): void;
  /** EndCommit(CMA_COMMIT): push to history, resolve with canonical items. */
  commit(): Promise<void>;
  /** EndCommit(CMA_DROP): roll the store back. */
  drop(): Promise<void>;
}

export interface CommandService {
  begin(store: ItemStore, message: string): Transaction;
  /** Convenience: begin, run `fn`, commit (or drop if `fn` throws). */
  run(store: ItemStore, message: string, fn: (tx: Transaction) => void): Promise<void>;
  /** Records ops that already happened on the server (no transaction) so undo / redo replay them. */
  record(store: ItemStore, message: string, forward: ItemOp[], inverse: ItemOp[]): void;
  undo(): Promise<HistoryEntry | null>;
  redo(): Promise<HistoryEntry | null>;
  canUndo(): boolean;
  canRedo(): boolean;
  history(): { undo: HistoryEntry[]; redo: HistoryEntry[] };
  onHistoryChange(cb: () => void): () => void;
  clearHistory(): void;
}

// ------------------------------------------------------------------------------- jobs

export type JobOptionType = 'boolean' | 'string' | 'select' | 'layers' | 'number' | 'path';

export interface JobOption {
  key: string;
  label: string;
  type: JobOptionType;
  default: unknown;
  choices?: { value: string; label: string }[];
  help?: string;
}

export interface JobDefinition {
  id: string; // 'board.gerbers'
  title: string;
  description: string;
  document: DocumentKind | 'project';
  command: string; // kiapi request type, e.g. 'RunBoardJobExportGerbers'
  options: JobOption[];
  /** Why the job cannot run on this server (shown instead of the Run button). */
  unavailable?: string;
}

export interface JobOutput {
  name: string;
  path: string;
  bytes: number;
  mime: string;
  /** Download URL (the bridge's `/files/read`), when the output is inside the workspace. */
  url?: string;
}

export interface JobRun {
  id: string;
  jobId: string;
  title: string;
  startedAt: number;
  finishedAt?: number;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number; // 0..1
  log: string[];
  outputs: JobOutput[];
  error?: string;
}

export interface JobsService {
  jobs(): JobDefinition[];
  runs(): JobRun[];
  run(jobId: string, options: Record<string, unknown>): Promise<JobRun>;
  onChange(cb: () => void): () => void;
  clearFinished(): void;
}

// ---------------------------------------------------------------------------- markers

export type MarkerSeverity = 'error' | 'warning' | 'info' | 'exclusion';

export interface Marker {
  id: string;
  kind: 'drc' | 'erc';
  severity: MarkerSeverity;
  rule: string; // e.g. 'clearance', 'unconnected_items', 'pin_not_connected'
  message: string;
  items: string[]; // KIIDs involved
  position: { x: number; y: number }; // nm
  sheetPath?: string;
  excluded: boolean;
  /** KiCad's exclusion comment (`DrcMarker.exclusion_comment`), empty when not excluded. */
  comment?: string;
}

export interface MarkerService {
  markers(kind: 'drc' | 'erc'): Marker[];
  lastRun(kind: 'drc' | 'erc'): number | null;
  run(kind: 'drc' | 'erc'): Promise<Marker[]>;
  setExcluded(id: string, excluded: boolean): void;
  onChange(cb: () => void): () => void;
  /** Exclusion with KiCad's comment field (`SetDrcMarkerExcluded.comment`); optional on the mock. */
  setExcludedWithComment?(id: string, excluded: boolean, comment: string): Promise<void>;
}

export * from './extras';
import type { AutorouteService, BoardToolsService, LibraryService, SchematicToolsService, ServerSettingsService, ServerUndoService } from './extras';

export interface Services {
  session: SessionService;
  documents: DocumentService;
  commands: CommandService;
  jobs: JobsService;
  markers: MarkerService;
  /**
   * Batch-3 surfaces, present only on the KiCad service graph (the mock leaves them undefined
   * and the UI says the feature needs the real services).
   */
  library?: LibraryService;
  board?: BoardToolsService;
  schematic?: SchematicToolsService;
  settings?: ServerSettingsService;
  undo?: ServerUndoService;
  /** Autorouting (Route -> Autoroute...): js_autorouter or Freerouting on the bridge. */
  autoroute?: AutorouteService;
}
