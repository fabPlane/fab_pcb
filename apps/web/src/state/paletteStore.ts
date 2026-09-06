import { create } from 'zustand';

interface PaletteState {
  open: boolean;
  query: string;
  recent: string[]; // command ids, most recent first
  setOpen(open: boolean): void;
  toggle(): void;
  setQuery(q: string): void;
  markUsed(id: string): void;
}

export const usePaletteStore = create<PaletteState>((set, get) => ({
  open: false,
  query: '',
  recent: [],
  setOpen: (open) => set({ open, query: open ? get().query : '' }),
  toggle: () => set({ open: !get().open, query: '' }),
  setQuery: (query) => set({ query }),
  markUsed: (id) => set({ recent: [id, ...get().recent.filter((x) => x !== id)].slice(0, 8) }),
}));
