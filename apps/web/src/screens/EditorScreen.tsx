// Shared 3-column docked editor used by BoardEditor, SchematicEditor and FootprintEditor.

import { useCallback, useMemo, type ReactNode } from 'react';
import type { DocumentKind, ItemStore } from '@/contracts';
import { CanvasSlot } from '@/canvas/CanvasSlot';
import { themeFor } from '@/canvas/theme';
import { HistoryPanel } from '@/components/HistoryPanel';
import { JobsPanel } from '@/components/JobsPanel';
import { LayerPanel } from '@/components/LayerPanel';
import { LogPanel } from '@/components/LogPanel';
import { MarkersPanel } from '@/components/MarkersPanel';
import { NetInspector } from '@/components/NetInspector';
import { ProjectTree } from '@/components/ProjectTree';
import { SelectionProperties } from '@/components/SelectionProperties';
import { Toolbar } from '@/components/Toolbar';
import { DockLayout } from '@/components/layout/DockLayout';
import { PanelTabs } from '@/components/layout/Panel';
import { useServices, useServiceVersion } from '@/services';
import type { LayerInfo } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useHistoryStore } from '@/state/historyStore';
import { resolveTheme, useUiStore } from '@/state/uiStore';
import { storeKeyFor } from '@/state/active';

export interface EditorScreenProps {
  kind: DocumentKind;
  id: string;
  store: ItemStore;
  layers: LayerInfo[];
  /** Extra left-panel tab (schematic: hierarchy). */
  leftExtra?: { id: 'hierarchy'; label: string; content: ReactNode };
}

export function EditorScreen({ kind, id, store, layers, leftExtra }: EditorScreenProps) {
  const services = useServices();
  const { documents, markers } = services;
  const docsSub = useCallback((cb: () => void) => documents.onChange(cb), [documents]);
  useServiceVersion(docsSub);
  const markersSub = useCallback((cb: () => void) => markers.onChange(cb), [markers]);
  useServiceVersion(markersSub);
  const storeKey = storeKeyFor(kind, id);
  const themeMode = useUiStore((s) => s.theme);
  const canvasTheme = useUiStore((s) => s.canvasTheme);
  const theme = themeFor(resolveTheme(themeMode), canvasTheme);
  const leftTab = useUiStore((s) => s.leftTab);
  const setLeftTab = useUiStore((s) => s.setLeftTab);
  const bottomTab = useUiStore((s) => s.bottomTab);
  const setBottomTab = useUiStore((s) => s.setBottomTab);
  const session = useAppStore((s) => s.session);
  const openDoc = useAppStore((s) => s.openDoc);
  const undoCount = useHistoryStore((s) => s.undo.length);

  const layerIds = useMemo(() => layers.map((l) => l.id), [layers]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of store.all()) if (it.layer) c[it.layer] = (c[it.layer] ?? 0) + 1;
    return c;
  }, [store, store.revision]);

  const markerKind = kind === 'schematic' ? 'erc' : 'drc';
  const markerList = markers.markers(markerKind);
  const errors = markerList.filter((m) => m.severity === 'error' && !m.excluded).length;
  const warnings = markerList.filter((m) => m.severity === 'warning' && !m.excluded).length;

  const leftTabs: { id: 'tree' | 'layers' | 'nets'; label: string }[] = [{ id: 'tree', label: 'Project' }];
  if (kind !== 'schematic') leftTabs.push({ id: 'layers', label: 'Layers' });
  if (kind === 'board') leftTabs.push({ id: 'nets', label: 'Nets' });
  const effectiveLeft = leftTabs.some((t) => t.id === leftTab) ? leftTab : leftExtra && leftTab === 'layers' ? 'tree' : 'tree';
  const showHierarchy = leftExtra && leftTab === 'layers' && kind === 'schematic';

  const left = (
    <div className="panel">
      <PanelTabs tabs={[...leftTabs, ...(leftExtra ? [{ id: 'layers' as const, label: leftExtra.label }] : [])]} active={showHierarchy ? 'layers' : effectiveLeft} onChange={(t) => setLeftTab(t)} />
      {showHierarchy ? (
        leftExtra!.content
      ) : effectiveLeft === 'tree' ? (
        <ProjectTree
          projectName={session?.projectName ?? 'project'}
          projectPath={session?.projectPath ?? ''}
          boardFile={`${session?.projectName ?? 'board'}.kicad_pcb`}
          sheets={documents.sheets()}
          footprints={documents.openFootprints()}
          active={{ kind, id }}
          dirty={{ board: documents.isDirty('board'), schematic: documents.isDirty('schematic'), footprint: documents.isDirty('footprint') }}
          onOpen={(k, i, title) => openDoc({ kind: k, id: i, title })}
        />
      ) : effectiveLeft === 'layers' ? (
        <LayerPanel storeKey={storeKey} layers={layers} theme={theme} counts={counts} />
      ) : (
        <NetInspector storeKey={storeKey} nets={documents.nets()} />
      )}
    </div>
  );

  const bottom = (
    <div className="panel">
      <PanelTabs
        tabs={[
          {
            id: 'markers',
            label: kind === 'schematic' ? 'ERC' : 'DRC',
            badge: errors + warnings > 0 ? <span className={`badge ${errors ? 'error' : 'warning'}`}>{errors || warnings}</span> : undefined,
          },
          { id: 'jobs', label: 'Jobs' },
          { id: 'history', label: 'History', badge: undoCount ? <span className="badge">{undoCount}</span> : undefined },
          { id: 'log', label: 'Output' },
        ]}
        active={bottomTab}
        onChange={setBottomTab}
        actions={
          <button className="btn ghost sm" onClick={() => useUiStore.getState().togglePanel('bottom', true)} title="Collapse">
            ▾
          </button>
        }
      />
      {bottomTab === 'markers' && <MarkersPanel kind={markerKind} storeKey={storeKey} />}
      {bottomTab === 'jobs' && <JobsPanel document={kind === 'footprint' ? 'board' : kind} />}
      {bottomTab === 'history' && <HistoryPanel />}
      {bottomTab === 'log' && <LogPanel />}
    </div>
  );

  return (
    <div className="app-main">
      <Toolbar kind={kind} storeKey={storeKey} layers={layers} />
      <DockLayout
        left={left}
        center={<CanvasSlot kind={kind} storeKey={storeKey} store={store} layers={layerIds} />}
        right={<SelectionProperties storeKey={storeKey} store={store} kind={kind} />}
        bottom={bottom}
        leftRail={leftTabs.map((t) => ({ label: t.label, onClick: () => setLeftTab(t.id) }))}
        rightRail={[{ label: 'Properties', onClick: () => undefined }]}
        bottomRail={[
          { label: kind === 'schematic' ? 'ERC' : 'DRC', onClick: () => setBottomTab('markers') },
          { label: 'Jobs', onClick: () => setBottomTab('jobs') },
          { label: 'History', onClick: () => setBottomTab('history') },
          { label: 'Output', onClick: () => setBottomTab('log') },
        ]}
      />
    </div>
  );
}
