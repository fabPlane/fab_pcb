/**
 * Client-side undo helpers: compute the inverse of a patch before it is applied, and keep a
 * forward/inverse history that can be replayed onto a store.
 */
import type { ItemStore, StorePatch, StoredItem } from "./item-store";
import type { MemoryItemStore } from "./item-store";

/**
 * The patch that undoes `patch` if applied after it. Must be computed *before* `patch` is applied,
 * because it captures the current versions of the items `patch` touches.
 */
export function inversePatch(store: ItemStore, patch: StorePatch): StorePatch {
  const added: StoredItem[] = [];
  const updated: StoredItem[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();
  const consider = (id: string, willExist: boolean) => {
    if (seen.has(id)) return;
    seen.add(id);
    const prev = store.get(id);
    if (prev && willExist) updated.push(prev);
    else if (prev && !willExist) added.push(prev);
    else if (!prev && willExist) removed.push(id);
  };
  for (const it of patch.added ?? []) consider(it.id, true);
  for (const it of patch.updated ?? []) consider(it.id, true);
  for (const id of patch.removed ?? []) consider(id, false);
  return { added, updated, removed };
}

export interface HistoryEntry {
  label: string;
  forward: StorePatch;
  inverse: StorePatch;
  revision: number;
}

/** A linear undo/redo stack over store patches. */
export class UndoStack {
  private readonly entries: HistoryEntry[] = [];
  private cursor = 0;

  constructor(
    private readonly store: MemoryItemStore,
    readonly limit = 200,
  ) {}

  /** Applies `patch` to the store and records it (dropping any redo entries). */
  apply(label: string, patch: StorePatch): HistoryEntry | undefined {
    const inverse = inversePatch(this.store, patch);
    const diff = this.store.apply(patch);
    if (!diff) return undefined;
    this.entries.length = this.cursor;
    const entry: HistoryEntry = { label, forward: patch, inverse, revision: diff.revision };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = this.entries.length;
    return entry;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  undo(): HistoryEntry | undefined {
    if (!this.canUndo) return undefined;
    const entry = this.entries[--this.cursor]!;
    this.store.apply(entry.inverse);
    return entry;
  }

  redo(): HistoryEntry | undefined {
    if (!this.canRedo) return undefined;
    const entry = this.entries[this.cursor++]!;
    this.store.apply(entry.forward);
    return entry;
  }

  get history(): readonly HistoryEntry[] {
    return this.entries.slice(0, this.cursor);
  }

  clear(): void {
    this.entries.length = 0;
    this.cursor = 0;
  }
}
