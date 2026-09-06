import { useServices } from '@/services';
import { useHistoryStore } from '@/state/historyStore';

export function HistoryPanel() {
  const { commands } = useServices();
  const undo = useHistoryStore((s) => s.undo);
  const redo = useHistoryStore((s) => s.redo);
  return (
    <div className="panel">
      <div className="filter-bar">
        <button className="btn sm" disabled={undo.length === 0} onClick={() => void commands.undo()}>
          Undo
        </button>
        <button className="btn sm" disabled={redo.length === 0} onClick={() => void commands.redo()}>
          Redo
        </button>
        <span className="muted">
          {undo.length} undoable · {redo.length} redoable · client-side history (server undo is gap G10)
        </span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => commands.clearHistory()} disabled={undo.length + redo.length === 0}>
          clear
        </button>
      </div>
      <div className="panel-body">
        {undo.length + redo.length === 0 && <div className="empty-state">Edits made through the properties panel, move, rotate, flip and delete appear here.</div>}
        {[...redo].reverse().map((e, i) => (
          <div key={e.id} className="history-row redo">
            <span className="idx">+{redo.length - i}</span>
            <span>{e.message}</span>
            <span className="ops">{describeOps(e.forward)}</span>
          </div>
        ))}
        {[...undo].reverse().map((e, i) => (
          <div key={e.id} className="history-row">
            <span className="idx">{undo.length - i}</span>
            <span>{e.message}</span>
            <span className="ops">{describeOps(e.forward)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function describeOps(ops: { kind: string }[]): string {
  const c = { create: 0, update: 0, delete: 0 };
  for (const o of ops) c[o.kind as keyof typeof c]++;
  return [c.create && `+${c.create}`, c.update && `~${c.update}`, c.delete && `-${c.delete}`].filter(Boolean).join(' ');
}
