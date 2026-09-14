import { useEffect, useState } from 'react';
import { useServices } from '@/services';
import type { TextVariable } from '@/services/types';
import { useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

export function TextVariablesDialog() {
  const { documents } = useServices();
  const open = useUiStore((s) => s.dialog === 'text-variables');
  const openDialog = useUiStore((s) => s.openDialog);
  const [draft, setDraft] = useState<TextVariable[]>([]);
  useEffect(() => {
    if (open) setDraft(documents.textVariables().map((v) => ({ ...v })));
  }, [open, documents]);
  const dupes = new Set(draft.map((v) => v.name).filter((n, i, a) => a.indexOf(n) !== i));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Text Variables"
      description="Project-wide substitutions used as ${NAME} in any text. Saved with SetTextVariables."
      footer={
        <>
          <button className="btn" onClick={() => setDraft([...draft, { name: '', value: '' }])}>
            Add variable
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={dupes.size > 0 || draft.some((v) => !v.name.trim())}
            onClick={async () => {
              await documents.setTextVariables(draft);
              openDialog(null);
            }}
          >
            OK
          </button>
        </>
      }
    >
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 200 }}>Variable</th>
            <th>Text substitution</th>
            <th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {draft.map((v, i) => (
            <tr key={i}>
              <td>
                <input
                  className={`input mono${dupes.has(v.name) ? ' invalid' : ''}`}
                  value={v.name}
                  placeholder="NAME"
                  onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') } : x)))}
                />
              </td>
              <td>
                <input className="input" value={v.value} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              </td>
              <td>
                <button className="btn ghost sm" onClick={() => setDraft(draft.filter((_, j) => j !== i))} title="Remove">
                  ×
                </button>
              </td>
            </tr>
          ))}
          {draft.length === 0 && (
            <tr>
              <td colSpan={3} className="faint">
                No text variables defined.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Dialog>
  );
}
