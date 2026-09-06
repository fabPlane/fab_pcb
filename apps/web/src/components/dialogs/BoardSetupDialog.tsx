import { useEffect, useState } from 'react';
import { useServices } from '@/services';
import type { BoardSetup, DesignRules, StackupLayer } from '@/services/types';
import { useUiStore } from '@/state/uiStore';
import { formatDistance, parseDistance } from '@/lib/units';
import { Dialog } from '../layout/Dialog';

type Page = 'stackup' | 'rules' | 'custom';

const RULE_LABELS: { key: keyof DesignRules; label: string; help: string }[] = [
  { key: 'minClearanceNm', label: 'Minimum clearance', help: 'Copper to copper, any net' },
  { key: 'minTrackWidthNm', label: 'Minimum track width', help: '' },
  { key: 'minViaDiameterNm', label: 'Minimum via diameter', help: 'Annular ring outer diameter' },
  { key: 'minViaDrillNm', label: 'Minimum via hole', help: '' },
  { key: 'minAnnularWidthNm', label: 'Minimum annular width', help: '' },
  { key: 'minHoleToHoleNm', label: 'Hole to hole clearance', help: '' },
  { key: 'copperToEdgeNm', label: 'Copper to edge clearance', help: '' },
  { key: 'minTextHeightNm', label: 'Minimum text height', help: 'Silkscreen' },
  { key: 'minTextThicknessNm', label: 'Minimum text thickness', help: 'Silkscreen' },
];

export function BoardSetupDialog() {
  const { documents } = useServices();
  const open = useUiStore((s) => s.dialog === 'board-setup');
  const openDialog = useUiStore((s) => s.openDialog);
  const units = useUiStore((s) => s.units);
  const [page, setPage] = useState<Page>('stackup');
  const [draft, setDraft] = useState<BoardSetup>(() => documents.boardSetup());
  useEffect(() => {
    if (open) setDraft(structuredClone(documents.boardSetup()));
  }, [open, documents]);

  const dist = (nm: number, onChange: (nm: number) => void) => (
    <span className="field-with-unit">
      <input
        className="input num"
        defaultValue={formatDistance(nm, units)}
        key={`${nm}-${units}`}
        onBlur={(e) => {
          const v = parseDistance(e.target.value, units);
          if (v !== null && v !== nm) onChange(v);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="unit">{units}</span>
    </span>
  );

  const updateStackup = (i: number, patch: Partial<StackupLayer>) => setDraft({ ...draft, stackup: draft.stackup.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const total = draft.stackup.reduce((a, l) => a + l.thicknessNm, 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Board Setup"
      size="wide"
      noPad
      footer={
        <>
          <span className="muted">Writes GetBoardStackup / SetBoardDesignRules / SetCustomRules on OK.</span>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await documents.setBoardSetup(draft);
              openDialog(null);
            }}
          >
            OK
          </button>
        </>
      }
    >
      <div className="dialog-sidebar">
        <nav>
          <button className={page === 'stackup' ? 'active' : ''} onClick={() => setPage('stackup')}>
            Physical stackup
          </button>
          <button className={page === 'rules' ? 'active' : ''} onClick={() => setPage('rules')}>
            Constraints
          </button>
          <button className={page === 'custom' ? 'active' : ''} onClick={() => setPage('custom')}>
            Custom rules
          </button>
        </nav>
        {page === 'stackup' && (
          <section>
            <div className="form-grid" style={{ marginBottom: 12 }}>
              <label>Copper layers</label>
              <select className="select" value={draft.copperLayers} onChange={(e) => setDraft({ ...draft, copperLayers: Number(e.target.value) })} style={{ width: 120 }}>
                {[2, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <label>Board thickness</label>
              {dist(draft.thicknessNm, (nm) => setDraft({ ...draft, thicknessNm: nm }))}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th>Type</th>
                  <th>Material</th>
                  <th className="num">Thickness ({units})</th>
                </tr>
              </thead>
              <tbody>
                {draft.stackup.map((l, i) => (
                  <tr key={l.layer}>
                    <td>{l.name}</td>
                    <td className="muted">{l.type}</td>
                    <td>
                      <input className="input" value={l.material} onChange={(e) => updateStackup(i, { material: e.target.value })} />
                    </td>
                    <td className="num">{dist(l.thicknessNm, (nm) => updateStackup(i, { thicknessNm: nm }))}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="muted">
                    Sum of layer thicknesses
                  </td>
                  <td className="num">
                    {formatDistance(total, units)} {units}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        )}
        {page === 'rules' && (
          <section>
            <p className="dialog-desc">Design-rule minimums. Netclass values (Tools → Net classes) take precedence where they are larger.</p>
            <div className="form-grid">
              {RULE_LABELS.map((r) => (
                <div key={r.key} style={{ display: 'contents' }}>
                  <label>{r.label}</label>
                  {dist(draft.rules[r.key], (nm) => setDraft({ ...draft, rules: { ...draft.rules, [r.key]: nm } }))}
                  {r.help && <div className="help">{r.help}</div>}
                </div>
              ))}
            </div>
          </section>
        )}
        {page === 'custom' && (
          <section style={{ display: 'flex', flexDirection: 'column' }}>
            <p className="dialog-desc">Custom design rules in the .kicad_dru s-expression syntax. Sent with SetCustomRules; syntax errors are reported by the server on DRC.</p>
            <textarea className="textarea" style={{ flex: 1, minHeight: 240 }} value={draft.customRules} onChange={(e) => setDraft({ ...draft, customRules: e.target.value })} spellCheck={false} />
          </section>
        )}
      </div>
    </Dialog>
  );
}
