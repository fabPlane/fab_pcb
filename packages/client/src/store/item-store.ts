/**
 * Layer 4 — `ItemStore`: the normalised, indexed item store consumers (renderers, app shell)
 * subscribe to. The interface is the contract in docs/contracts.md; `MemoryItemStore` is the
 * implementation `DocumentSync` fills and mutates. Consumers never mutate a store directly.
 */
import type { DocumentSpecifier } from "@kicad-web/proto";
import type { DocumentKind } from "../model/document";
import type { Item } from "../model/items/base";

export type { DocumentKind };

export interface StoredItem {
  /** KIID */
  id: string;
  /** kiapi KiCadObjectType enum name, e.g. 'KOT_PCB_FOOTPRINT' */
  type: string;
  /** primary layer id, e.g. 'BL_F_Cu' (board) — undefined for schematic */
  layer?: string;
  /** net name, when applicable */
  net?: string;
  /** KIID of the containing footprint/group/sheet, if any */
  parent?: string;
  /** the decoded protobuf message (protobuf-es Message) */
  proto: unknown;
  /** nm, filled lazily by consumers */
  bbox?: { x: number; y: number; w: number; h: number };
  /** The wrapper the proto came from (convenience for app code; not part of the contract). */
  item?: Item;
}

export interface StoreDiff {
  added: StoredItem[];
  /** same id, new proto */
  updated: StoredItem[];
  /** KIIDs */
  removed: string[];
  /** monotonic, per document */
  revision: number;
}

export interface ItemStore {
  readonly kind: DocumentKind;
  /** kiapi DocumentSpecifier */
  readonly document: unknown;
  readonly revision: number;
  get(id: string): StoredItem | undefined;
  all(): Iterable<StoredItem>;
  byType(type: string): Iterable<StoredItem>;
  byLayer(layer: string): Iterable<StoredItem>;
  byNet(net: string): Iterable<StoredItem>;
  subscribe(cb: (diff: StoreDiff) => void): () => void;
}

/** A mutation request; `apply()` turns it into a real `StoreDiff`. */
export interface StorePatch {
  added?: readonly StoredItem[];
  updated?: readonly StoredItem[];
  removed?: readonly string[];
}

/** Converts a wrapper into the contract's `StoredItem`. */
export function toStoredItem(item: Item): StoredItem {
  return {
    id: item.id,
    type: item.typeName,
    layer: item.layer,
    net: item.net,
    parent: item.parent,
    proto: item.proto,
    item,
  };
}

function* filterIds(store: MemoryItemStore, ids: Iterable<string> | undefined): Iterable<StoredItem> {
  if (!ids) return;
  for (const id of ids) {
    const it = store.get(id);
    if (it) yield it;
  }
}

export class MemoryItemStore implements ItemStore {
  private readonly items = new Map<string, StoredItem>();
  private readonly typeIdx = new Map<string, Set<string>>();
  private readonly layerIdx = new Map<string, Set<string>>();
  private readonly netIdx = new Map<string, Set<string>>();
  private readonly listeners = new Set<(diff: StoreDiff) => void>();
  private rev = 0;

  constructor(
    readonly kind: DocumentKind,
    readonly document: DocumentSpecifier,
  ) {}

  get revision(): number {
    return this.rev;
  }

  get size(): number {
    return this.items.size;
  }

  get(id: string): StoredItem | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  all(): Iterable<StoredItem> {
    return this.items.values();
  }

  byType(type: string): Iterable<StoredItem> {
    return filterIds(this, this.typeIdx.get(type));
  }

  byLayer(layer: string): Iterable<StoredItem> {
    return filterIds(this, this.layerIdx.get(layer));
  }

  byNet(net: string): Iterable<StoredItem> {
    return filterIds(this, this.netIdx.get(net));
  }

  /** Distinct values present in each index (for layer/net pickers). */
  types(): string[] {
    return [...this.typeIdx.keys()];
  }
  layers(): string[] {
    return [...this.layerIdx.keys()];
  }
  nets(): string[] {
    return [...this.netIdx.keys()];
  }

  subscribe(cb: (diff: StoreDiff) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Applies a patch. `added` entries whose id already exists are treated as updates and `removed`
   * ids that are absent are dropped, so the emitted diff describes what really changed. Returns
   * the diff (also delivered to subscribers); a no-op patch returns `undefined` and bumps nothing.
   */
  apply(patch: StorePatch): StoreDiff | undefined {
    const added: StoredItem[] = [];
    const updated: StoredItem[] = [];
    const removed: string[] = [];
    for (const it of patch.added ?? []) {
      if (this.items.has(it.id)) updated.push(it);
      else added.push(it);
    }
    for (const it of patch.updated ?? []) {
      if (this.items.has(it.id)) updated.push(it);
      else added.push(it);
    }
    for (const id of patch.removed ?? []) if (this.items.has(id)) removed.push(id);
    if (!added.length && !updated.length && !removed.length) return undefined;
    for (const id of removed) this.unindex(this.items.get(id)!);
    for (const id of removed) this.items.delete(id);
    for (const it of [...added, ...updated]) {
      const prev = this.items.get(it.id);
      if (prev) this.unindex(prev);
      this.items.set(it.id, it);
      this.index(it);
    }
    const diff: StoreDiff = { added, updated, removed, revision: ++this.rev };
    for (const cb of this.listeners) cb(diff);
    return diff;
  }

  /** Replaces the whole content, emitting one diff of what changed (initial load / refresh). */
  replaceAll(items: Iterable<StoredItem>): StoreDiff | undefined {
    const next = new Map<string, StoredItem>();
    for (const it of items) next.set(it.id, it);
    const removed = [...this.items.keys()].filter((id) => !next.has(id));
    const added: StoredItem[] = [];
    const updated: StoredItem[] = [];
    for (const it of next.values()) {
      const prev = this.items.get(it.id);
      if (!prev) added.push(it);
      else if (prev.proto !== it.proto) updated.push(it);
    }
    return this.apply({ added, updated, removed });
  }

  /** Convenience for wrappers. */
  applyItems(patch: { added?: readonly Item[]; updated?: readonly Item[]; removed?: readonly string[] }): StoreDiff | undefined {
    return this.apply({
      added: patch.added?.map(toStoredItem),
      updated: patch.updated?.map(toStoredItem),
      removed: patch.removed,
    });
  }

  clear(): StoreDiff | undefined {
    return this.apply({ removed: [...this.items.keys()] });
  }

  private index(it: StoredItem): void {
    add(this.typeIdx, it.type, it.id);
    if (it.layer) add(this.layerIdx, it.layer, it.id);
    if (it.net) add(this.netIdx, it.net, it.id);
  }

  private unindex(it: StoredItem): void {
    del(this.typeIdx, it.type, it.id);
    if (it.layer) del(this.layerIdx, it.layer, it.id);
    if (it.net) del(this.netIdx, it.net, it.id);
  }
}

function add(idx: Map<string, Set<string>>, key: string, id: string): void {
  let s = idx.get(key);
  if (!s) idx.set(key, (s = new Set()));
  s.add(id);
}

function del(idx: Map<string, Set<string>>, key: string, id: string): void {
  const s = idx.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) idx.delete(key);
}
