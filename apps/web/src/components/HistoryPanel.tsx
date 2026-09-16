// Undo history. Two modes, and the panel says which one is live:
//
//   server  — KiCad owns the stack (`Undo` / `Redo` / `GetUndoStack`, KiCad >= 11.0). Undoing
//             there also reverts what never passed through a client commit: zone fills,
//             connectivity, `SetBoardOrigin`, the netlist updater. The rows are KiCad's own
//             stack entries, with the client that made each commit.
//   client  — the pre-11.0 fallback: the app's `CommandService` replays the recorded inverse ops
//             as new commits, so only what the store saw can be undone.

import { useCallback, useEffect, useState } from 'react';
import { useServices, useServiceVersion } from '@/services';
import type { ServerUndoStacks } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useHistoryStore } from '@/state/historyStore';

export function HistoryPanel() {
  const { commands, undo: undoService } = useServices();
  const clientUndo = useHistoryStore((s) => s.undo);
  const clientRedo = useHistoryStore((s) => s.redo);
  const activeEditor = useAppStore((s) => s.activeEditor);
  const subscribe = useCallback((cb: () => void) => (undoService ? undoService.onChange(cb) : () => undefined), [undoService]);
  const version = useServiceVersion(subscribe);
  const [mode, setMode] = useState<'server' | 'client' | 'probing'>(undoService?.cachedMode() ?? 'probing');
  const [stacks, setStacks] = useState<ServerUndoStacks>({ undo: [], redo: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!undoService) {
      setMode('client');
      return;
    }
    let live = true;
    void (async () => {
      const m = await undoService.mode();
      if (!live) return;
      setMode(m);
      if (m === 'server') setStacks(await undoService.stacks().catch(() => ({ undo: [], redo: [] })));
    })();
    return () => {
      live = false;
    };
  }, [undoService, version, activeEditor, clientUndo.length, clientRedo.length]);

  const server = mode === 'server';
  const undoRows = server ? stacks.undo : clientUndo.map((e) => ({ description: e.message, clientName: '', itemCount: e.forward.length }));
  const redoRows = server ? stacks.redo : clientRedo.map((e) => ({ description: e.message, clientName: '', itemCount: e.forward.length }));

  const step = async (dir: 'undo' | 'redo') => {
    setBusy(true);
    try {
      if (undoService) await undoService[dir]();
      else await commands[dir]();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="filter-bar">
        <button className="btn sm" data-testid="history-undo" disabled={busy || undoRows.length === 0} onClick={() => void step('undo')}>
          Undo
        </button>
        <button className="btn sm" data-testid="history-redo" disabled={busy || redoRows.length === 0} onClick={() => void step('redo')}>
          Redo
        </button>
        <span
          className={`chip on undo-mode`}
          data-testid="undo-mode"
          title={
            server
              ? 'KiCad owns the undo stack; undo also reverts zone fills, connectivity and edits made outside a commit'
              : 'KiCad does not advertise Undo: the app replays the recorded inverse operations as new commits'
          }
        >
          {mode === 'probing' ? 'checking…' : server ? 'server undo (KiCad)' : 'client undo'}
        </span>
        <span className="muted">
          {undoRows.length} undoable · {redoRows.length} redoable
        </span>
        <span className="spacer" />
        <button
          className="btn ghost sm"
          onClick={() => commands.clearHistory()}
          disabled={clientUndo.length + clientRedo.length === 0}
          title="Clears the app's own history; KiCad's stack is untouched"
        >
          clear
        </button>
      </div>
      <div className="panel-body">
        {undoRows.length + redoRows.length === 0 && (
          <div className="empty-state">
            {server ? "KiCad's undo stack is empty — edits made through the editor will appear here." : 'Edits made through the properties panel, move, rotate, flip and delete appear here.'}
          </div>
        )}
        {[...redoRows].reverse().map((e, i) => (
          <div key={`redo-${i}`} className="history-row redo">
            <span className="idx">+{redoRows.length - i}</span>
            <span>{e.description || '(unnamed)'}</span>
            <span className="ops">
              {e.itemCount ? `${e.itemCount} item${e.itemCount === 1 ? '' : 's'}` : ''}
              {e.clientName ? ` · ${e.clientName}` : ''}
            </span>
          </div>
        ))}
        {[...undoRows].reverse().map((e, i) => (
          <div key={`undo-${i}`} className="history-row">
            <span className="idx">{undoRows.length - i}</span>
            <span>{e.description || '(unnamed)'}</span>
            <span className="ops">
              {e.itemCount ? `${e.itemCount} item${e.itemCount === 1 ? '' : 's'}` : ''}
              {e.clientName ? ` · ${e.clientName}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
