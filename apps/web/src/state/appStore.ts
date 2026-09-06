import { create } from 'zustand';
import type { DocumentKind } from '@/contracts';
import type { SessionInfo } from '@/services/types';

export type EditorKind = 'project' | DocumentKind | '3d';

export interface OpenDoc {
  kind: DocumentKind | '3d';
  id: string; // 'board' | sheet path | footprint lib id
  title: string;
}

interface AppState {
  session: SessionInfo | null;
  activeEditor: EditorKind;
  openDocs: OpenDoc[];
  activeSheet: string; // schematic sheet path
  activeFootprint: string | null; // LIB_ID
  toast: { id: number; text: string; kind: 'info' | 'error' } | null;
  setSession(s: SessionInfo | null): void;
  setActiveEditor(kind: EditorKind): void;
  openDoc(doc: OpenDoc): void;
  closeDoc(kind: DocumentKind | '3d', id: string): void;
  setActiveSheet(path: string): void;
  setActiveFootprint(libId: string | null): void;
  notify(text: string, kind?: 'info' | 'error'): void;
  clearToast(): void;
}

let toastSeq = 0;

export const useAppStore = create<AppState>((set, get) => ({
  session: null,
  activeEditor: 'project',
  openDocs: [],
  activeSheet: '/',
  activeFootprint: null,
  toast: null,
  setSession: (session) => set({ session, ...(session === null ? { activeEditor: 'project', openDocs: [] } : {}) }),
  setActiveEditor: (activeEditor) => set({ activeEditor }),
  openDoc: (doc) => {
    const docs = get().openDocs;
    if (!docs.some((d) => d.kind === doc.kind && d.id === doc.id)) set({ openDocs: [...docs, doc] });
    set({ activeEditor: doc.kind });
    if (doc.kind === 'schematic') set({ activeSheet: doc.id });
    if (doc.kind === 'footprint') set({ activeFootprint: doc.id });
  },
  closeDoc: (kind, id) => {
    const docs = get().openDocs.filter((d) => !(d.kind === kind && d.id === id));
    set({ openDocs: docs });
    if (get().activeEditor === kind && !docs.some((d) => d.kind === kind)) set({ activeEditor: 'project' });
  },
  setActiveSheet: (activeSheet) => set({ activeSheet }),
  setActiveFootprint: (activeFootprint) => set({ activeFootprint }),
  notify: (text, kind = 'info') => set({ toast: { id: ++toastSeq, text, kind } }),
  clearToast: () => set({ toast: null }),
}));
