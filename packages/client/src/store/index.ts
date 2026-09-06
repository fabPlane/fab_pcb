/** Layer 4 — item store (docs/contracts.md). */
export { MemoryItemStore, toStoredItem, type ItemStore, type StoreDiff, type StorePatch, type StoredItem } from "./item-store";
export { DocumentSync, type SyncSource } from "./document-sync";
export { UndoStack, inversePatch, type HistoryEntry } from "./undo";
