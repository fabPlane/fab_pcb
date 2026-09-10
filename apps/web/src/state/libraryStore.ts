// The library browser's own state: which kind it is showing, the selected library and entry, the
// search text, and the promise-based "pick an entry" handshake the placement commands use
// (`await pickLibraryEntry('footprint')` resolves with a lib id or null, exactly like `prompt()`).

import { create } from 'zustand';
import type { LibraryKind } from '@/services/types';

/** What the browser was opened for; decides the confirm button and what happens on pick. */
export type LibraryPurpose = 'place' | 'assign' | 'browse';

export interface LibraryRequest {
  kind: 'footprint' | 'symbol';
  purpose: LibraryPurpose;
  title: string;
  /** Pre-selected lib id. */
  initial?: string;
  /** Extra line under the title (e.g. the reference footprints are being assigned to). */
  description?: string;
}

interface LibraryState {
  request: LibraryRequest | null;
  resolve: ((libId: string | null) => void) | null;
  /** Selected library nickname, per kind. */
  nickname: Record<'footprint' | 'symbol', string>;
  /** Selected entry lib id, per kind. */
  selected: Record<'footprint' | 'symbol', string>;
  filter: string;
  open(req: LibraryRequest): Promise<string | null>;
  finish(libId: string | null): void;
  setNickname(kind: 'footprint' | 'symbol', nickname: string): void;
  setSelected(kind: 'footprint' | 'symbol', libId: string): void;
  setFilter(filter: string): void;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  request: null,
  resolve: null,
  nickname: { footprint: '', symbol: '' },
  selected: { footprint: '', symbol: '' },
  filter: '',
  open: (request) => {
    get().resolve?.(null);
    const initial = request.initial;
    return new Promise((resolve) => {
      set((s) => ({
        request,
        resolve,
        filter: '',
        nickname: initial?.includes(':') ? { ...s.nickname, [request.kind]: initial.split(':')[0]! } : s.nickname,
        selected: initial ? { ...s.selected, [request.kind]: initial } : s.selected,
      }));
    });
  },
  finish: (libId) => {
    const r = get().resolve;
    set({ request: null, resolve: null });
    r?.(libId);
  },
  setNickname: (kind, nickname) => set((s) => ({ nickname: { ...s.nickname, [kind]: nickname }, filter: '' })),
  setSelected: (kind, libId) => set((s) => ({ selected: { ...s.selected, [kind]: libId } })),
  setFilter: (filter) => set({ filter }),
}));

/** Opens the browser and resolves with the chosen `nickname:name`, or null when cancelled. */
export function pickLibraryEntry(
  kind: 'footprint' | 'symbol',
  opts: Omit<LibraryRequest, 'kind'> = { purpose: 'place', title: kind === 'footprint' ? 'Choose a footprint' : 'Choose a symbol' },
): Promise<string | null> {
  return useLibraryStore.getState().open({ kind, ...opts });
}

/** `'symbol' | 'footprint'` as the library service's kind. */
export const libraryKind = (kind: 'footprint' | 'symbol'): LibraryKind => kind;
