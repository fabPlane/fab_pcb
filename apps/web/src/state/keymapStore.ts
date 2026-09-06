import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** commandId -> chord text (e.g. 'Mod+Z'). Only user overrides are stored. */
interface KeymapState {
  overrides: Record<string, string | null>; // null = unbound
  setBinding(commandId: string, chord: string | null): void;
  resetBinding(commandId: string): void;
  resetAll(): void;
}

export const useKeymapStore = create<KeymapState>()(
  persist(
    (set, get) => ({
      overrides: {},
      setBinding: (commandId, chord) => set({ overrides: { ...get().overrides, [commandId]: chord } }),
      resetBinding: (commandId) => {
        const next = { ...get().overrides };
        delete next[commandId];
        set({ overrides: next });
      },
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'kicad-web.keymap', version: 1 },
  ),
);
