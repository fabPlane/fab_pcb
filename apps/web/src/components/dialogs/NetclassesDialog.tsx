import { useEffect, useState } from 'react';
import { useServices } from '@/services';
import type { NetclassInfo } from '@/services/types';
import { useUiStore } from '@/state/uiStore';
import { formatDistance, parseDistance, mm } from '@/lib/units';
import { Dialog } from '../layout/Dialog';

const COLS: { key: keyof NetclassInfo; label: string }[] = [
  { key: 'clearanceNm', label: 'Clearance' },
  { key: 'trackWidthNm', label: 'Track width' },
  { key: 'viaDiameterNm', label: 'Via size' },
  { key: 'viaDrillNm', label: 'Via hole' },
  { key: 'diffPairWidthNm', label: 'DP width' },
  { key: 'diffPairGapNm', label: 'DP gap' },
  { key: 'wireWidthNm', label: 'Wire' },
  { key: 'busWidthNm', label: 'Bus' },
];

export function NetclassesDialog() {
  const { documents } = useServices();
  const open = useUiStore((s) => s.dialog === 'netclasses');
  const openDialog = useUiStore((s) => s.openDialog);
  const units = useUiStore((s) => s.units);
  const [draft, setDraft] = useState<NetclassInfo[]>([]);
  useEffect(() => {
    if (open) setDraft(documents.netclasses().map((n) => ({ ...n })));
  }, [open, documents]);

  const update = (i: number, patch: Partial<NetclassInfo>) => setDraft(draft.map((n, j) => (j === i ? { ...n, ...patch } : n)));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Net Classes"
      size="wide"
      description="Per-class routing defaults. Assignments by pattern are edited in the project file until GetNetClasses/SetNetClasses gain pattern support."
      footer={
        <>
          <button
            className="btn"
            onClick={() =>
              setDraft([
                ...draft,
                {
                  name: `Class${draft.length}`,
                  clearanceNm: mm(0.2),
                  trackWidthNm: mm(0.25),
                  viaDiameterNm: mm(0.8),
                  viaDrillNm: mm(0.4),
                  diffPairWidthNm: mm(0.2),
                  diffPairGapNm: mm(0.25),
                  wireWidthNm: mm(0.15),
                  busWidthNm: mm(0.3),
                  colour: '',
                },
              ])
            }
          >
            Add class
          </button>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await documents.setNetclasses(draft);
              openDialog(null);
            }}
          >
            OK
          </button>
        </>
      }
    >
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              {COLS.map((c) => (
                <th key={c.key} className="num">
                  {c.label} ({units})
                </th>
              ))}
              <th>Colour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.map((n, i) => (
              <tr key={i}>
                <td>
                  <input className="input" value={n.name} disabled={n.name === 'Default'} onChange={(e) => update(i, { name: e.target.value })} style={{ width: 110 }} />
                </td>
                {COLS.map((c) => (
                  <td key={c.key} className="num">
                    <input
                      className="input num"
                      style={{ width: 72 }}
                      key={`${n[c.key]}-${units}`}
                      defaultValue={formatDistance(n[c.key] as number, units)}
                      onBlur={(e) => {
                        const v = parseDistance(e.target.value, units);
                        if (v !== null) update(i, { [c.key]: v } as Partial<NetclassInfo>);
                      }}
                    />
                  </td>
                ))}
                <td>
                  <input
                    type="color"
                    value={n.colour || '#888888'}
                    onChange={(e) => update(i, { colour: e.target.value })}
                    style={{ width: 28, height: 18, padding: 0, border: '1px solid var(--border)', background: 'transparent' }}
                  />
                </td>
                <td>
                  {n.name !== 'Default' && (
                    <button className="btn ghost sm" onClick={() => setDraft(draft.filter((_, j) => j !== i))} title="Remove class">
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
