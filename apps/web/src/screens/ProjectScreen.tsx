import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '@/services';
import { KicadSessionService } from '@/services/kicad';
import type { FileEntry, RecentProject } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useUiStore } from '@/state/uiStore';

function fmtSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
}

function icon(e: FileEntry): { glyph: string; cls: string } {
  if (e.kind === 'dir') return { glyph: '▸', cls: '' };
  switch (e.fileType) {
    case 'project':
      return { glyph: '◆', cls: 'project' };
    case 'board':
      return { glyph: '▦', cls: '' };
    case 'schematic':
      return { glyph: '▤', cls: '' };
    case 'footprint':
      return { glyph: '▣', cls: '' };
    case 'symbol-lib':
      return { glyph: '▥', cls: '' };
    default:
      return { glyph: '·', cls: '' };
  }
}

/**
 * In-browser wasm mode has no disk to browse: the module's file system starts empty and the tab
 * cannot read the user's. So the project is imported instead — pick the `.kicad_pro` and its
 * `.kicad_pcb` / `.kicad_sch` (a whole directory works too, where the browser offers one), and the
 * files are copied into MEMFS before `OpenDocument`.
 */
function ImportProject({ session, onOpen, busy }: { session: KicadSessionService; onOpen(path: string): void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const take = async (list: FileList | null) => {
    setError(null);
    const picked = [...(list ?? [])];
    if (picked.length === 0) return;
    try {
      const files = await Promise.all(
        // A directory picker reports `webkitRelativePath`, which keeps sub-sheets in their folders.
        picked.map(async (f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      );
      onOpen(await session.importProjectFiles(files));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      className={`import-project${dropping ? ' dropping' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void take(e.dataTransfer.files);
      }}
    >
      <div className="section-header">
        <span>Open a project</span>
      </div>
      <div className="empty-state">
        KiCad runs in this tab, so it starts with an empty file system. Choose a <code>.kicad_pro</code> together with its <code>.kicad_pcb</code> / <code>.kicad_sch</code> (or drop them here) and
        they are copied in.
      </div>
      {error && (
        <div className="empty-state" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}
      <input ref={input} type="file" multiple hidden accept=".kicad_pro,.kicad_pcb,.kicad_sch,.kicad_prl,.kicad_sym,.kicad_mod,.csv,.json" onChange={(e) => void take(e.target.files)} />
      <div className="project-actions">
        <span className="path">{session.workspaceRoot()}</span>
        <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Opening…' : 'Choose files…'}
        </button>
      </div>
    </div>
  );
}

export function ProjectScreen({ onOpen, busy }: { onOpen(path: string): void; busy: boolean }) {
  const { session } = useServices();
  const openDialog = useUiStore((s) => s.openDialog);
  const current = useAppStore((s) => s.session);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [dir, setDir] = useState(session.workspaceRoot());
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setError(null);
      try {
        setEntries(await session.listFiles(path));
        setDir(path);
        setSelected(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [session],
  );

  const wasm = session instanceof KicadSessionService && session.wasm;

  useEffect(() => {
    void session.recentProjects().then(setRecent);
    // In wasm mode there is nothing to list until files have been imported.
    if (!wasm) void load(session.workspaceRoot());
  }, [session, load, wasm]);

  const crumbs = dir.split('/').filter(Boolean);
  const rootParts = session.workspaceRoot().split('/').filter(Boolean);

  const openable = (e: FileEntry | null) => !!e && e.kind === 'file' && (e.fileType === 'project' || e.fileType === 'board' || e.fileType === 'schematic');
  const activate = (e: FileEntry) => {
    if (e.kind === 'dir') void load(e.path);
    else if (openable(e)) onOpen(e.path);
  };

  return (
    <div className="project-screen">
      <div className="recent">
        <div className="section-header">
          <span>Recent projects</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => openDialog('new-project')}>
            New project…
          </button>
        </div>
        <div className="list">
          {recent.map((r) => (
            <div key={r.path} className="recent-item" onClick={() => onOpen(r.path)}>
              <span className="name">{r.name}</span>
              <span className="path" title={r.path}>
                {r.path}
              </span>
              <span className="meta">
                {r.boards} board · {r.sheets} sheet{r.sheets === 1 ? '' : 's'} · opened {fmtDate(r.lastOpened)}
              </span>
            </div>
          ))}
          {recent.length === 0 && <div className="empty-state">No recent projects. Browse the workspace on the right.</div>}
        </div>
        {current && (
          <div className="project-actions">
            <span className="path">
              Session {current.id} · {current.projectName}
            </span>
            <button className="btn sm" onClick={() => useAppStore.getState().openDoc({ kind: 'board', id: 'board', title: `${current.projectName}.kicad_pcb` })}>
              Back to editor
            </button>
          </div>
        )}
      </div>
      {wasm && <ImportProject session={session} onOpen={onOpen} busy={busy} />}
      {!wasm && (
        <div className="browser">
          <div className="breadcrumbs">
            {crumbs.map((c, i) => {
              const path = '/' + crumbs.slice(0, i + 1).join('/');
              const inside = i >= rootParts.length - 1;
              return (
                <span key={path}>
                  {i > 0 && <span className="sep">/</span>}
                  <button disabled={!inside} onClick={() => void load(path)}>
                    {c}
                  </button>
                </span>
              );
            })}
          </div>
          <div className="file-list">
            {error && (
              <div className="empty-state" style={{ color: 'var(--danger)' }}>
                {error}
              </div>
            )}
            {dir !== session.workspaceRoot() && (
              <div className="file-row" onDoubleClick={() => void load(dir.split('/').slice(0, -1).join('/'))} onClick={() => setSelected(null)}>
                <span className="icon">▴</span>
                <span className="muted">..</span>
                <span />
                <span />
              </div>
            )}
            {entries.map((e) => {
              const ic = icon(e);
              return (
                <div key={e.path} className={`file-row${selected?.path === e.path ? ' selected' : ''}`} onClick={() => setSelected(e)} onDoubleClick={() => activate(e)}>
                  <span className={`icon ${ic.cls}`}>{ic.glyph}</span>
                  <span className="truncate" style={e.fileType === 'project' ? { fontWeight: 600 } : undefined}>
                    {e.name}
                  </span>
                  <span className="size">{e.kind === 'file' ? fmtSize(e.size) : ''}</span>
                  <span className="date">{fmtDate(e.modified)}</span>
                </div>
              );
            })}
            {entries.length === 0 && !error && <div className="empty-state">Empty folder.</div>}
          </div>
          <div className="project-actions">
            <span className="path">{selected ? selected.path : dir}</span>
            <button className="btn" disabled={!selected || selected.kind !== 'dir'} onClick={() => selected && void load(selected.path)}>
              Open folder
            </button>
            <button className="btn primary" disabled={busy || !openable(selected)} onClick={() => selected && onOpen(selected.path)}>
              {busy ? 'Connecting…' : selected?.fileType === 'board' ? 'Open board' : selected?.fileType === 'schematic' ? 'Open schematic' : 'Open project'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
