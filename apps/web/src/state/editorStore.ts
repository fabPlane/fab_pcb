// Interaction state the UI owns (docs/03-rendering.md): selection, hover, active layer,
// layer visibility/opacity, net highlight, camera. Keyed per document so switching
// between the board and a sheet keeps each one's state.

import { create } from 'zustand';
import type { Camera, DocumentKind } from '@/contracts';

export interface EditorDocState {
  selection: string[];
  hover: string | null;
  activeLayer: string;
  hiddenLayers: string[];
  layerOpacity: Record<string, number>;
  highlightNets: string[];
  camera: Camera;
  cursor: { x: number; y: number } | null; // world nm
  /** 'select', 'move', or an interactive tool id (canvas/tools.ts) */
  tool: string;
}

const fresh = (kind: DocumentKind): EditorDocState => ({
  selection: [],
  hover: null,
  activeLayer: kind === 'schematic' || kind === 'symbol' ? 'SLT_WIRE' : 'BL_F_Cu',
  hiddenLayers: [],
  layerOpacity: {},
  highlightNets: [],
  camera: { x: 0, y: 0, zoom: 0 },
  cursor: null,
  tool: 'select',
});

interface EditorState {
  docs: Record<string, EditorDocState>;
  ensure(key: string, kind: DocumentKind): void;
  setSelection(key: string, ids: string[]): void;
  toggleSelection(key: string, id: string): void;
  setHover(key: string, id: string | null): void;
  setActiveLayer(key: string, layer: string): void;
  setLayerVisible(key: string, layer: string, visible: boolean): void;
  setAllLayersVisible(key: string, layers: string[], visible: boolean): void;
  setLayerOpacity(key: string, layer: string, alpha: number): void;
  setHighlightNets(key: string, nets: string[]): void;
  toggleHighlightNet(key: string, net: string): void;
  setCamera(key: string, cam: Camera): void;
  setCursor(key: string, cursor: { x: number; y: number } | null): void;
  setTool(key: string, tool: EditorDocState['tool']): void;
}

function update(set: (fn: (s: EditorState) => Partial<EditorState>) => void, key: string, patch: (d: EditorDocState) => Partial<EditorDocState>) {
  set((s) => {
    const cur = s.docs[key] ?? fresh(key.startsWith('schematic') ? 'schematic' : key.startsWith('footprint') ? 'footprint' : 'board');
    return { docs: { ...s.docs, [key]: { ...cur, ...patch(cur) } } };
  });
}

export const useEditorStore = create<EditorState>((set, get) => ({
  docs: {},
  ensure: (key, kind) => {
    if (!get().docs[key]) set({ docs: { ...get().docs, [key]: fresh(kind) } });
  },
  setSelection: (key, ids) => update(set, key, () => ({ selection: ids })),
  toggleSelection: (key, id) =>
    update(set, key, (d) => ({ selection: d.selection.includes(id) ? d.selection.filter((x) => x !== id) : [...d.selection, id] })),
  setHover: (key, id) => update(set, key, (d) => (d.hover === id ? {} : { hover: id })),
  setActiveLayer: (key, layer) => update(set, key, () => ({ activeLayer: layer })),
  setLayerVisible: (key, layer, visible) =>
    update(set, key, (d) => ({ hiddenLayers: visible ? d.hiddenLayers.filter((l) => l !== layer) : [...new Set([...d.hiddenLayers, layer])] })),
  setAllLayersVisible: (key, layers, visible) =>
    update(set, key, (d) => ({ hiddenLayers: visible ? d.hiddenLayers.filter((l) => !layers.includes(l)) : [...new Set([...d.hiddenLayers, ...layers])] })),
  setLayerOpacity: (key, layer, alpha) => update(set, key, (d) => ({ layerOpacity: { ...d.layerOpacity, [layer]: alpha } })),
  setHighlightNets: (key, nets) => update(set, key, () => ({ highlightNets: nets })),
  toggleHighlightNet: (key, net) =>
    update(set, key, (d) => ({ highlightNets: d.highlightNets.includes(net) ? d.highlightNets.filter((n) => n !== net) : [...d.highlightNets, net] })),
  setCamera: (key, camera) => update(set, key, () => ({ camera })),
  setCursor: (key, cursor) => update(set, key, () => ({ cursor })),
  setTool: (key, tool) => update(set, key, () => ({ tool })),
}));

export const EMPTY_DOC_STATE: EditorDocState = fresh('board');

export function useEditorDoc(key: string): EditorDocState {
  return useEditorStore((s) => s.docs[key]) ?? EMPTY_DOC_STATE;
}
