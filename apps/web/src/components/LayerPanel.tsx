import { useMemo } from 'react';
import type { Theme } from '@/contracts';
import type { LayerInfo } from '@/services/types';
import { useEditorDoc, useEditorStore } from '@/state/editorStore';
import { Panel } from './layout/Panel';

interface LayerPanelProps {
  storeKey: string;
  layers: LayerInfo[];
  theme: Theme;
  /** Number of items per layer, for the hint column. */
  counts?: Record<string, number>;
}

const GROUP_ORDER: LayerInfo['kind'][] = ['copper', 'technical', 'edge', 'user'];
const GROUP_LABEL: Record<LayerInfo['kind'], string> = { copper: 'Copper', technical: 'Technical', edge: 'Board outline', user: 'User' };

export function LayerPanel({ storeKey, layers, theme, counts }: LayerPanelProps) {
  const doc = useEditorDoc(storeKey);
  const setActive = useEditorStore((s) => s.setActiveLayer);
  const setVisible = useEditorStore((s) => s.setLayerVisible);
  const setAll = useEditorStore((s) => s.setAllLayersVisible);
  const setOpacity = useEditorStore((s) => s.setLayerOpacity);
  const hidden = useMemo(() => new Set(doc.hiddenLayers), [doc.hiddenLayers]);
  const groups = GROUP_ORDER.map((kind) => ({ kind, layers: layers.filter((l) => l.kind === kind) })).filter((g) => g.layers.length);
  const hotkey = (id: string) => {
    const copper = layers.filter((l) => l.kind === 'copper').map((l) => l.id);
    const i = copper.indexOf(id);
    if (i === -1) return '';
    if (id === 'BL_F_Cu') return 'PgUp';
    if (id === 'BL_B_Cu') return 'PgDn';
    return `F${i + 4}`;
  };
  return (
    <Panel
      title="Layers"
      actions={
        <>
          <button className="btn ghost sm" onClick={() => setAll(storeKey, layers.map((l) => l.id), true)} title="Show all layers">
            all
          </button>
          <button className="btn ghost sm" onClick={() => setAll(storeKey, layers.filter((l) => l.id !== doc.activeLayer).map((l) => l.id), false)} title="Hide all but the active layer">
            only active
          </button>
        </>
      }
    >
      {groups.map((g) => (
        <div key={g.kind}>
          <div className="layer-group">{GROUP_LABEL[g.kind]}</div>
          {g.layers.map((l) => {
            const isHidden = hidden.has(l.id);
            const alpha = doc.layerOpacity[l.id] ?? 1;
            return (
              <div
                key={l.id}
                className={`layer-row${l.id === doc.activeLayer ? ' active' : ''}${isHidden ? ' hidden-layer' : ''}`}
                onClick={() => setActive(storeKey, l.id)}
                onDoubleClick={() => setAll(storeKey, layers.filter((x) => x.id !== l.id).map((x) => x.id), false)}
                title={`${l.id}${hotkey(l.id) ? ` — ${hotkey(l.id)}` : ''} · double-click to solo`}
              >
                <button
                  className="vis"
                  aria-label={isHidden ? `Show ${l.name}` : `Hide ${l.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setVisible(storeKey, l.id, isHidden);
                  }}
                >
                  {isHidden ? '○' : '●'}
                </button>
                <span className="swatch" style={{ background: theme.layers[l.id] ?? theme.ui.text, opacity: isHidden ? 0.3 : 1 }} />
                <span className="name truncate">
                  {l.name}
                  {counts && counts[l.id] ? <span className="hint">{counts[l.id]}</span> : null}
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={alpha}
                  aria-label={`${l.name} opacity`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setOpacity(storeKey, l.id, Number(e.target.value))}
                  title={`Opacity ${(alpha * 100).toFixed(0)}%`}
                />
              </div>
            );
          })}
        </div>
      ))}
    </Panel>
  );
}
