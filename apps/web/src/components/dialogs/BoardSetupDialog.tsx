import { useEffect, useState } from 'react';
import { useServices } from '@/services';
import type { BoardSetup, DesignRules, StackupLayer } from '@/services/types';
import { useUiStore } from '@/state/uiStore';
import { formatDistance, parseDistance } from '@/lib/units';
import { Dialog } from '../layout/Dialog';

type Page = 'stackup' | 'rules' | 'custom' | 'origin';

const SEVERITIES = [
  { value: 0, label: 'default' },
  { value: 1, label: 'warning' },
  { value: 2, label: 'error' },
  { value: 3, label: 'exclusion' },
  { value: 4, label: 'ignore' },
];

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(structuredClone(documents.boardSetup()));
      setError(null);
    }
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
          {error ? (
            <span className="muted" role="alert" style={{ color: 'var(--danger)' }}>
              {error}
            </span>
          ) : (
            <span className="muted">Changed pages are written with SetBoardDesignRules / UpdateBoardStackup / SetCustomDesignRules / SetBoardOrigin on OK.</span>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            data-testid="board-setup-ok"
            onClick={async () => {
              setBusy(true);
              try {
                await documents.setBoardSetup(draft);
                openDialog(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
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
          <button className={page === 'origin' ? 'active' : ''} onClick={() => setPage('origin')}>
            Origins
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
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p className="dialog-desc">
              Custom design rules as KiCad serves them (GetCustomDesignRules). Name, condition, comment and severity are written back with SetCustomDesignRules; constraints are shown read-only in the
              .kicad_dru rendering below.
              {draft.customRulesError && <span style={{ color: 'var(--danger)' }}> Server parse error: {draft.customRulesError}</span>}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Condition</th>
                  <th>Severity</th>
                  <th>Comment</th>
                  <th className="num">Constraints</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.customRuleList.map((r, i) => {
                  const patch = (p: Partial<typeof r>) => setDraft({ ...draft, customRuleList: draft.customRuleList.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                  return (
                    <tr key={i}>
                      <td>
                        <input className="input" value={r.name} onChange={(e) => patch({ name: e.target.value })} data-rule={`name-${i}`} />
                      </td>
                      <td>
                        <input className="input mono" value={r.condition} onChange={(e) => patch({ condition: e.target.value })} data-rule={`condition-${i}`} />
                      </td>
                      <td>
                        <select className="select" value={r.severity} onChange={(e) => patch({ severity: Number(e.target.value) })}>
                          {SEVERITIES.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input className="input" value={r.comments} onChange={(e) => patch({ comments: e.target.value })} />
                      </td>
                      <td className="num">{r.constraints}</td>
                      <td>
                        <button className="btn ghost sm" title="Remove rule" onClick={() => setDraft({ ...draft, customRuleList: draft.customRuleList.filter((_x, j) => j !== i) })}>
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {draft.customRuleList.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No custom rules. New rules are authored in the .kicad_dru file (the API takes structured constraints only).
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <textarea className="textarea mono" style={{ flex: 1, minHeight: 160 }} value={draft.customRules} readOnly spellCheck={false} />
          </section>
        )}
        {page === 'origin' && (
          <section>
            <p className="dialog-desc">Grid origin and drill/place file origin (GetBoardOrigin / SetBoardOrigin).</p>
            <div className="form-grid">
              <label>Grid origin X</label>
              {dist(draft.origin.grid.x, (nm) => setDraft({ ...draft, origin: { ...draft.origin, grid: { ...draft.origin.grid, x: nm } } }))}
              <label>Grid origin Y</label>
              {dist(draft.origin.grid.y, (nm) => setDraft({ ...draft, origin: { ...draft.origin, grid: { ...draft.origin.grid, y: nm } } }))}
              <label>Drill/place origin X</label>
              {dist(draft.origin.drill.x, (nm) => setDraft({ ...draft, origin: { ...draft.origin, drill: { ...draft.origin.drill, x: nm } } }))}
              <label>Drill/place origin Y</label>
              {dist(draft.origin.drill.y, (nm) => setDraft({ ...draft, origin: { ...draft.origin, drill: { ...draft.origin.drill, y: nm } } }))}
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
