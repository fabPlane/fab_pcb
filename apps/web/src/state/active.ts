import type { DocumentKind, ItemStore } from '@/contracts';
import type { Services } from '@/services/types';
import { useServices } from '@/services';
import { useAppStore } from './appStore';

export interface ActiveDocument {
  kind: DocumentKind;
  key: string; // MemoryItemStore.key / editor store key
  id: string; // 'board' | sheet path | lib id
  store: ItemStore;
}

export function storeKeyFor(kind: DocumentKind, id: string): string {
  if (kind === 'board') return 'board';
  if (kind === 'schematic') return `schematic:${id}`;
  return `footprint:${id}`;
}

export function activeDocument(services: Services): ActiveDocument | null {
  const app = useAppStore.getState();
  switch (app.activeEditor) {
    case 'board': {
      const store = services.documents.board();
      return store ? { kind: 'board', key: 'board', id: 'board', store } : null;
    }
    case 'schematic': {
      const store = services.documents.sheet(app.activeSheet);
      return store ? { kind: 'schematic', key: storeKeyFor('schematic', app.activeSheet), id: app.activeSheet, store } : null;
    }
    case 'footprint': {
      if (!app.activeFootprint) return null;
      const store = services.documents.footprint(app.activeFootprint);
      return store ? { kind: 'footprint', key: storeKeyFor('footprint', app.activeFootprint), id: app.activeFootprint, store } : null;
    }
    default:
      return null;
  }
}

export function useActiveDocument(): ActiveDocument | null {
  const services = useServices();
  const editor = useAppStore((s) => s.activeEditor);
  const sheet = useAppStore((s) => s.activeSheet);
  const fp = useAppStore((s) => s.activeFootprint);
  void editor;
  void sheet;
  void fp;
  return activeDocument(services);
}
