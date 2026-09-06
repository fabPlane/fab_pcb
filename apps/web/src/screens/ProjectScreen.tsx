import { useCallback, useEffect, useState } from 'react';
import { useServices } from '@/services';
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

  useEffect(() => {
    void session.recentProjects().then(setRecent);
    void load(session.workspaceRoot());
  }, [session, load]);

  const crumbs = dir.split('/').filter(Boolean);
  const rootParts = session.workspaceRoot().split('/').filter(Boolean);

  const activate = (e: FileEntry) => {
    if (e.kind === 'dir') void load(e.path);
    else if (e.fileType === 'project') onOpen(e.path);
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
            <span className="path">Session {current.id} · {current.projectName}</span>
            <button className="btn sm" onClick={() => useAppStore.getState().openDoc({ kind: 'board', id: 'board', title: `${current.projectName}.kicad_pcb` })}>
              Back to editor
            </button>
          </div>
        )}
      </div>
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
          {error && <div className="empty-state" style={{ color: 'var(--danger)' }}>{error}</div>}
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
          <button className="btn primary" disabled={busy || !selected || selected.fileType !== 'project'} onClick={() => selected && onOpen(selected.path)}>
            {busy ? 'Connecting…' : 'Open project'}
          </button>
        </div>
      </div>
    </div>
  );
}
