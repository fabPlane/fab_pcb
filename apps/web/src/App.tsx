import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandPalette } from '@/components/CommandPalette';
import { MenuBar } from '@/components/MenuBar';
import { StatusBar } from '@/components/StatusBar';
import { Dialogs } from '@/components/dialogs';
import { TipProvider } from '@/components/layout/Tip';
import { useKeyboard } from '@/hooks/useKeyboard';
import { BoardEditor } from '@/screens/BoardEditor';
import { FootprintEditor } from '@/screens/FootprintEditor';
import { ProjectScreen } from '@/screens/ProjectScreen';
import { SchematicEditor } from '@/screens/SchematicEditor';
import { ThreeDView } from '@/screens/ThreeDView';
import { useServices, useServiceVersion } from '@/services';
import { useAppStore } from '@/state/appStore';
import { useActiveDocument } from '@/state/active';
import { log } from '@/state/logStore';
import { resolveTheme, useUiStore } from '@/state/uiStore';
import { installThemeSync } from '@/theme';

/** Keeps `<html data-theme>` in step with the store (and prefers-color-scheme in system mode); see src/theme. */
function useThemeAttribute(): void {
  useEffect(() => installThemeSync(), []);
}

function Toast() {
  const toast = useAppStore((s) => s.toast);
  const clear = useAppStore((s) => s.clearToast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clear, toast.kind === 'error' ? 6000 : 2500);
    return () => clearTimeout(t);
  }, [toast, clear]);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.text}
    </div>
  );
}

function TitleBar() {
  const session = useAppStore((s) => s.session);
  const openDocs = useAppStore((s) => s.openDocs);
  const active = useAppStore((s) => s.activeEditor);
  const activeSheet = useAppStore((s) => s.activeSheet);
  const activeFp = useAppStore((s) => s.activeFootprint);
  const openDoc = useAppStore((s) => s.openDoc);
  const closeDoc = useAppStore((s) => s.closeDoc);
  const setActiveEditor = useAppStore((s) => s.setActiveEditor);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const { documents } = useServices();
  const sub = useCallback((cb: () => void) => documents.onChange(cb), [documents]);
  useServiceVersion(sub);
  const resolved = resolveTheme(theme);
  const isActive = (d: (typeof openDocs)[number]) => d.kind === active && (d.kind === 'board' || (d.kind === 'schematic' && d.id === activeSheet) || (d.kind === 'footprint' && d.id === activeFp));
  return (
    <div className="titlebar">
      <div className="brand" onClick={() => setActiveEditor('project')} style={{ cursor: 'pointer' }} title="Project screen">
        <span className="logo" />
        <span>FabPlane PCB</span>
      </div>
      <MenuBar />
      <div className="doc-tabs">
        {session && (
          <button className={`doc-tab${active === 'project' ? ' active' : ''}`} onClick={() => setActiveEditor('project')}>
            {session.projectName}
          </button>
        )}
        {openDocs.map((d) => (
          <button key={`${d.kind}:${d.id}`} className={`doc-tab${isActive(d) ? ' active' : ''}`} onClick={() => openDoc(d)} title={`${d.kind} · ${d.id}`}>
            <span className="faint">{d.kind === 'board' ? '▦' : d.kind === 'schematic' ? '▤' : d.kind === '3d' ? '⬡' : '▣'}</span>
            {d.title}
            {d.kind !== '3d' && documents.isDirty(d.kind) && <span className="dirty">●</span>}
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                closeDoc(d.kind, d.id);
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>
      <div className="right">
        <span className="session-pill" title={session ? `${session.projectPath}\nsession ${session.id}\ntoken ${session.kicadToken}` : 'Not connected to a bridge session'}>
          <span className={`dot ${session?.state ?? ''}`} />
          {session ? (session.state === 'open' ? `KiCad ${session.kicadVersion.split('-')[0]}` : session.state) : 'offline'}
        </span>
        <button className="btn ghost sm" onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')} title={`Theme: ${theme} (click to toggle, View → Follow system theme resets)`}>
          {resolved === 'dark' ? '☾' : '☼'}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const services = useServices();
  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.setSession);
  const active = useAppStore((s) => s.activeEditor);
  const notify = useAppStore((s) => s.notify);
  const openDoc = useAppStore((s) => s.openDoc);
  const [busy, setBusy] = useState(false);
  const autoOpened = useRef(false);
  useThemeAttribute();
  useKeyboard();
  const activeDoc = useActiveDocument();

  useEffect(() => services.session.onChange((s) => setSession(s)), [services, setSession]);

  const openProject = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        // Direct mode dials the running server instead of asking the bridge to spawn one.
        log((services.session as { direct?: boolean }).direct ? `Connecting directly to KiCad${path ? ` for "${path}"` : ''}` : `POST /sessions {path: "${path}"}`);
        const s = await services.session.connect(path);
        log(`Session ${s.id} open · KiCad ${s.kicadVersion} · token ${s.kicadToken}`);
        services.commands.clearHistory();
        const root = services.documents.sheets()[0];
        const hasBoard = !!services.documents.board();
        if (hasBoard) openDoc({ kind: 'board', id: 'board', title: `${s.projectName}.kicad_pcb` });
        if (root) {
          if (hasBoard) useAppStore.getState().openDocs.some((d) => d.kind === 'schematic') || useAppStore.setState((st) => ({ openDocs: [...st.openDocs, { kind: 'schematic', id: root.path, title: root.file }] }));
          else openDoc({ kind: 'schematic', id: root.path, title: root.file });
        }
        if (!hasBoard && !root) notify('The session opened but KiCad reports no board or schematic', 'error');
      } catch (e) {
        log((e as Error).message, 'error');
        notify((e as Error).message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [services, notify, openDoc],
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    const p = url.searchParams.get('project');
    // With no bridge there is no project browser to pick from, so connect straight away and let
    // the session adopt whatever document the running server already has open.
    const bridgeless = (services.session as { bridgeless?: boolean }).bridgeless === true;
    if ((p || bridgeless) && !session && !autoOpened.current) {
      autoOpened.current = true;
      void openProject(p ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const screen = !session || session.state !== 'open' || active === 'project' ? (
    <ProjectScreen onOpen={openProject} busy={busy} />
  ) : active === 'board' ? (
    <BoardEditor />
  ) : active === 'schematic' ? (
    <SchematicEditor />
  ) : active === '3d' ? (
    <ThreeDView />
  ) : (
    <FootprintEditor />
  );

  return (
    <TipProvider>
      <div className="app-shell">
        <TitleBar />
        {screen}
        <StatusBar storeKey={session && active !== 'project' && activeDoc ? activeDoc.key : null} store={activeDoc?.store ?? null} />
        <CommandPalette />
        <Dialogs onProjectCreated={(p) => void openProject(p)} />
        <Toast />
      </div>
    </TipProvider>
  );
}
