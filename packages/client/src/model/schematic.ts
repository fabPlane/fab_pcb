/**
 * `Schematic` — a schematic document, and `SheetHandle` — a view of one sheet of its hierarchy.
 * Schematic items are addressed per sheet: `ItemHeader.document.sheet_path` selects the sheet for
 * reads and commits, so `schematic.sheet(path)` returns a handle whose calls set it for you.
 */
import { create } from "@bufbuild/protobuf";
import {
  KIIDSchema,
  KiCadObjectType,
  SheetPathSchema,
  type SchematicNet,
  type SheetInstance,
  type SheetPath,
} from "@kicad-web/proto";
import * as cmd from "../commands";
import { DocumentSync } from "../store/document-sync";
import type { ItemStore } from "../store/item-store";
import type { Commit, CommitOptions, CommitResult, DeleteResult, ItemInput } from "./commit";
import { Document, sheetPathKey, type DocumentChange, type DocumentKind, type ItemScope } from "./document";
import { SCHEMATIC_ITEM_TYPES, SchematicLine, SchematicSymbol, Sheet, wrapAll, type Item } from "./items";
import { SchematicJobs } from "./jobs";

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

export class Schematic extends Document {
  readonly kind: DocumentKind = "schematic";
  readonly itemTypes = SCHEMATIC_ITEM_TYPES;
  readonly jobs = new SchematicJobs(this);
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
    return (await this.getItems(KiCadObjectType.KOT_SCH_LINE, scope)).filter((i): i is SchematicLine => i instanceof SchematicLine && i.isWire);
  }

  async getSheetSymbols(scope?: ItemScope): Promise<Sheet[]> {
    return (await this.getItems(KiCadObjectType.KOT_SCH_SHEET, scope)).filter((i): i is Sheet => i instanceof Sheet);
  }
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
