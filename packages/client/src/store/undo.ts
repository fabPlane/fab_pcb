/**
 * Undo helpers.
 *
 * Two mechanisms, and `DocumentUndo` picks between them:
 *
 * - **Server undo** (`Undo` / `Redo` / `GetUndoStack`, KiCad >= 11.0). KiCad owns the
 *   authoritative history, so undoing there also reverts what the client never mirrored — zone
 *   fills, connectivity, netlist changes, and edits made outside a commit such as
 *   `SetBoardOrigin`. The store then re-syncs from the document. This is the preferred path
 *   whenever the capability is present.
 * - **Client patches** (`inversePatch` + `UndoStack`). The pre-11.0 fallback: the inverse of each
 *   patch is computed before it is applied and replayed onto the store. It only knows about items
 *   that passed through the store, and it cannot revert anything on the KiCad side, so a document
 *   undone this way has diverged from the server until the next full sync.
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

/** The slice of a `Document` that `DocumentUndo` needs (see `model/document.ts`). */
export interface ServerUndoTarget {
  undo(count?: number): Promise<{ applied: number; undoCount: number; redoCount: number }>;
  redo(count?: number): Promise<{ applied: number; undoCount: number; redoCount: number }>;
  supportsServerUndo(): Promise<boolean>;
}

/** How one `DocumentUndo` step was carried out. */
export interface UndoOutcome {
  via: "server" | "client" | "none";
  /** Commands KiCad undid/redid (server path). */
  applied: number;
  /** The client-side entry that was replayed (client path). */
  entry?: HistoryEntry;
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

/**
 * Undo for a live document: KiCad's own undo stack when the server implements it, the client-side
 * patch stack otherwise.
 *
 * The capability is probed once (`supportsServerUndo()`, i.e. `GetSupportedCommands` carrying
 * `Undo`) and cached. On the server path the local `UndoStack` is still fed by `apply()` so that a
 * later downgrade — or a document that never reached the server — can fall back cleanly, but its
 * cursor is not moved: after a server undo the caller re-reads the document (`DocumentSync.syncSince()`
 * or a `DocumentChanged` event) instead of trusting the local inverse.
 */
export class DocumentUndo {
  private serverOk: Promise<boolean> | undefined;

  constructor(
    readonly stack: UndoStack,
    /** The document; omit to force the client-side path. */
    readonly document?: ServerUndoTarget,
  ) {}

  /** Records a patch on the client stack (harmless on the server path; see the class docs). */
  apply(label: string, patch: StorePatch): HistoryEntry | undefined {
    return this.stack.apply(label, patch);
  }

  /** Whether KiCad's `Undo` is available; probed once and cached. */
  useServer(): Promise<boolean> {
    if (!this.document) return Promise.resolve(false);
    this.serverOk ??= this.document.supportsServerUndo().catch(() => false);
    return this.serverOk;
  }

  async undo(count = 1): Promise<UndoOutcome> {
    if (this.document && (await this.useServer())) {
      const r = await this.document.undo(count);
      return { via: "server", applied: r.applied };
    }
    const entry = this.stack.undo();
    return entry ? { via: "client", applied: 1, entry } : { via: "none", applied: 0 };
  }

  async redo(count = 1): Promise<UndoOutcome> {
    if (this.document && (await this.useServer())) {
      const r = await this.document.redo(count);
      return { via: "server", applied: r.applied };
    }
    const entry = this.stack.redo();
    return entry ? { via: "client", applied: 1, entry } : { via: "none", applied: 0 };
  }
}
