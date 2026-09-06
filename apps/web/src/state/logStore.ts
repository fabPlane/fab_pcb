import { create } from 'zustand';

export interface LogLine {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface LogState {
  lines: LogLine[];
  append(text: string, level?: LogLine['level']): void;
  clear(): void;
}

let seq = 0;

export const useLogStore = create<LogState>((set, get) => ({
  lines: [],
  append: (text, level = 'info') => set({ lines: [...get().lines.slice(-499), { id: ++seq, at: Date.now(), level, text }] }),
  clear: () => set({ lines: [] }),
}));

export const log = (text: string, level: LogLine['level'] = 'info') => useLogStore.getState().append(text, level);
