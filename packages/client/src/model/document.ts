/**
 * `Document` — the base of `Board`, `Schematic` and `FootprintDocument`: everything in
 * `editor_commands.proto` that takes a `DocumentSpecifier` or `ItemHeader` (items, save/revert,
 * page settings, title block, revision, hit test, bounding boxes, text variables) plus the commit
 * pipeline. Concrete documents add their editor-specific commands.
 */
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import {
  BoundingBoxMode,
  DocumentSpecifierSchema,
  DocumentType,
  FrameType,
  HitTestResult,
  ItemHeaderSchema,
  ItemRequestStatus,
  KiCadObjectType,
  PageSettingsSchema,
  RunActionStatus,
  TitleBlockInfoSchema,
  type ActionInfo,
  type DocumentSpecifier,
  type GetItemsResponse,
  type ItemHeader,
  type PageSettings,
  type ProjectSpecifier,
  type SheetPath,
  type TitleBlockInfo,
  type UndoStackEntry,
} from "@fp-pcb/proto";
import type { KiCadClient } from "../client";
import * as cmd from "../commands";
import { ActionError, KiCadApiError, KiCadItemError } from "../errors";
import { box2, toVector2, type Box, type Vec2 } from "../units";
import { Commit, type CommitOptions, type CommitResult, type DeleteResult, type ItemInput } from "./commit";
import { wrapAll, type Item } from "./items";
import type { KiCad } from "./kicad";
import { Variants } from "./variants";

export type DocumentKind = "board" | "schematic" | "footprint" | "symbol";

/** Where an item request is aimed inside a document. */
export interface ItemScope {
  /** KIID of the container: the footprint for pads/fields, the table for cells. Default: the document. */
  container?: string;
  /** Schematic only: the sheet (root first). Omitted = every sheet for reads, current sheet for writes. */
  sheetPath?: SheetPath;
}

/** Emitted by documents after every mutation so stores can follow along. */
export interface DocumentChange {
  kind: "create" | "update" | "delete";
  /** `optimistic` fires before the request with the client's wrappers, `applied` after with KiCad's canonical items. */
  phase: "optimistic" | "applied" | "failed";
  items: Item[];
  /** KIIDs affected (for deletes, the ids KiCad confirmed as deleted). */
  ids: string[];
  scope: ItemScope;
  commitId: string;
}

/** A window into `GetItems` (`GetItems.page`, KiCad >= 11.0). */
export interface ItemPageOptions {
  /** Index of the first item to return. Default 0. */
  offset?: number;
  /** Maximum number of items; 0 / omitted = no limit. */
  limit?: number;
}

export interface ItemsPage {
  items: Item[];
  /** Items that matched before paging. */
  total: number;
  /** Document revision the items were read at (0 on servers that predate it). */
  revision: bigint;
}

/** Result of `Document.getItemsSince`: what changed after a revision. */
export interface ItemsSince {
  /** Items created or changed since the revision — or every matching item when `full`. */
  items: Item[];
  /** KIIDs deleted since the revision (empty when `full`). */
  deletedIds: string[];
  /** The document revision the answer reflects. */
  revision: bigint;
  /**
   * True when `items` is the complete set of matching items rather than a delta: the caller
   * passed no revision, KiCad's change log did not cover the range, or a change could not be
   * attributed to items. Replace, do not merge.
   */
  full: boolean;
}

/** `Undo` / `Redo`: how much was applied and what is left on each stack. */
export interface UndoRedoResult {
  /** Commands actually undone or redone — fewer than asked when the stack ran out. */
  applied: number;
  undoCount: number;
  redoCount: number;
}

/** `GetUndoStack`: both stacks, oldest first (the last entry is what `undo()`/`redo()` takes next). */
export interface UndoStacks {
  undo: UndoStackEntry[];
  redo: UndoStackEntry[];
}

/** `GetItemCounts`: per-type item counts without serialising anything. */
export interface ItemCounts {
  counts: Map<KiCadObjectType, number>;
  /** Sum over every type. */
  total: number;
  revision: bigint;
}

export function sheetPathKey(p: SheetPath | undefined): string {
  return p ? p.path.map((k) => k.value).join("/") : "";
}

export function checkItemRequestStatus(status: ItemRequestStatus, command: string): void {
  if (status !== ItemRequestStatus.IRS_OK && status !== ItemRequestStatus.IRS_UNKNOWN) {
    throw new KiCadItemError(command, [], status);
  }
}

export abstract class Document {
  abstract readonly kind: DocumentKind;
  /** Item types `getAllItems()` asks for. */
  abstract readonly itemTypes: readonly KiCadObjectType[];
  readonly variants: Variants;
  private readonly changeListeners = new Set<(c: DocumentChange) => void>();

  constructor(
    readonly kicad: KiCad,
    readonly specifier: DocumentSpecifier,
  ) {
    this.variants = new Variants(this);
  }

  get client(): KiCadClient {
    return this.kicad.client;
  }

  get documentType(): DocumentType {
    return this.specifier.type;
  }

  get project(): ProjectSpecifier | undefined {
    return this.specifier.project;
  }

  /** Board file name, project name, or `lib:entry` depending on the document. */
  get name(): string {
    const id = this.specifier.identifier;
    if (id.case === "boardFilename") return id.value;
    if (id.case === "libId") return `${id.value.libraryNickname}:${id.value.entryName}`;
    return this.specifier.project?.name ?? "";
  }

  /** The specifier narrowed to a scope (schematic sheet path). */
  specifierFor(scope?: ItemScope): DocumentSpecifier {
    if (!scope?.sheetPath) return this.specifier;
    return create(DocumentSpecifierSchema, {
      type: this.specifier.type,
      project: this.specifier.project,
      identifier: { case: "sheetPath", value: scope.sheetPath },
    });
  }

  /** Builds the `ItemHeader` for item requests; app code never does this by hand. */
  header(scope?: ItemScope): ItemHeader {
    return create(ItemHeaderSchema, {
      document: this.specifierFor(scope),
      container: scope?.container ? { value: scope.container } : undefined,
    });
  }

  // --- items ------------------------------------------------------------------------------------

  private async getItemsResponse(
    types: KiCadObjectType | readonly KiCadObjectType[],
    scope: ItemScope | undefined,
    opts: { page?: ItemPageOptions; sinceRevision?: bigint } = {},
  ): Promise<GetItemsResponse> {
    const list = Array.isArray(types) ? types : [types as KiCadObjectType];
    const res = await cmd.getItems(this.client, {
      header: this.header(scope),
      types: [...list],
      page: opts.page ? { offset: opts.page.offset ?? 0, limit: opts.page.limit ?? 0 } : undefined,
      sinceRevision: opts.sinceRevision,
    });
    checkItemRequestStatus(res.status, "GetItems");
    return res;
  }

  async getItemsRaw(types: KiCadObjectType | readonly KiCadObjectType[], scope?: ItemScope): Promise<Any[]> {
    return (await this.getItemsResponse(types, scope)).items;
  }

  /** `GetItems` for one or more object types, wrapped. */
  async getItems(types: KiCadObjectType | readonly KiCadObjectType[], scope?: ItemScope): Promise<Item[]> {
    return wrapAll(await this.getItemsRaw(types, scope));
  }

  /** Every item type this document kind serves (see `itemTypes`). */
  async getAllItems(scope?: ItemScope): Promise<Item[]> {
    return this.getItems(this.itemTypes, scope);
  }

  /** One window of `GetItems` (`page`), with the total match count and the document revision. */
  async getItemsPage(types: KiCadObjectType | readonly KiCadObjectType[], page: ItemPageOptions, scope?: ItemScope): Promise<ItemsPage> {
    const res = await this.getItemsResponse(types, scope, { page });
    return { items: wrapAll(res.items), total: res.total, revision: res.revision };
  }

  /** `GetItemCounts`: how many items of each type the document (or sheet) holds, and at which revision. */
  async itemCounts(scope?: ItemScope): Promise<ItemCounts> {
    const res = await cmd.getItemCounts(this.client, { document: this.specifierFor(scope) });
    const counts = new Map<KiCadObjectType, number>();
    let total = 0;
    for (const c of res.counts) {
      counts.set(c.type, (counts.get(c.type) ?? 0) + c.count);
      total += c.count;
    }
    return { counts, total, revision: res.revision };
  }

  /**
   * True when the server implements `GetItems.since_revision` / `GetItemCounts` (KiCad >= 11.0),
   * i.e. `getItemsSince()` and `DocumentSync.syncSince()` can re-sync incrementally.
   */
  supportsIncrementalSync(): Promise<boolean> {
    return this.client.supports("GetItemCounts");
  }

  /**
   * Items created or changed after `revision` plus the ids deleted since (`GetItems.since_revision`),
   * for the given types (default: every type of this document kind). A changed footprint yields
   * its pads too. When KiCad cannot answer incrementally — the revision is too old, a change was
   * not attributable to items, or `revision` is `undefined` — the result is the complete item
   * set with `full: true`. Completeness is decided against `GetItemCounts` taken at the same
   * revision, so a `full: false` result is always a safe delta to merge.
   */
  async getItemsSince(
    revision: bigint | undefined,
    types: readonly KiCadObjectType[] = this.itemTypes,
    scope?: ItemScope,
  ): Promise<ItemsSince> {
    const full = async (): Promise<ItemsSince> => {
      const res = await this.getItemsResponse(types, scope);
      return { items: wrapAll(res.items), deletedIds: [], revision: res.revision, full: true };
    };
    if (revision === undefined) return full();
    for (let attempt = 0; attempt < 2; attempt++) {
      const counts = await this.itemCounts(scope);
      const res = await this.getItemsResponse(types, scope, { sinceRevision: revision });
      if (res.revision !== counts.revision) continue; // the document moved between the two reads
      if (res.revision <= revision) return { items: [], deletedIds: [], revision: res.revision, full: false };
      const expected = types.reduce((n, t) => n + (counts.counts.get(t) ?? 0), 0);
      const isFull = res.deletedIds.length === 0 && res.total >= expected;
      return { items: wrapAll(res.items), deletedIds: res.deletedIds.map((k) => k.value), revision: res.revision, full: isFull };
    }
    return full();
  }

  async getItemsById(ids: readonly string[], scope?: ItemScope): Promise<Item[]> {
    if (ids.length === 0) return [];
    const res = await cmd.getItemsById(this.client, { header: this.header(scope), items: ids.map((value) => ({ value })) });
    checkItemRequestStatus(res.status, "GetItemsById");
    return wrapAll(res.items);
  }

  async getItem(id: string, scope?: ItemScope): Promise<Item | undefined> {
    return (await this.getItemsById([id], scope))[0];
  }

  // --- document lifecycle ------------------------------------------------------------------------

  async save(): Promise<void> {
    await cmd.saveDocument(this.client, { document: this.specifier });
  }

  async saveCopy(path: string, opts: { overwrite?: boolean; includeProject?: boolean } = {}): Promise<void> {
    await cmd.saveCopyOfDocument(this.client, {
      document: this.specifier,
      path,
      options: { overwrite: opts.overwrite ?? false, includeProject: opts.includeProject ?? false },
    });
  }

  /** Reload from disk, discarding changes. GUI-only in KiCad today (headless answers AS_UNIMPLEMENTED). */
  async revert(): Promise<void> {
    await cmd.revertDocument(this.client, { document: this.specifier });
  }

  /** The document serialised as KiCad would write it to disk (`SaveDocumentToString`; board and schematic). */
  async saveToString(): Promise<string> {
    const res = await cmd.saveDocumentToString(this.client, { document: this.specifier });
    return res.contents;
  }

  /** Clipboard-style s-expression text for the given items (`SaveItemsToString`; board and schematic sheets). */
  async saveItemsToString(ids: readonly string[], scope?: ItemScope): Promise<string> {
    const res = await cmd.saveItemsToString(this.client, { header: this.header(scope), items: ids.map((value) => ({ value })) });
    return res.contents;
  }

  /**
   * Parses clipboard-style s-expression text (as from `saveItemsToString`) and creates the items
   * in the document, like a paste: KiCad assigns fresh KIIDs, so the returned canonical items
   * carry new ids. Pushes its own commit ("Pasted items via API"); stores following this
   * document see the creation through `onChange`.
   */
  async parseAndCreate(contents: string, scope?: ItemScope): Promise<Item[]> {
    const res = await cmd.parseAndCreateItemsFromString(this.client, { document: this.specifierFor(scope), contents });
    checkItemRequestStatus(res.status, "ParseAndCreateItemsFromString");
    const items = wrapAll(res.createdItems.map((r) => r.item).filter((a): a is Any => !!a));
    if (items.length)
      this.emitChange({ kind: "create", phase: "applied", items, ids: items.map((i) => i.id), scope: scope ?? {}, commitId: "" });
    return items;
  }

  // --- tool actions ------------------------------------------------------------------------------

  /** Tool actions of the editor serving this document (`GetActions`); the names `runAction` accepts. */
  async actions(): Promise<ActionInfo[]> {
    return (await cmd.getActions(this.client, { document: this.specifier })).actions;
  }

  /** The subset of `actions()` that `RunAction` can run without an editor window (`kicad-cli api-server`). */
  async headlessActions(): Promise<ActionInfo[]> {
    return (await this.actions()).filter((a) => a.headlessCapable);
  }

  /**
   * `RunAction` by name (e.g. `pcbnew.ZoneFiller.zoneFillAll`, `pcbnew.GlobalEdit.cleanupTracksAndVias`).
   * Throws `ActionError` unless KiCad answers `RAS_OK`; headless, actions that need a canvas or a
   * dialog answer `RAS_INVALID` like unknown names do.
   */
  async runAction(name: string): Promise<RunActionStatus> {
    const res = await cmd.runAction(this.client, { action: name });
    if (res.status !== RunActionStatus.RAS_OK) throw new ActionError(name, res.status);
    return res.status;
  }

  async pageSettings(): Promise<PageSettings> {
    return cmd.getPageSettings(this.client, { document: this.specifier });
  }

  async setPageSettings(pageSettings: MessageInitShape<typeof PageSettingsSchema>): Promise<PageSettings> {
    return cmd.setPageSettings(this.client, { document: this.specifier, pageSettings: create(PageSettingsSchema, pageSettings) });
  }

  async titleBlock(): Promise<TitleBlockInfo> {
    return cmd.getTitleBlockInfo(this.client, { document: this.specifier });
  }

  async setTitleBlock(titleBlock: MessageInitShape<typeof TitleBlockInfoSchema>): Promise<void> {
    await cmd.setTitleBlockInfo(this.client, { document: this.specifier, titleBlock: create(TitleBlockInfoSchema, titleBlock) });
  }

  /**
   * Monotonic revision bumped by KiCad on every pushed commit (`GetDocumentRevision`); `undefined`
   * when the server predates the command. Cheap to poll.
   */
  async revision(): Promise<bigint | undefined> {
    try {
      const res = await cmd.getDocumentRevision(this.client, { document: this.specifier });
      return res.revision;
    } catch (e) {
      if (KiCadApiError.is(e) && e.isUnsupported) return undefined;
      throw e;
    }
  }

  // --- undo / redo (KiCad >= 11.0) ------------------------------------------------------------------

  /**
   * `Undo`: undoes the most recent commands of the document — API commits, API commands that edit
   * outside a commit (`SetBoardOrigin`, a zone refill, ...), and in the GUI the user's own edits.
   * KiCad refuses it while any client has an open commit. Returns how many were applied.
   */
  async undo(count = 1): Promise<UndoRedoResult> {
    const res = await cmd.undo(this.client, { document: this.specifier, count });
    return { applied: res.applied, undoCount: res.undoCount, redoCount: res.redoCount };
  }

  /** `Redo`: replays commands undone by `undo()`. */
  async redo(count = 1): Promise<UndoRedoResult> {
    const res = await cmd.redo(this.client, { document: this.specifier, count });
    return { applied: res.applied, undoCount: res.undoCount, redoCount: res.redoCount };
  }

  /** `GetUndoStack`: the undo and redo stacks with their descriptions, client names and commit ids. */
  async undoStack(): Promise<UndoStacks> {
    const res = await cmd.getUndoStack(this.client, { document: this.specifier });
    return { undo: res.undo, redo: res.redo };
  }

  /**
   * True when the server implements `Undo`/`Redo`/`GetUndoStack` (KiCad >= 11.0). `Commit.undo()`
   * and `store/undo.ts`'s `DocumentUndo` use this to prefer KiCad's own undo over replaying
   * client-side inverse patches.
   */
  supportsServerUndo(): Promise<boolean> {
    return this.client.supports("Undo");
  }

  async hitTest(id: string, position: Vec2, toleranceNm = 0, scope?: ItemScope): Promise<boolean> {
    const res = await cmd.hitTest(this.client, {
      header: this.header(scope),
      id: { value: id },
      position: toVector2(position),
      tolerance: Math.round(toleranceNm),
    });
    return res.result === HitTestResult.HTR_HIT;
  }

  /** Bounding boxes (nm) keyed by KIID. KiCad implements this for boards only today. */
  async boundingBoxes(
    ids: readonly string[],
    mode: BoundingBoxMode = BoundingBoxMode.BBM_ITEM_ONLY,
    scope?: ItemScope,
  ): Promise<Map<string, Box>> {
    if (ids.length === 0) return new Map();
    const res = await cmd.getBoundingBox(this.client, { header: this.header(scope), items: ids.map((value) => ({ value })), mode });
    const out = new Map<string, Box>();
    res.items.forEach((k, i) => out.set(k.value, box2(res.boxes[i])));
    return out;
  }

  async boundingBox(id: string, mode?: BoundingBoxMode, scope?: ItemScope): Promise<Box | undefined> {
    return (await this.boundingBoxes([id], mode, scope)).get(id);
  }

  /** Expands `${VAR}` text variables in the document's context. */
  async expandTextVariables(text: readonly string[], expandEnvVars = false): Promise<string[]> {
    const res = await cmd.expandTextVariables(this.client, { document: this.specifier, text: [...text], expandEnvVars });
    return res.text;
  }

  /** Asks the editor frame to redraw (a no-op headless). */
  async refreshEditor(): Promise<void> {
    await cmd.refreshEditor(this.client, { frame: this.frameType });
  }

  get frameType(): FrameType {
    switch (this.specifier.type) {
      case DocumentType.DOCTYPE_PCB:
        return FrameType.FT_PCB_EDITOR;
      case DocumentType.DOCTYPE_SCHEMATIC:
        return FrameType.FT_SCHEMATIC_EDITOR;
      case DocumentType.DOCTYPE_FOOTPRINT:
        return FrameType.FT_FOOTPRINT_EDITOR;
      case DocumentType.DOCTYPE_SYMBOL:
        return FrameType.FT_SYMBOL_EDITOR;
      default:
        return FrameType.FT_UNKNOWN;
    }
  }

  async close(): Promise<void> {
    await cmd.closeDocument(this.client, { document: this.specifier });
  }

  // --- commits ------------------------------------------------------------------------------------

  /** `BeginCommit`; call `push()` or `drop()` on the result. Prefer `commit()`. */
  async beginCommit(scope?: ItemScope, opts?: CommitOptions): Promise<Commit> {
    const res = await cmd.beginCommit(this.client, { header: this.header(scope) });
    return new Commit(this, res.id?.value ?? "", scope ?? {}, opts);
  }

  /**
   * Runs `fn` inside a KiCad commit: `BeginCommit`, the create/update/delete calls issued through
   * `tx`, then `EndCommit(CMA_COMMIT, message)` — or `CMA_DROP` if `fn` throws (the error is
   * re-thrown wrapped in `CommitDroppedError`). Returns `fn`'s value plus the canonical items.
   */
  async commit<T>(message: string, fn: (tx: Commit) => Promise<T> | T, scope?: ItemScope, opts?: CommitOptions): Promise<CommitResult<T>> {
    const tx = await this.beginCommit(scope, opts);
    return tx.run(message, fn);
  }

  /** One-shot create outside an explicit commit (KiCad pushes "Created items via API"). */
  async createItems(items: readonly ItemInput[], scope?: ItemScope, opts?: CommitOptions): Promise<Item[]> {
    return new Commit(this, "", scope ?? {}, opts).create(items);
  }

  async updateItems(items: readonly ItemInput[], scope?: ItemScope, opts?: CommitOptions): Promise<Item[]> {
    return new Commit(this, "", scope ?? {}, opts).update(items);
  }

  async deleteItems(items: readonly (Item | string)[], scope?: ItemScope, opts?: CommitOptions): Promise<DeleteResult[]> {
    return new Commit(this, "", scope ?? {}, opts).delete(items);
  }

  /** Subscribe to mutations made through this document (used by `DocumentSync`). */
  onChange(cb: (change: DocumentChange) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** @internal */
  emitChange(change: DocumentChange): void {
    for (const cb of this.changeListeners) cb(change);
  }

  toString(): string {
    return `${this.constructor.name}(${this.name})`;
  }
}
