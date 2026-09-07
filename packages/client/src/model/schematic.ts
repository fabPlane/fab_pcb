/**
 * `Schematic` — a schematic document, and `SheetHandle` — a view of one sheet of its hierarchy.
 * Schematic items are addressed per sheet: `ItemHeader.document.sheet_path` selects the sheet for
 * reads and commits, so `schematic.sheet(path)` returns a handle whose calls set it for you.
 */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  AnnotateNumbering,
  AnnotateScope,
  AnnotateSortOrder,
  KIIDSchema,
  KiCadObjectType,
  NetlistMatchMode,
  SchematicSettingsSchema,
  SheetPathSchema,
  SheetSymbolSchema,
  type LibraryIdentifier,
  type SchematicNet,
  type SchematicSettings,
  type SheetInstance,
  type SheetPath,
  type SymbolFieldsRow,
} from "@fp-pcb/proto";
import * as cmd from "../commands";
import { DocumentSync } from "../store/document-sync";
import type { ItemStore } from "../store/item-store";
import type { Commit, CommitOptions, CommitResult, DeleteResult, ItemInput } from "./commit";
import { SchematicErc } from "./checks";
import {
  Document,
  sheetPathKey,
  type DocumentChange,
  type DocumentKind,
  type ItemCounts,
  type ItemScope,
  type ItemsSince,
} from "./document";
import { SCHEMATIC_ITEM_TYPES, SchematicLine, SchematicSymbol, Sheet, wrapAll, type Item } from "./items";
import { SchematicJobs } from "./jobs";
import { toLibraryId, type LibIdLike } from "./libraries";
import { toEntries, type EntryMapLike } from "./entries";
import { toVector2, type Vec2 } from "../units";
import type { Board, NetlistImportResult } from "./board";

export type SheetPathLike = SheetPath | readonly string[] | string;

/** Builds a `SheetPath` from a message, a KIID array, or a `/kiid/kiid` string. */
export function toSheetPath(p: SheetPathLike, humanReadable?: string): SheetPath {
  if (typeof p === "object" && !Array.isArray(p) && "$typeName" in p) return p as SheetPath;
  const ids = typeof p === "string" ? p.split("/").filter(Boolean) : (p as readonly string[]);
  return create(SheetPathSchema, { path: ids.map((value) => create(KIIDSchema, { value })), pathHumanReadable: humanReadable ?? "" });
}

/** Flattens a hierarchy tree into `[instance, depth]` pairs, depth first. */
export function flattenHierarchy(top: readonly SheetInstance[]): { sheet: SheetInstance; depth: number }[] {
  const out: { sheet: SheetInstance; depth: number }[] = [];
  const visit = (s: SheetInstance, depth: number) => {
    out.push({ sheet: s, depth });
    for (const c of s.children) visit(c, depth + 1);
  };
  for (const s of top) visit(s, 0);
  return out;
}

/** Where `annotate` / `clearAnnotation` apply. */
export type AnnotationScope = "all" | "sheet" | "selection";

export interface AnnotateOptions {
  /** Default `"all"`; `"sheet"` uses the document's sheet path, `"selection"` the listed `items`. */
  scope?: AnnotationScope;
  /** Symbols and sheets for `scope: "selection"`. */
  items?: readonly string[];
  /** Sheet to annotate for `scope: "sheet"` (defaults to the root sheet). */
  sheetPath?: SheetPathLike;
  sortOrder?: "x" | "y" | "unsorted";
  numbering?: "incremental" | "sheetX100" | "sheetX1000";
  startNumber?: number;
  /** Clear existing references first; otherwise only unannotated symbols get numbers. */
  resetExisting?: boolean;
  /** Include sub-sheets of the sheet (or of the selected sheets). */
  recursive?: boolean;
  /** Let units of multi-unit symbols regroup freely instead of keeping their current sets. */
  regroupUnits?: boolean;
}

export interface AnnotateResult {
  /** Symbols whose reference this call assigned or changed (cleared, for `clearAnnotation`). */
  annotatedCount: number;
  /** Symbols considered (annotated or already correct). */
  symbolCount: number;
  /** Problems the annotation check reported afterwards (duplicates, missing numbers). */
  errorCount: number;
  messages: string[];
}

/** `SyncSchematicToBoard`: the netlist updater's report, as `ImportNetlist` returns it. */
export interface SyncToBoardResult extends NetlistImportResult {
  /** The temporary netlist file KiCad applied and then removed; informational only. */
  netlistPath: string;
}

export interface SyncToBoardOptions {
  /** Report the planned changes without modifying the board. */
  dryRun?: boolean;
  matchMode?: "uuid" | "reference";
  deleteExtraFootprints?: boolean;
  /** Replace footprints whose library id changed in the schematic. */
  updateFootprints?: boolean;
  /** Copy symbol field values to the footprints (KiCad's default is true). */
  updateFields?: boolean;
  /** Remove footprint fields the symbol does not have (only with `updateFields`). */
  removeExtraFields?: boolean;
  transferGroups?: boolean;
  overrideLocks?: boolean;
}

/** One row of the symbol fields table: a placement with its field values. */
export interface FieldsTableRow {
  id: string;
  sheetPath: SheetPath | undefined;
  /** Human-readable sheet path (`/`, `/child`), when KiCad filled it in. */
  sheet: string;
  reference: string;
  unit: number;
  /** Every field by name, including Reference, Value, Footprint, Datasheet, Description. */
  fields: Record<string, string>;
  excludedFromBom: boolean;
  excludedFromBoard: boolean;
  doNotPopulate: boolean;
}

/** One edit for `setFields`. */
export interface FieldEdit {
  /** KIID of the symbol. */
  id: string;
  field: string;
  value?: string;
  /**
   * Required for Reference / Value / Footprint on symbols placed more than once (those three are
   * per placement; other fields are shared by every placement of the symbol).
   */
  sheetPath?: SheetPathLike;
  /** Remove the (user) field instead of setting it. */
  remove?: boolean;
}

export interface SetFieldsResult {
  updatedCount: number;
  /** Edits that could not be applied (unknown symbol, mandatory field removal, ...). */
  errors: string[];
}

export interface AssignFootprintsResult {
  assignedCount: number;
  /** References that matched no symbol. */
  unmatchedReferences: string[];
}

/** One footprint assignment in the array-of-records form. */
export interface FootprintAssignment {
  reference: string;
  footprint: LibIdLike;
}

/** Reference designator -> footprint, in any of the shapes `assignFootprints` accepts. */
export type FootprintAssignments = EntryMapLike<LibIdLike> | readonly FootprintAssignment[];

function isAssignmentRecords(a: FootprintAssignments): a is readonly FootprintAssignment[] {
  return Array.isArray(a) && a.every((e) => typeof e === "object" && e !== null && !Array.isArray(e) && "reference" in e);
}

export interface NewSheetOptions {
  /** Sheet the new sheet symbol is placed on; defaults to the document's current (root) sheet. */
  parentPath?: SheetPathLike;
  name: string;
  /** File the sheet names; relative paths are resolved next to the parent schematic. */
  filename: string;
  position?: Vec2;
  size?: Vec2;
}

const SORT_ORDERS: Record<string, AnnotateSortOrder> = {
  x: AnnotateSortOrder.ASO_X_POSITION,
  y: AnnotateSortOrder.ASO_Y_POSITION,
  unsorted: AnnotateSortOrder.ASO_UNSORTED,
};

const NUMBERINGS: Record<string, AnnotateNumbering> = {
  incremental: AnnotateNumbering.ANM_INCREMENTAL,
  sheetX100: AnnotateNumbering.ANM_SHEET_NUMBER_X100,
  sheetX1000: AnnotateNumbering.ANM_SHEET_NUMBER_X1000,
};

const SCOPES: Record<AnnotationScope, AnnotateScope> = {
  all: AnnotateScope.ANS_ALL,
  sheet: AnnotateScope.ANS_SHEET,
  selection: AnnotateScope.ANS_SELECTION,
};

export class Schematic extends Document {
  readonly kind: DocumentKind = "schematic";
  readonly itemTypes = SCHEMATIC_ITEM_TYPES;
  readonly jobs = new SchematicJobs(this);
  /** Electrical rules checker: `run()`, `markers()`, `exclude()`, `severities()` (KiCad >= 11.0). */
  readonly erc = new SchematicErc(this);
  private readonly handles = new Map<string, SheetHandle>();

  /** Top-level sheet instances with their children (`GetSchematicHierarchy`). */
  async hierarchy(): Promise<SheetInstance[]> {
    return (await cmd.getSchematicHierarchy(this.client, { document: this.specifier })).topLevelSheets;
  }

  /** Every sheet in the hierarchy as a handle, root first, depth-first. */
  async sheets(): Promise<SheetHandle[]> {
    return flattenHierarchy(await this.hierarchy()).map(({ sheet }) => this.sheet(sheet.path ?? create(SheetPathSchema), sheet));
  }

  /** Handle for the root sheet. */
  async rootSheet(): Promise<SheetHandle> {
    const top = await this.hierarchy();
    const root = top[0];
    if (!root?.path) throw new Error("schematic has no root sheet");
    return this.sheet(root.path, root);
  }

  /** Handle for a sheet by KIID path (cached per path). */
  sheet(path: SheetPathLike, instance?: SheetInstance): SheetHandle {
    const sp = toSheetPath(path, instance?.path?.pathHumanReadable);
    const key = sheetPathKey(sp);
    let h = this.handles.get(key);
    if (!h) {
      h = new SheetHandle(this, sp, instance);
      this.handles.set(key, h);
    } else if (instance && !h.instance) {
      h.instance = instance;
    }
    return h;
  }

  /** Finds a sheet by its human-readable path (`/`, `/child`, ...). */
  async sheetByPath(humanPath: string): Promise<SheetHandle | undefined> {
    const all = flattenHierarchy(await this.hierarchy());
    const hit = all.find(({ sheet }) => sheet.path?.pathHumanReadable === humanPath);
    return hit?.sheet.path ? this.sheet(hit.sheet.path, hit.sheet) : undefined;
  }

  /** Connectivity: every net with the items on each sheet (`GetSchematicNetlist`). */
  async netlist(types: readonly KiCadObjectType[] = []): Promise<SchematicNet[]> {
    return (await cmd.getSchematicNetlist(this.client, { document: this.specifier, types: [...types] })).nets;
  }

  async getSymbols(scope?: ItemScope): Promise<SchematicSymbol[]> {
    return (await this.getItems(KiCadObjectType.KOT_SCH_SYMBOL, scope)).filter((i): i is SchematicSymbol => i instanceof SchematicSymbol);
  }

  async getWires(scope?: ItemScope): Promise<SchematicLine[]> {
    return (await this.getItems(KiCadObjectType.KOT_SCH_LINE, scope)).filter(
      (i): i is SchematicLine => i instanceof SchematicLine && i.isWire,
    );
  }

  async getSheetSymbols(scope?: ItemScope): Promise<Sheet[]> {
    return (await this.getItems(KiCadObjectType.KOT_SCH_SHEET, scope)).filter((i): i is Sheet => i instanceof Sheet);
  }

  // --- annotation ---------------------------------------------------------------------------------

  /**
   * `Annotate`: numbers symbols the way the annotation dialog does, as one API commit. Symbols
   * keep their references unless `resetExisting`. Options left unset take the project's
   * annotation settings.
   */
  async annotate(opts: AnnotateOptions = {}): Promise<AnnotateResult> {
    const res = await cmd.annotate(this.client, {
      schematic: this.specifierFor(opts.sheetPath ? { sheetPath: toSheetPath(opts.sheetPath) } : undefined),
      scope: SCOPES[opts.scope ?? "all"],
      items: (opts.items ?? []).map((value) => ({ value })),
      options: {
        sortOrder: opts.sortOrder ? SORT_ORDERS[opts.sortOrder] : AnnotateSortOrder.ASO_UNKNOWN,
        numbering: opts.numbering ? NUMBERINGS[opts.numbering] : AnnotateNumbering.ANM_UNKNOWN,
        startNumber: opts.startNumber ?? 0,
        resetExisting: opts.resetExisting ?? false,
        recursive: opts.recursive ?? false,
        regroupUnits: opts.regroupUnits ?? false,
      },
    });
    return { annotatedCount: res.annotatedCount, symbolCount: res.symbolCount, errorCount: res.errorCount, messages: res.messages };
  }

  /** `ClearAnnotation`: the symbols in scope become `R?`. `annotatedCount` counts those cleared. */
  async clearAnnotation(
    scope: AnnotationScope = "all",
    opts: { items?: readonly string[]; sheetPath?: SheetPathLike; recursive?: boolean } = {},
  ): Promise<AnnotateResult> {
    const res = await cmd.clearAnnotation(this.client, {
      schematic: this.specifierFor(opts.sheetPath ? { sheetPath: toSheetPath(opts.sheetPath) } : undefined),
      scope: SCOPES[scope],
      items: (opts.items ?? []).map((value) => ({ value })),
      recursive: opts.recursive ?? false,
    });
    return { annotatedCount: res.annotatedCount, symbolCount: res.symbolCount, errorCount: res.errorCount, messages: res.messages };
  }

  // --- board synchronisation ----------------------------------------------------------------------

  /**
   * `SyncSchematicToBoard` ("Update PCB from Schematic"): exports this schematic's netlist
   * in-process and applies it to `board` with the netlist updater — no netlist file to write.
   * Both documents must be open in the same KiCad instance. Refused (`AS_BAD_REQUEST`) for an
   * unannotated schematic, exactly as the dialog is.
   */
  async syncToBoard(board: Board, opts: SyncToBoardOptions = {}): Promise<SyncToBoardResult> {
    const res = await cmd.syncSchematicToBoard(this.client, {
      schematic: this.specifier,
      board: board.specifier,
      dryRun: opts.dryRun ?? false,
      matchMode: opts.matchMode === "reference" ? NetlistMatchMode.NMM_REFERENCE : NetlistMatchMode.NMM_UUID,
      deleteExtraFootprints: opts.deleteExtraFootprints ?? false,
      updateFootprints: opts.updateFootprints ?? false,
      updateFields: opts.updateFields,
      removeExtraFields: opts.removeExtraFields ?? false,
      transferGroups: opts.transferGroups ?? false,
      overrideLocks: opts.overrideLocks ?? false,
    });
    const r = res.result;
    return {
      errorCount: r?.errorCount ?? 0,
      warningCount: r?.warningCount ?? 0,
      newFootprintCount: r?.newFootprintCount ?? 0,
      report: r?.report ?? "",
      netlistPath: res.netlistPath,
    };
  }

  // --- settings -----------------------------------------------------------------------------------

  /** `GetSchematicSettings`: the subset of the project's schematic settings the API exposes. */
  async settings(): Promise<SchematicSettings> {
    return cmd.getSchematicSettings(this.client, { schematic: this.specifier });
  }

  /**
   * `SetSchematicSettings`: applies only the fields present in `settings` (every field is
   * optional). They are persisted with the project on the next `save()`. Returns the result.
   */
  async setSettings(settings: MessageInitShape<typeof SchematicSettingsSchema>): Promise<SchematicSettings> {
    return cmd.setSchematicSettings(this.client, {
      schematic: this.specifier,
      settings: create(SchematicSettingsSchema, settings),
    });
  }

  // --- symbol fields table ------------------------------------------------------------------------

  /**
   * `GetSymbolFieldsTable`: one row per symbol placement with its field values, as the fields
   * table shows them. Power symbols are excluded unless `includePowerSymbols`.
   */
  async fieldsTable(opts: { fields?: readonly string[]; includePowerSymbols?: boolean } = {}): Promise<FieldsTableRow[]> {
    const res = await cmd.getSymbolFieldsTable(this.client, {
      schematic: this.specifier,
      fields: [...(opts.fields ?? [])],
      includePowerSymbols: opts.includePowerSymbols ?? false,
    });
    return res.rows.map(toFieldsRow);
  }

  /** `SetSymbolFields`: bulk field edits as one API commit. */
  async setFields(edits: readonly FieldEdit[]): Promise<SetFieldsResult> {
    const res = await cmd.setSymbolFields(this.client, {
      schematic: this.specifier,
      updates: edits.map((e) => ({
        id: { value: e.id },
        sheetPath: e.sheetPath ? toSheetPath(e.sheetPath) : undefined,
        field: e.field,
        value: e.value ?? "",
        remove: e.remove ?? false,
      })),
    });
    return { updatedCount: res.updatedCount, errors: res.errors };
  }

  /**
   * `AssignFootprints`: CvPcb's assignment by reference designator, as one API commit.
   *
   * Accepts a `Map`, a plain object, an array of `[reference, footprint]` pairs, or an array of
   * `{ reference, footprint }` records. Anything else throws instead of assigning nothing.
   */
  async assignFootprints(assignments: FootprintAssignments): Promise<AssignFootprintsResult> {
    const list = isAssignmentRecords(assignments)
      ? assignments.map((a) => ({ reference: a.reference, footprint: a.footprint }))
      : toEntries<LibIdLike>(assignments, "assignFootprints(assignments)").map(([reference, footprint]) => ({ reference, footprint }));
    const res = await cmd.assignFootprints(this.client, {
      schematic: this.specifier,
      assignments: list.map((a) => ({ reference: a.reference, footprint: toLibraryId(a.footprint) as LibraryIdentifier })),
    });
    return { assignedCount: res.assignedCount, unmatchedReferences: res.unmatchedReferences };
  }

  // --- sheets -------------------------------------------------------------------------------------

  /**
   * Adds a hierarchical sheet: `CreateItems(SCH_SHEET_T)` on `parentPath`, which KiCad answers by
   * attaching a screen for `filename` — loading the file when it exists and creating an empty one
   * otherwise (KiCad >= c590f977e0). The sheet symbol is written into the parent by `save()`;
   * whether the *named file* also reaches disk is KiCad's business, so verify with `hierarchy()`
   * or by reading the file if you depend on it.
   */
  async newSheet(opts: NewSheetOptions): Promise<Sheet> {
    const scope: ItemScope | undefined = opts.parentPath ? { sheetPath: toSheetPath(opts.parentPath) } : undefined;
    const sheet = new Sheet(
      create(SheetSymbolSchema, {
        position: toVector2(opts.position ?? { x: 0, y: 0 }),
        size: toVector2(opts.size ?? { x: 25_400_000, y: 25_400_000 }),
        nameField: { text: { text: opts.name } },
        filenameField: { text: { text: opts.filename } },
      }),
    );
    const [created] = await this.createItems([sheet], scope);
    if (!(created instanceof Sheet)) throw new Error(`CreateItems(SCH_SHEET) returned ${created?.typeName ?? "nothing"}`);
    return created;
  }
}

function toFieldsRow(r: SymbolFieldsRow): FieldsTableRow {
  return {
    id: r.id?.value ?? "",
    sheetPath: r.sheetPath,
    sheet: r.sheetPath?.pathHumanReadable ?? "",
    reference: r.reference,
    unit: r.unit,
    fields: { ...r.fields },
    excludedFromBom: r.excludedFromBom,
    excludedFromBoard: r.excludedFromBoard,
    doNotPopulate: r.doNotPopulate,
  };
}

/**
 * One sheet of a schematic. Reads and commits through the handle carry the sheet path; `store`
 * is a per-sheet `ItemStore` (docs/contracts.md: schematic stores are per sheet).
 */
export class SheetHandle {
  private sync: DocumentSync | undefined;

  constructor(
    readonly schematic: Schematic,
    readonly path: SheetPath,
    /** Hierarchy entry when known (name, file name, page number). */
    public instance?: SheetInstance,
  ) {}

  get kind(): DocumentKind {
    return "schematic";
  }

  get scope(): ItemScope {
    return { sheetPath: this.path };
  }

  /** The `DocumentSpecifier` for this sheet (type schematic + sheet path). */
  get specifier() {
    return this.schematic.specifierFor(this.scope);
  }

  get humanPath(): string {
    return this.path.pathHumanReadable || this.instance?.path?.pathHumanReadable || `/${this.path.path.map((k) => k.value).join("/")}`;
  }

  get name(): string {
    return this.instance?.name ?? "";
  }

  get pageNumber(): string {
    return this.instance?.pageNumber ?? "";
  }

  get key(): string {
    return sheetPathKey(this.path);
  }

  get store(): ItemStore {
    this.sync ??= new DocumentSync(this);
    return this.sync.store;
  }

  get documentSync(): DocumentSync {
    this.sync ??= new DocumentSync(this);
    return this.sync;
  }

  getItems(types: KiCadObjectType | readonly KiCadObjectType[]): Promise<Item[]> {
    return this.schematic.getItems(types, this.scope);
  }

  getAllItems(): Promise<Item[]> {
    return this.schematic.getAllItems(this.scope);
  }

  getItemsById(ids: readonly string[]): Promise<Item[]> {
    return this.schematic.getItemsById(ids, this.scope);
  }

  /** What changed on this sheet since `revision` (see `Document.getItemsSince`). */
  getItemsSince(revision: bigint | undefined, types?: readonly KiCadObjectType[]): Promise<ItemsSince> {
    return this.schematic.getItemsSince(revision, types, this.scope);
  }

  itemCounts(): Promise<ItemCounts> {
    return this.schematic.itemCounts(this.scope);
  }

  supportsIncrementalSync(): Promise<boolean> {
    return this.schematic.supportsIncrementalSync();
  }

  getSymbols(): Promise<SchematicSymbol[]> {
    return this.schematic.getSymbols(this.scope);
  }

  beginCommit(opts?: CommitOptions): Promise<Commit> {
    return this.schematic.beginCommit(this.scope, opts);
  }

  commit<T>(message: string, fn: (tx: Commit) => Promise<T> | T, opts?: CommitOptions): Promise<CommitResult<T>> {
    return this.schematic.commit(message, fn, this.scope, opts);
  }

  createItems(items: readonly ItemInput[], opts?: CommitOptions): Promise<Item[]> {
    return this.schematic.createItems(items, this.scope, opts);
  }

  updateItems(items: readonly ItemInput[], opts?: CommitOptions): Promise<Item[]> {
    return this.schematic.updateItems(items, this.scope, opts);
  }

  deleteItems(items: readonly (Item | string)[], opts?: CommitOptions): Promise<DeleteResult[]> {
    return this.schematic.deleteItems(items, this.scope, opts);
  }

  /** Changes on the schematic that target this sheet (or no specific sheet). */
  onChange(cb: (change: DocumentChange) => void): () => void {
    const key = this.key;
    return this.schematic.onChange((c) => {
      const k = sheetPathKey(c.scope.sheetPath);
      if (k === key || k === "") cb(c);
    });
  }

  /** Items in this sheet's store are wrapped from `GetItems` with the sheet path set. */
  wrapAll = wrapAll;

  toString(): string {
    return `SheetHandle(${this.humanPath})`;
  }
}
