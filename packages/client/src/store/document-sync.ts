/**
 * `DocumentSync` fills a `MemoryItemStore` from `GetItems` and keeps it in step with commits made
 * through the document: mutations are applied optimistically when the request is sent, then
 * replaced by KiCad's canonical items when the reply arrives (or rolled back on failure).
 */
import type { DocumentSpecifier } from "@kicad-web/proto";
import type { DocumentChange, DocumentKind } from "../model/document";
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
  onChange(cb: (change: DocumentChange) => void): () => void;
}

/** KIIDs named by a `DocumentChanged` event. */
export interface ChangedIds {
  created?: readonly string[];
  updated?: readonly string[];
  deleted?: readonly string[];
}

export class DocumentSync {
  readonly store: MemoryItemStore;
  private unsubscribe: (() => void) | undefined;
  private loading: Promise<void> | undefined;
  private loaded = false;
  /** Inverse patches of optimistic applies, keyed by commit id + op, so failures roll back. */
  private readonly pending = new Map<string, StorePatch>();

  constructor(readonly source: SyncSource) {
    this.store = new MemoryItemStore(source.kind, source.specifier);
    this.unsubscribe = source.onChange((c) => this.onChange(c));
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Loads (or reloads) every item of the document; emits one diff with what changed. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const items = await this.source.getAllItems();
        this.store.replaceAll(items.filter((i) => i.id).map(toStoredItem));
        this.loaded = true;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  refresh(): Promise<void> {
    return this.load();
  }

  /**
   * Re-reads just the items a `DocumentChanged` event named (another client's commit):
   * created/updated ids are fetched with `GetItemsById` (plus the children the store already
   * holds for them — pads of a moved footprint — since KiCad lists only the top-level item),
   * deleted ids are removed. Ids KiCad no longer returns are dropped too. An id listed as both
   * deleted and created/updated is an update (KiCad records a footprint `UpdateItems` as
   * remove + add of the same KIID). Without ids, or when the source has no `getItemsById`, this
   * is a full `refresh()`.
   */
  async syncIds(ids: ChangedIds): Promise<void> {
    const created = ids.created ?? [];
    const updated = ids.updated ?? [];
    const deleted = ids.deleted ?? [];
    if (!this.loaded || !this.source.getItemsById || created.length + updated.length + deleted.length === 0) return this.refresh();
    const wanted = new Set<string>([...created, ...updated]);
    const gone = deleted.filter((id) => !wanted.has(id));
    for (const it of this.store.all()) if (it.parent && wanted.has(it.parent)) wanted.add(it.id);
    for (const id of gone) wanted.delete(id);
    const items = wanted.size ? await this.source.getItemsById([...wanted]) : [];
    const stored = items.filter((i) => i.id).map(toStoredItem);
    const found = new Set(stored.map((i) => i.id));
    const removed = [...gone, ...[...wanted].filter((id) => !found.has(id) && this.store.has(id))];
    this.store.apply({ updated: stored, removed });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
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
