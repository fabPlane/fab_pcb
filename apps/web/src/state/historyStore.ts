import { create } from 'zustand';
import type { CommandService, HistoryEntry } from '@/services/types';

interface HistoryState {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  sync(service: CommandService): void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  undo: [],
  redo: [],
  sync: (service) => set(service.history()),
}));

/** Keeps the zustand mirror in step with the CommandService; call once at app start. */
export function bindHistory(service: CommandService): () => void {
  useHistoryStore.getState().sync(service);
  return service.onHistoryChange(() => useHistoryStore.getState().sync(service));
}
