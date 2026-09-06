/**
 * `DocumentSync` fills a `MemoryItemStore` from `GetItems` and keeps it in step with commits made
 * through the document: mutations are applied optimistically when the request is sent, then
 * replaced by KiCad's canonical items when the reply arrives (or rolled back on failure).
 * Re-syncs after changes made elsewhere prefer `GetItems.since_revision` (KiCad >= 11.0) over a
 * full reload when the server supports it; `syncIds()` re-reads the items an event named.
 */
import type { DocumentSpecifier } from "@kicad-web/proto";
import type { DocumentChange, DocumentKind, ItemsSince } from "../model/document";
import type { Item } from "../model/items/base";
import { MemoryItemStore, toStoredItem, type StorePatch } from "./item-store";
import { inversePatch } from "./undo";

/** What `DocumentSync` needs from a document or sheet handle. */
export interface SyncSource {
  readonly kind: DocumentKind;
  readonly specifier: DocumentSpecifier;
  getAllItems(): Promise<Item[]>;
  /** `GetItemsById`; needed for `syncIds()`, which otherwise falls back to a full reload. */
  getItemsById?(ids: readonly string[]): Promise<Item[]>;
  /**
   * `GetItems.since_revision` for every item type of the document (`Document.getItemsSince`);
   * with `undefined` a full read that also reports the revision. Needed for `syncSince()`.
   */
  getItemsSince?(revision: bigint | undefined): Promise<ItemsSince>;
  /** Whether the server implements `since_revision` (capability check); default false. */
  supportsIncrementalSync?(): Promise<boolean>;
  onChange(cb: (change: DocumentChange) => void): () => void;
}

/** KIIDs named by a `DocumentChanged` event. */
export interface ChangedIds {
  created?: readonly string[];
  updated?: readonly string[];
  deleted?: readonly string[];
  /** `DocumentChanged.revision`: the document revision after the change, when known. */
  revision?: bigint;
}

export class DocumentSync {
  readonly store: MemoryItemStore;
  private unsubscribe: (() => void) | undefined;
  private loading: Promise<void> | undefined;
  private loaded = false;
  private rev: bigint | undefined;
  private incremental: Promise<boolean> | undefined;
  /** Inverse patches of optimistic applies, keyed by commit id + op, so failures roll back. */
  private readonly pending = new Map<string, StorePatch>();

  constructor(readonly source: SyncSource) {
    this.store = new MemoryItemStore(source.kind, source.specifier);
    this.unsubscribe = source.onChange((c) => this.onChange(c));
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * The KiCad document revision the store reflects (from the last `GetItems` answer or event),
   * or `undefined` before the first load / on servers that do not report revisions.
   */
  get revision(): bigint | undefined {
    return this.rev;
  }

  /** True when re-syncs can use `since_revision` (server capability + source support). Cached. */
  supportsIncrementalSync(): Promise<boolean> {
    this.incremental ??=
      this.source.getItemsSince && this.source.supportsIncrementalSync
        ? this.source.supportsIncrementalSync().catch(() => false)
        : Promise.resolve(false);
    return this.incremental;
  }

  /** Loads (or fully reloads) every item of the document; emits one diff with what changed. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        if (this.source.getItemsSince) {
          const r = await this.source.getItemsSince(undefined);
          this.store.replaceAll(r.items.filter((i) => i.id).map(toStoredItem));
          this.setRevision(r.revision);
        } else {
          const items = await this.source.getAllItems();
          this.store.replaceAll(items.filter((i) => i.id).map(toStoredItem));
        }
        this.loaded = true;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /**
   * Brings the store up to date: an incremental `syncSince()` when the server supports
   * `since_revision` and a revision is known, else a full `load()`.
   */
  async refresh(): Promise<void> {
    if (this.loaded && this.rev !== undefined && (await this.supportsIncrementalSync())) return this.syncSince(this.rev);
    return this.load();
  }

  /**
   * Re-syncs from `revision` (default: the store's own) through `GetItems.since_revision`:
   * changed items are upserted, deleted ids removed, and a `full` answer (KiCad could not
   * attribute the changes, or the revision is too old) replaces the content. One diff is
   * emitted. Falls back to `load()` before the first load or when the source cannot do it.
   */
  async syncSince(revision: bigint | undefined = this.rev): Promise<void> {
    if (this.loading) return this.loading;
    if (!this.loaded || revision === undefined || !this.source.getItemsSince) return this.load();
    const r = await this.source.getItemsSince(revision);
    const stored = r.items.filter((i) => i.id).map(toStoredItem);
    if (r.full) this.store.replaceAll(stored);
    else this.store.apply({ updated: stored, removed: r.deletedIds });
    this.setRevision(r.revision);
  }

  /**
   * Re-reads just the items a `DocumentChanged` event named (another client's commit):
   * created/updated ids are fetched with `GetItemsById` (plus the children the store already
   * holds for them — pads of a moved footprint — since KiCad lists only the top-level item),
   * deleted ids are removed. Ids KiCad no longer returns are dropped too. An id listed as both
   * deleted and created/updated is an update (KiCad records a footprint `UpdateItems` as
   * remove + add of the same KIID). Without ids, or when the source has no `getItemsById`, this
   * is a `refresh()` (incremental when the server supports it).
   */
  async syncIds(ids: ChangedIds): Promise<void> {
    const created = ids.created ?? [];
    const updated = ids.updated ?? [];
    const deleted = ids.deleted ?? [];
    if (!this.loaded || !this.source.getItemsById || created.length + updated.length + deleted.length === 0) {
      await this.refresh();
      this.setRevision(ids.revision);
      return;
    }
    const wanted = new Set<string>([...created, ...updated]);
    const gone = deleted.filter((id) => !wanted.has(id));
    for (const it of this.store.all()) if (it.parent && wanted.has(it.parent)) wanted.add(it.id);
    for (const id of gone) wanted.delete(id);
    const items = wanted.size ? await this.source.getItemsById([...wanted]) : [];
    const stored = items.filter((i) => i.id).map(toStoredItem);
    const found = new Set(stored.map((i) => i.id));
    const removed = [...gone, ...[...wanted].filter((id) => !found.has(id) && this.store.has(id))];
    this.store.apply({ updated: stored, removed });
    this.setRevision(ids.revision);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Revisions only move forward; `undefined` / 0 (server predates revisions) leave it alone. */
  private setRevision(revision: bigint | undefined): void {
    if (revision === undefined || revision === 0n) return;
    if (this.rev === undefined || revision > this.rev) this.rev = revision;
  }

  private key(c: DocumentChange): string {
    return `${c.commitId}|${c.kind}|${c.ids.join(",")}`;
  }

  private onChange(c: DocumentChange): void {
    if (!this.loaded) return;
    const patch = this.toPatch(c);
    switch (c.phase) {
      case "optimistic": {
        this.pending.set(this.key(c), inversePatch(this.store, patch));
        this.store.apply(patch);
        break;
      }
      case "applied": {
        this.pending.delete(this.key(c));
        this.store.apply(patch);
        break;
      }
      case "failed": {
        const inverse = this.pending.get(this.key(c));
        this.pending.delete(this.key(c));
        if (inverse) this.store.apply(inverse);
        break;
      }
    }
  }

  private toPatch(c: DocumentChange): StorePatch {
    const stored = c.items.filter((i) => i.id).map(toStoredItem);
    switch (c.kind) {
      case "create":
        return { added: stored };
      case "update":
        return { updated: stored };
      case "delete":
        return { removed: c.ids };
    }
  }
}
