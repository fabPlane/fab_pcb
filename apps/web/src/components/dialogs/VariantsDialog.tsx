import { useEffect, useState } from 'react';
import { useServices } from '@/services';
import type { VariantInfo } from '@/services/types';
import { useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

export function VariantsDialog() {
  const { documents } = useServices();
  const open = useUiStore((s) => s.dialog === 'variants');
  const openDialog = useUiStore((s) => s.openDialog);
  const [draft, setDraft] = useState<VariantInfo[]>([]);
  useEffect(() => {
    if (open) setDraft(documents.variants().map((v) => ({ ...v })));
  }, [open, documents]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Assembly Variants"
      description="Variants override DNP, BOM/position exclusion and field values per symbol or footprint. The current variant drives exports and the DNP rendering."
      footer={
        <>
          <button className="btn" onClick={() => setDraft([...draft, { name: `Variant ${draft.length + 1}`, description: '', current: false }])}>
            Add variant
          </button>
          <button className="btn" disabled={!draft.some((v) => v.current && v.name !== 'Default')} onClick={() => {
            const cur = draft.find((v) => v.current);
            if (!cur) return;
            setDraft([...draft, { ...cur, name: `${cur.name} copy`, current: false }]);
          }}>
            Copy current
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await documents.setVariants(draft);
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
            <th style={{ width: 60 }}>Current</th>
            <th style={{ width: 180 }}>Name</th>
            <th>Description</th>
            <th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {draft.map((v, i) => (
            <tr key={i} className={v.current ? 'selected' : ''}>
              <td style={{ textAlign: 'center' }}>
                <input type="radio" name="variant-current" checked={v.current} onChange={() => setDraft(draft.map((x, j) => ({ ...x, current: j === i })))} />
              </td>
              <td>
                <input className="input" value={v.name} disabled={v.name === 'Default'} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              </td>
              <td>
                <input className="input" value={v.description} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              </td>
              <td>
                {v.name !== 'Default' && (
                  <button className="btn ghost sm" onClick={() => setDraft(draft.filter((_, j) => j !== i).map((x, j, a) => (v.current && j === 0 ? { ...x, current: true } : x)))} title="Delete variant">
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
