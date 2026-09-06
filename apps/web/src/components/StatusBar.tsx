import { useCallback, useEffect, useState } from 'react';
import { useEditorDoc } from '@/state/editorStore';
import { useAppStore } from '@/state/appStore';
import { useUiStore, GRID_CHOICES_NM } from '@/state/uiStore';
import { formatDistance, NM_PER_MM } from '@/lib/units';
import { typeLabel } from './properties/schema';
import type { ItemStore } from '@/contracts';
import { layerDisplayName } from '@/lib/enums';
import { useServices, useServiceVersion } from '@/services';

/** Unrouted connections on the board (`GetUnroutedCount`), refreshed when the store changes. */
function UnroutedCell({ store }: { store: ItemStore | null }) {
  const { board, documents } = useServices();
  const sub = useCallback((cb: () => void) => documents.onChange(cb), [documents]);
  const version = useServiceVersion(sub);
  const [info, setInfo] = useState<{ unroutedCount: number; unroutedNetCount: number } | null>(null);
  const revision = store?.revision ?? 0;

  useEffect(() => {
    if (!board) return;
    let live = true;
    const t = setTimeout(() => {
      board
        .unrouted()
        .then((r) => live && setInfo(r))
        .catch(() => live && setInfo(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [board, revision, version]);

  if (!board || !info) return null;
  return (
    <div className={`cell${info.unroutedCount ? ' warn' : ''}`} data-testid="unrouted-count" title={`${info.unroutedCount} unrouted connection(s) across ${info.unroutedNetCount} net(s) — GetUnroutedCount`}>
      <span className="faint">unrouted</span> {info.unroutedCount}
      {info.unroutedNetCount ? ` / ${info.unroutedNetCount} nets` : ''}
    </div>
  );
}

export function StatusBar({ storeKey, store }: { storeKey: string | null; store: ItemStore | null }) {
  const doc = useEditorDoc(storeKey ?? '__none__');
  const units = useUiStore((s) => s.units);
  const cycleUnits = useUiStore((s) => s.cycleUnits);
  const gridNm = useUiStore((s) => s.gridNm);
  const setGrid = useUiStore((s) => s.setGrid);
  const showGrid = useUiStore((s) => s.showGrid);
  const toggleGrid = useUiStore((s) => s.toggleGrid);
  const session = useAppStore((s) => s.session);
  const activeEditor = useAppStore((s) => s.activeEditor);
  const cursor = doc.cursor;
  const hover = doc.hover && store ? store.get(doc.hover) : undefined;
  const pxPerMm = doc.camera.zoom * NM_PER_MM;
  return (
    <div className="statusbar">
      <div className="cell num" title="Cursor position (world)">
        <span className="faint">X</span> {cursor ? formatDistance(cursor.x, units) : '—'} <span className="faint">Y</span> {cursor ? formatDistance(cursor.y, units) : '—'}
      </div>
      <div className="cell num" title="Zoom (screen pixels per mm)">
        <span className="faint">Z</span> {pxPerMm > 0 ? pxPerMm.toFixed(2) : '—'} px/mm
      </div>
      <div className="cell btn-cell" onClick={toggleGrid} title="Toggle grid (Alt+G)">
        <span className="faint">grid</span> {showGrid ? '●' : '○'}
      </div>
      <div className="cell">
        <select className="select" style={{ height: 18, fontSize: 'var(--fs-xs)' }} value={gridNm} onChange={(e) => setGrid(Number(e.target.value))} aria-label="Grid spacing">
          {GRID_CHOICES_NM.map((g) => (
            <option key={g} value={g}>
              {formatDistance(g, units)} {units}
            </option>
          ))}
        </select>
      </div>
      <div className="cell btn-cell" onClick={cycleUnits} title="Switch units (Mod+U)">
        {units}
      </div>
      {storeKey && (
        <div className="cell" title="Active layer">
          <span className="faint">layer</span> {doc.activeLayer.startsWith('SLT_') ? doc.activeLayer.replace('SLT_', '').toLowerCase() : layerDisplayName(doc.activeLayer)}
        </div>
      )}
      {activeEditor === 'board' && <UnroutedCell store={store} />}
      <div className="cell msg">
        {doc.selection.length > 0 ? `${doc.selection.length} selected` : hover ? `${typeLabel(hover.type)}${hover.net ? ` · ${hover.net}` : ''}${hover.layer ? ` · ${layerDisplayName(hover.layer)}` : ''}` : ''}
      </div>
      <span className="spacer" />
      {doc.highlightNets.length > 0 && <div className="cell">highlight: {doc.highlightNets.join(', ')}</div>}
      <div className="cell" title={session ? `Session ${session.id} · ${session.projectPath}` : 'Not connected'}>
        {session ? `${session.state} · KiCad ${session.kicadVersion || '…'}` : 'no session'}
      </div>
    </div>
  );
}
