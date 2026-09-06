import { useCallback, useMemo, useState } from 'react';
import { useServices, useServiceVersion } from '@/services';
import type { Marker, MarkerSeverity } from '@/services/types';
import { useEditorStore } from '@/state/editorStore';
import { useUiStore } from '@/state/uiStore';
import { formatDistance } from '@/lib/units';
import { getCanvasHost } from '@/canvas/CanvasSlot';

interface MarkersPanelProps {
  kind: 'drc' | 'erc';
  storeKey: string;
}

export function MarkersPanel({ kind, storeKey }: MarkersPanelProps) {
  const { markers } = useServices();
  const subscribe = useCallback((cb: () => void) => markers.onChange(cb), [markers]);
  useServiceVersion(subscribe);
  const units = useUiStore((s) => s.units);
  const setSelection = useEditorStore((s) => s.setSelection);
  const [running, setRunning] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [filter, setFilter] = useState<Record<MarkerSeverity, boolean>>({ error: true, warning: true, info: false, exclusion: false });
  const [selected, setSelected] = useState<string | null>(null);
  const list = markers.markers(kind);
  const lastRun = markers.lastRun(kind);
  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0, excluded: 0 };
    for (const m of list) {
      if (m.excluded) c.excluded++;
      else if (m.severity === 'error') c.error++;
      else if (m.severity === 'warning') c.warning++;
      else c.info++;
    }
    return c;
  }, [list]);
  const visible = list.filter((m) => (m.excluded ? showExcluded : filter[m.severity]));

  const run = async () => {
    setRunning(true);
    try {
      await markers.run(kind);
    } finally {
      setRunning(false);
    }
  };

  const focus = (m: Marker) => {
    setSelected(m.id);
    setSelection(storeKey, m.items);
    const host = getCanvasHost(storeKey);
    if (host) host.setCamera({ x: m.position.x, y: m.position.y });
  };

  return (
    <div className="panel">
      <div className="filter-bar">
        <button className="btn primary sm" onClick={run} disabled={running}>
          {running ? 'Running…' : kind === 'drc' ? 'Run DRC' : 'Run ERC'}
        </button>
        <span className="muted">{lastRun ? `Last run ${new Date(lastRun).toLocaleTimeString()}` : kind === 'drc' ? 'Design rules not checked yet' : 'Electrical rules not checked yet'}</span>
        <span className="spacer" />
        <label className={`chip${filter.error ? ' on' : ''}`} onClick={() => setFilter({ ...filter, error: !filter.error })}>
          <span className="sev error" style={{ width: 8, height: 8, borderRadius: 4 }} /> {counts.error} errors
        </label>
        <label className={`chip${filter.warning ? ' on' : ''}`} onClick={() => setFilter({ ...filter, warning: !filter.warning })}>
          <span className="sev warning" style={{ width: 8, height: 8, borderRadius: 4 }} /> {counts.warning} warnings
        </label>
        <label className={`chip${filter.info ? ' on' : ''}`} onClick={() => setFilter({ ...filter, info: !filter.info })}>
          <span className="sev info" style={{ width: 8, height: 8, borderRadius: 4 }} /> {counts.info} info
        </label>
        <label className={`chip${showExcluded ? ' on' : ''}`} onClick={() => setShowExcluded((v) => !v)}>
          {counts.excluded} excluded
        </label>
      </div>
      <div className="panel-body">
        {visible.length === 0 && (
          <div className="empty-state">
            {list.length === 0 ? (kind === 'drc' ? 'Run DRC to check clearances, connectivity and manufacturing constraints.' : 'Run ERC to check pin conflicts, unconnected pins and label mismatches.') : 'Nothing to show with the current filters.'}
          </div>
        )}
        {visible.map((m) => (
          <div key={m.id} className={`marker-row${m.id === selected ? ' selected' : ''}${m.excluded ? ' excluded' : ''}`} onClick={() => focus(m)} onDoubleClick={() => getCanvasHost(storeKey)?.setCamera({ zoom: 0.00012 })}>
            <span className={`sev ${m.excluded ? 'exclusion' : m.severity}`} title={m.excluded ? 'Excluded' : m.severity} />
            <span className="rule">{m.rule}</span>
            <span className="msg">{m.message}</span>
            <span className="pos">
              {formatDistance(m.position.x, units, 2)}, {formatDistance(m.position.y, units, 2)} {units}
              <button
                className="btn ghost sm"
                style={{ marginLeft: 4 }}
                title={m.excluded ? 'Include marker' : 'Exclude marker'}
                onClick={(e) => {
                  e.stopPropagation();
                  markers.setExcluded(m.id, !m.excluded);
                }}
              >
                {m.excluded ? '↺' : '⊘'}
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
