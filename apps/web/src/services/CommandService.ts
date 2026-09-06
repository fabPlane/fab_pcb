// Client-side transactions and undo/redo (docs/01-architecture.md, "Document model").
//
// A Transaction patches the store optimistically and records, per item, the first
// pre-state and the last post-state. On commit the pair becomes a HistoryEntry whose
// `inverse` ops are replayed as a *new* transaction on undo, and whose `forward` ops are
// replayed on redo. Nothing here knows about the wire protocol: the `CommitBackend`
// abstracts BeginCommit / Create|Update|DeleteItems / EndCommit.
//
// `services/kicad/KicadCommitBackend` implements `CommitBackend` over `@kicad-web/client`
// (BeginCommit / UpdateItems / EndCommit); the store in that world is the client's own
// `MemoryItemStore` (mutated through `apply()`), while `MockCommitBackend` writes straight
// into the app's `MemoryItemStore`. `mutatorFor()` hides the difference.

import { BoardLayer } from '@kicad-web/proto';
import type { ItemStore, StoredItem } from '@/contracts';
import { applyPatches, structuredCloneSafe, type Patch } from '@/lib/patch';
import { refreshBbox } from '@/lib/geometry';
import { MemoryItemStore } from './MemoryItemStore';
import type { CommandService, HistoryEntry, ItemOp, Transaction } from './types';

/** The mutation surface a transaction needs; neither store exposes it through the contract. */
export interface StoreMutator {
  insert(item: StoredItem): void;
  replace(item: StoredItem): void;
  remove(id: string): void;
  batch(fn: () => void): void;
}

interface ClientStoreLike {
  apply(patch: { added?: readonly StoredItem[]; updated?: readonly StoredItem[]; removed?: readonly string[] }): unknown;
}

const isClientStore = (s: unknown): s is ClientStoreLike => typeof (s as ClientStoreLike).apply === 'function';

/** Adapts the app's MemoryItemStore or the client's MemoryItemStore (`apply()`) to `StoreMutator`. */
export function mutatorFor(store: ItemStore): StoreMutator {
  if (store instanceof MemoryItemStore) return store;
  if (isClientStore(store)) {
    let pending: { added: StoredItem[]; updated: StoredItem[]; removed: string[] } | null = null;
    const flush = (p: NonNullable<typeof pending>) => {
      if (p.added.length || p.updated.length || p.removed.length) store.apply(p);
    };
    const one = (fn: (p: NonNullable<typeof pending>) => void) => {
      if (pending) fn(pending);
      else {
        const p = { added: [], updated: [], removed: [] };
        fn(p);
        flush(p);
      }
    };
    return {
      insert: (item) => one((p) => p.added.push(item)),
      replace: (item) => one((p) => p.updated.push(item)),
      remove: (id) => one((p) => p.removed.push(id)),
      batch: (fn) => {
        if (pending) {
          fn();
          return;
        }
        pending = { added: [], updated: [], removed: [] };
        try {
          fn();
        } finally {
          const p = pending;
          pending = null;
          flush(p);
        }
      },
    };
  }
  throw new Error('This CommandService only drives MemoryItemStore-shaped stores');
}

export interface CommitBackend {
  begin(store: ItemStore, message: string): Promise<void> | void;
  /** Applies ops to the authoritative document; returns canonical post-states for creates/updates. */
  apply(store: ItemStore, ops: ItemOp[]): Promise<ItemOp[]> | ItemOp[];
  end(store: ItemStore, action: 'commit' | 'drop'): Promise<void> | void;
}

/** Writes ops straight into a MemoryItemStore (there is no server). */
export class MockCommitBackend implements CommitBackend {
  begin(): void {}
  apply(store: ItemStore, ops: ItemOp[]): ItemOp[] {
    const mem = mutatorFor(store);
    mem.batch(() => {
      for (const op of ops) {
        if (op.kind === 'delete') mem.remove(op.item.id);
        else mem.replace(op.item);
      }
    });
    return ops;
  }
  end(): void {}
}

/**
 * Stable key of a store, matching `storeKeyFor()` in state/active.ts: `board`,
 * `schematic:/<kiid>/<kiid>` (sheet path), `footprint:<lib:name>`.
 */
export function storeKeyOf(store: ItemStore): string {
  if (store instanceof MemoryItemStore) return store.key;
  const doc = store.document as
    | { identifier?: { case?: string; value?: unknown }; boardFilename?: string; sheetPath?: { pathHumanReadable?: string } }
    | undefined;
  if (store.kind === 'board') return 'board';
  const ident = doc?.identifier;
  if (ident?.case === 'sheetPath') {
    const sp = ident.value as { path?: { value: string }[] };
    return `schematic:/${(sp.path ?? []).map((k) => k.value).join('/')}`;
  }
  if (ident?.case === 'libId') {
    const lib = ident.value as { libraryNickname?: string; entryName?: string };
    return `${store.kind}:${lib.libraryNickname ?? ''}:${lib.entryName ?? ''}`;
  }
  return `${store.kind}:${doc?.boardFilename ?? doc?.sheetPath?.pathHumanReadable ?? 'default'}`;
}

/** Layer/net live on the proto; keep StoredItem's denormalised copies in sync. */
export function deriveMeta(item: StoredItem): StoredItem {
  const p = item.proto as { layer?: unknown; net?: { name?: string } } | null;
  const next: StoredItem = { ...item };
  if (p && typeof p.layer === 'string') next.layer = p.layer;
  else if (p && typeof p.layer === 'number') next.layer = BoardLayer[p.layer] ?? next.layer;
  if (p && p.net && typeof p.net.name === 'string') next.net = p.net.name || undefined;
  return next;
}

interface Pending {
  first: StoredItem | null; // pre-state, null when created in this tx
  last: StoredItem | null; // post-state, null when deleted in this tx
}

let nextTxId = 1;
let nextEntryId = 1;

class TransactionImpl implements Transaction {
  readonly id = nextTxId++;
  private pending = new Map<string, Pending>();
  private order: string[] = [];
  private open = true;

  constructor(
    readonly store: ItemStore,
    readonly message: string,
    private readonly service: CommandServiceImpl,
    private readonly backend: CommitBackend,
  ) {}

  private touch(id: string, first: StoredItem | null): Pending {
    let p = this.pending.get(id);
    if (!p) {
      // The client's `item` wrapper is a convenience, not state: structuredClone would keep a
      // prototype-less copy of it, so snapshots drop it.
      p = { first: first ? structuredCloneSafe({ ...first, item: undefined }) : null, last: null };
      this.pending.set(id, p);
      this.order.push(id);
    }
    return p;
  }

  private assertOpen(): void {
    if (!this.open) throw new Error(`Transaction #${this.id} "${this.message}" is already closed`);
  }

  update(id: string, patches: Patch[]): void {
    this.assertOpen();
    const prev = this.store.get(id);
    if (!prev) throw new Error(`update: no item ${id} in store`);
    const next = refreshBbox(prev, deriveMeta({ ...prev, proto: applyPatches(prev.proto, patches) }));
    this.touch(id, prev).last = next;
    mutatorFor(this.store).replace(next);
  }

  replace(id: string, proto: unknown, meta: Partial<Pick<StoredItem, 'layer' | 'net' | 'bbox'>> = {}): void {
    this.assertOpen();
    const prev = this.store.get(id);
    if (!prev) throw new Error(`replace: no item ${id} in store`);
    const next = deriveMeta({ ...prev, ...meta, proto });
    this.touch(id, prev).last = next;
    mutatorFor(this.store).replace(next);
  }

  create(item: StoredItem): void {
    this.assertOpen();
    const existing = this.store.get(item.id);
    const p = this.touch(item.id, existing ?? null);
    p.last = deriveMeta(item);
    mutatorFor(this.store).insert(p.last);
  }

  delete(id: string): void {
    this.assertOpen();
    const prev = this.store.get(id);
    if (!prev) return;
    const p = this.touch(id, prev);
    p.last = null;
    mutatorFor(this.store).remove(id);
  }

  private buildOps(): { forward: ItemOp[]; inverse: ItemOp[] } {
    const forward: ItemOp[] = [];
    const inverse: ItemOp[] = [];
    for (const id of this.order) {
      const p = this.pending.get(id)!;
      if (p.first === null && p.last === null) continue; // created and deleted: no-op
      if (p.first === null) {
        forward.push({ kind: 'create', item: p.last! });
        inverse.push({ kind: 'delete', item: p.last! });
      } else if (p.last === null) {
        forward.push({ kind: 'delete', item: p.first });
        inverse.push({ kind: 'create', item: p.first });
      } else {
        forward.push({ kind: 'update', item: p.last });
        inverse.push({ kind: 'update', item: p.first });
      }
    }
    inverse.reverse();
    return { forward, inverse };
  }

  async commit(): Promise<void> {
    this.assertOpen();
    this.open = false;
    const { forward, inverse } = this.buildOps();
    if (forward.length === 0) {
      await this.backend.end(this.store, 'drop');
      return;
    }
    let canonical: ItemOp[];
    try {
      await this.backend.begin(this.store, this.message);
      canonical = await this.backend.apply(this.store, forward);
      await this.backend.end(this.store, 'commit');
    } catch (err) {
      // KiCad rejected (or the transport failed): roll the optimistic edits back and drop.
      replayInto(this.store, inverse);
      try {
        await this.backend.end(this.store, 'drop');
      } catch {
        /* the failure is what we report */
      }
      throw err;
    }
    this.service.pushHistory({
      id: nextEntryId++,
      message: this.message,
      storeKey: storeKeyOf(this.store),
      forward: canonical,
      inverse,
      at: Date.now(),
    });
  }

  async drop(): Promise<void> {
    this.assertOpen();
    this.open = false;
    const { inverse } = this.buildOps();
    replayInto(this.store, inverse);
    await this.backend.end(this.store, 'drop');
  }
}

function replayInto(store: ItemStore, ops: ItemOp[]): void {
  const mem = mutatorFor(store);
  mem.batch(() => {
    for (const op of ops) {
      if (op.kind === 'delete') mem.remove(op.item.id);
      else mem.replace(op.item);
    }
  });
}

export class CommandServiceImpl implements CommandService {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private stores = new Map<string, ItemStore>();
  private subs = new Set<() => void>();
  private replaying = false;

  constructor(
    private readonly backend: CommitBackend = new MockCommitBackend(),
    private readonly limit = 200,
  ) {}

  begin(store: ItemStore, message: string): Transaction {
    this.stores.set(storeKeyOf(store), store);
    return new TransactionImpl(store, message, this, this.backend);
  }

  async run(store: ItemStore, message: string, fn: (tx: Transaction) => void): Promise<void> {
    const tx = this.begin(store, message);
    try {
      fn(tx);
    } catch (err) {
      await tx.drop();
      throw err;
    }
    await tx.commit();
  }

  /**
   * Records a change that already happened on the server outside a transaction (e.g.
   * ParseAndCreateItemsFromString, which pushes its own KiCad commit) so undo / redo replay it.
   */
  record(store: ItemStore, message: string, forward: ItemOp[], inverse: ItemOp[]): void {
    this.stores.set(storeKeyOf(store), store);
    this.pushHistory({ id: nextEntryId++, message, storeKey: storeKeyOf(store), forward, inverse, at: Date.now() });
  }

  /** @internal called by transactions */
  pushHistory(entry: HistoryEntry): void {
    if (this.replaying) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  async undo(): Promise<HistoryEntry | null> {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    await this.replay(entry, entry.inverse, `Undo ${entry.message}`);
    this.redoStack.push(entry);
    this.emit();
    return entry;
  }

  async redo(): Promise<HistoryEntry | null> {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    await this.replay(entry, entry.forward, `Redo ${entry.message}`);
    this.undoStack.push(entry);
    this.emit();
    return entry;
  }

  private async replay(entry: HistoryEntry, ops: ItemOp[], message: string): Promise<void> {
    const store = this.stores.get(entry.storeKey);
    if (!store) throw new Error(`undo: store ${entry.storeKey} is no longer open`);
    this.replaying = true;
    try {
      await this.backend.begin(store, message);
      await this.backend.apply(store, ops);
      await this.backend.end(store, 'commit');
    } finally {
      this.replaying = false;
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  history(): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
    return { undo: this.undoStack.slice(), redo: this.redoStack.slice() };
  }

  onHistoryChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }
}
