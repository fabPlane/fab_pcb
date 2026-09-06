// DRC / ERC results. Beyond the list, the panel owns the canvas marker overlay: the visible
// markers are fed to `host.setMarkers`, clicking a row calls `host.focusMarker` (which eases the
// camera to it and draws the legend) and selects the offending items, and the exclude button asks
// for KiCad's exclusion comment before `SetDrcMarkerExcluded`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCanvasHost } from '@/canvas/CanvasSlot';
import { useServices, useServiceVersion } from '@/services';
import type { Marker, MarkerSeverity } from '@/services/types';
import { useEditorStore } from '@/state/editorStore';
import { promptValue } from '@/state/promptStore';
import { useUiStore } from '@/state/uiStore';
import { formatDistance } from '@/lib/units';

interface MarkersPanelProps {
  kind: 'drc' | 'erc';
  storeKey: string;
}

/** The renderer's marker severities; an excluded marker keeps its own look. */
function overlaySeverity(m: Marker): 'error' | 'warning' | 'exclusion' {
  if (m.excluded) return 'exclusion';
  return m.severity === 'error' ? 'error' : 'warning';
}

/** The overlay half of the CanvasHost contract (renderer-only, not in `contracts`). */
type MarkerHost = {
  setMarkers?(markers: { id: string; position: { x: number; y: number }; severity: string; description: string }[]): void;
  setMarkersVisible?(visible: boolean): void;
  focusMarker?(id: string | null, opts?: { durationMs?: number }): boolean;
};

export function MarkersPanel({ kind, storeKey }: MarkersPanelProps) {
  const { markers, board } = useServices();
  const subscribe = useCallback((cb: () => void) => markers.onChange(cb), [markers]);
  useServiceVersion(subscribe);
  const units = useUiStore((s) => s.units);
  const openDialog = useUiStore((s) => s.openDialog);
  const setSelection = useEditorStore((s) => s.setSelection);
  const [running, setRunning] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [filter, setFilter] = useState<Record<MarkerSeverity, boolean>>({ error: true, warning: true, info: false, exclusion: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const visible = useMemo(() => list.filter((m) => (m.excluded ? showExcluded : filter[m.severity])), [list, showExcluded, filter]);

  // Canvas overlay: the visible markers, refreshed whenever the list or the filters change.
  useEffect(() => {
    const host = getCanvasHost(storeKey) as unknown as MarkerHost | undefined;
    if (!host?.setMarkers) return;
    host.setMarkers(visible.map((m) => ({ id: m.id, position: m.position, severity: overlaySeverity(m), description: `${m.rule}: ${m.message}` })));
    host.setMarkersVisible?.(true);
    return () => host.setMarkers?.([]);
  }, [visible, storeKey]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await markers.run(kind);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  /** Row click: focus the marker on the canvas and select what it points at. */
  const focus = (m: Marker) => {
    setSelected(m.id);
    setSelection(storeKey, m.items);
    const host = getCanvasHost(storeKey);
    if ((host as unknown as MarkerHost | undefined)?.focusMarker?.(m.id, { durationMs: 320 })) return;
    host?.setCamera({ x: m.position.x, y: m.position.y });
  };

  const toggleExclude = async (m: Marker) => {
    if (m.excluded) {
      if (markers.setExcludedWithComment) await markers.setExcludedWithComment(m.id, false, '');
      else markers.setExcluded(m.id, false);
      return;
    }
    const comment = await promptValue<string>('Exclude violation', { label: 'Comment', type: 'string', default: '', placeholder: 'Why this violation is acceptable' }, `${m.rule}: ${m.message}`);
    if (comment === null) return;
    if (markers.setExcludedWithComment) await markers.setExcludedWithComment(m.id, true, comment);
    else markers.setExcluded(m.id, true);
  };

  return (
    <div className="panel">
      <div className="filter-bar">
        <button className="btn primary sm" onClick={run} disabled={running}>
          {running ? 'Running…' : kind === 'drc' ? 'Run DRC' : 'Run ERC'}
        </button>
        <span className="muted">{lastRun ? `Last run ${new Date(lastRun).toLocaleTimeString()}` : kind === 'drc' ? 'Design rules not checked yet' : 'Electrical rules not checked yet'}</span>
        {board && (
          <button className="btn ghost sm" data-testid="open-severities" onClick={() => openDialog('severities')} title={`Edit how ${kind.toUpperCase()} rules are reported`}>
            severities…
          </button>
        )}
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
        <label className={`chip${showExcluded ? ' on' : ''}`} data-testid="filter-excluded" onClick={() => setShowExcluded((v) => !v)}>
          {counts.excluded} excluded
        </label>
      </div>
      <div className="panel-body">
        {error && (
          <div className="empty-state" style={{ color: 'var(--danger)' }} role="alert">
            {error}
          </div>
        )}
        {visible.length === 0 && !error && (
          <div className="empty-state">
            {list.length === 0
              ? kind === 'drc'
                ? 'Run DRC to check clearances, connectivity and manufacturing constraints.'
                : 'Run ERC to check pin conflicts, unconnected pins and label mismatches.'
              : 'Nothing to show with the current filters.'}
          </div>
        )}
        {visible.map((m) => (
          <div key={m.id} className={`marker-row${m.id === selected ? ' selected' : ''}${m.excluded ? ' excluded' : ''}`} onClick={() => focus(m)} data-rule={m.rule}>
            <span className={`sev ${m.excluded ? 'exclusion' : m.severity}`} title={m.excluded ? 'Excluded' : m.severity} />
            <span className="rule">{m.rule}</span>
            <span className="msg">
              {m.message}
              {m.excluded && m.comment ? <span className="muted"> — {m.comment}</span> : null}
            </span>
            <span className="pos">
              {formatDistance(m.position.x, units, 2)}, {formatDistance(m.position.y, units, 2)} {units}
              <button
                className="btn ghost sm"
                style={{ marginLeft: 4 }}
                title={m.excluded ? 'Include marker' : 'Exclude marker with a comment'}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleExclude(m);
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
