/** Layer 4 — item store (docs/contracts.md). */
export { MemoryItemStore, toStoredItem, type ItemStore, type StoreDiff, type StorePatch, type StoredItem } from "./item-store";
export { DocumentSync, type ChangedIds, type SyncSource } from "./document-sync";
export { DocumentUndo, UndoStack, inversePatch, type HistoryEntry, type ServerUndoTarget, type UndoOutcome } from "./undo";
