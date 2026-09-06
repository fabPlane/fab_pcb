import type { DocumentKind, ItemStore, StoredItem, StoreDiff } from '@/contracts';

/**
 * In-memory ItemStore with indexes by type, layer and net.
 *
 * `insert/replace/remove/batch` are NOT part of the ItemStore contract: only the
 * commit backend (services/CommandService.ts) calls them. When `@kicad-web/client/store`
 * arrives, its store will be fed by `UpdateItemsResponse` instead and this class is only
 * kept for tests and the mock.
 */
export class MemoryItemStore implements ItemStore {
  readonly kind: DocumentKind;
  readonly document: unknown;
  readonly key: string;
  private items = new Map<string, StoredItem>();
  private typeIndex = new Map<string, Set<string>>();
  private layerIndex = new Map<string, Set<string>>();
  private netIndex = new Map<string, Set<string>>();
  private subs = new Set<(diff: StoreDiff) => void>();
  private rev = 0;
  private pending: StoreDiff | null = null;

  constructor(kind: DocumentKind, document: unknown, key: string) {
    this.kind = kind;
    this.document = document;
    this.key = key;
  }

  get revision(): number {
    return this.rev;
  }

  get size(): number {
    return this.items.size;
  }

  get(id: string): StoredItem | undefined {
    return this.items.get(id);
  }

  all(): Iterable<StoredItem> {
    return this.items.values();
  }

  *byType(type: string): Iterable<StoredItem> {
    for (const id of this.typeIndex.get(type) ?? []) yield this.items.get(id)!;
  }

  *byLayer(layer: string): Iterable<StoredItem> {
    for (const id of this.layerIndex.get(layer) ?? []) yield this.items.get(id)!;
  }

  *byNet(net: string): Iterable<StoredItem> {
    for (const id of this.netIndex.get(net) ?? []) yield this.items.get(id)!;
  }

  /** Children of a footprint/sheet/group. */
  *children(parent: string): Iterable<StoredItem> {
    for (const it of this.items.values()) if (it.parent === parent) yield it;
  }

  subscribe(cb: (diff: StoreDiff) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  // --- mutation (backend only) ------------------------------------------------------

  insert(item: StoredItem): void {
    this.batch(() => this.doInsert(item));
  }

  replace(item: StoredItem): void {
    this.batch(() => this.doReplace(item));
  }

  remove(id: string): StoredItem | undefined {
    let removed: StoredItem | undefined;
    this.batch(() => {
      removed = this.doRemove(id);
    });
    return removed;
  }

  /** Groups several mutations into one diff/revision. Nested batches flatten. */
  batch(fn: () => void): void {
    if (this.pending) {
      fn();
      return;
    }
    this.pending = { added: [], updated: [], removed: [], revision: this.rev + 1 };
    try {
      fn();
    } finally {
      const diff = this.pending;
      this.pending = null;
      if (diff.added.length || diff.updated.length || diff.removed.length) {
        this.rev = diff.revision;
        for (const cb of this.subs) cb(diff);
      }
    }
  }

  private doInsert(item: StoredItem): void {
    if (this.items.has(item.id)) {
      this.doReplace(item);
      return;
    }
    this.items.set(item.id, item);
    this.index(item);
    this.pending!.added.push(item);
  }

  private doReplace(item: StoredItem): void {
    const prev = this.items.get(item.id);
    if (!prev) {
      this.doInsert(item);
      return;
    }
    this.unindex(prev);
    this.items.set(item.id, item);
    this.index(item);
    this.pending!.updated.push(item);
  }

  private doRemove(id: string): StoredItem | undefined {
    const prev = this.items.get(id);
    if (!prev) return undefined;
    this.unindex(prev);
    this.items.delete(id);
    this.pending!.removed.push(id);
    return prev;
  }

  private index(item: StoredItem): void {
    add(this.typeIndex, item.type, item.id);
    if (item.layer) add(this.layerIndex, item.layer, item.id);
    if (item.net) add(this.netIndex, item.net, item.id);
  }

  private unindex(item: StoredItem): void {
    del(this.typeIndex, item.type, item.id);
    if (item.layer) del(this.layerIndex, item.layer, item.id);
    if (item.net) del(this.netIndex, item.net, item.id);
  }
}

function add(map: Map<string, Set<string>>, key: string, id: string): void {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(id);
}

function del(map: Map<string, Set<string>>, key: string, id: string): void {
  const s = map.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) map.delete(key);
}
