// The DRC / ERC severities editor (`Get|SetDrcSeverities`, `Get|SetErcSeverities`): every rule
// type KiCad knows with its severity for the open document. Only the rows the user changed are
// sent, because `SetSeverities` leaves the rest alone.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ruleLabel } from '@/services/kicad/KicadBoardTools';
import { useServices } from '@/services';
import type { RuleSeverityName } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { log } from '@/state/logStore';
import { useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

const CHOICES: RuleSeverityName[] = ['error', 'warning', 'ignore'];

export function SeveritiesDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const { board } = useServices();
  const activeEditor = useAppStore((s) => s.activeEditor);
  const kind: 'drc' | 'erc' = activeEditor === 'schematic' ? 'erc' : 'drc';
  const open = dialog === 'severities';

  const [rows, setRows] = useState<{ rule: string; severity: RuleSeverityName }[]>([]);
  const [changed, setChanged] = useState<Map<string, RuleSeverityName>>(new Map());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!board) return;
    setBusy(true);
    setError(null);
    try {
      setRows(await board.severities(kind));
      setChanged(new Map());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [board, kind]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => ruleLabel(r.rule).includes(q) || r.rule.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);

  const apply = async () => {
    if (!board || changed.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await board.setSeverities(
        kind,
        [...changed.entries()].map(([rule, severity]) => ({ rule, severity })),
      );
      log(`Set${kind.toUpperCase()}Severities: ${changed.size} rule(s)`);
      useAppStore.getState().notify(`${changed.size} ${kind.toUpperCase()} severity change(s) applied`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title={`${kind.toUpperCase()} severities`}
      description={`How ${kind === 'drc' ? 'design' : 'electrical'} rule violations are reported for this project. Ignored rules are not checked at all.`}
      size="wide"
      noPad
      footer={
        <>
          <span className="muted">{changed.size ? `${changed.size} change(s)` : `${rows.length} rules`}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => openDialog(null)}>
            Close
          </button>
          <button className="btn primary" data-testid="severities-apply" disabled={busy || changed.size === 0} onClick={() => void apply()}>
            Apply
          </button>
        </>
      }
    >
      {!board ? (
        <div className="empty-state">The severities editor needs the KiCad services.</div>
      ) : (
        <div className="severities">
          <div className="filter-bar">
            <input className="input" placeholder="Filter rules" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} aria-label="Filter rules" />
          </div>
          {error && (
            <div className="empty-state" style={{ color: 'var(--danger)' }} role="alert">
              {error}
            </div>
          )}
          <div className="grid-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th style={{ width: 140 }}>Severity</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const v = changed.get(r.rule) ?? r.severity;
                  return (
                    <tr key={r.rule} className={changed.has(r.rule) ? 'edited' : ''}>
                      <td title={r.rule}>{ruleLabel(r.rule)}</td>
                      <td>
                        <select
                          className="select"
                          data-rule={r.rule}
                          value={v}
                          onChange={(e) => {
                            const next = e.target.value as RuleSeverityName;
                            setChanged((prev) => {
                              const m = new Map(prev);
                              if (next === r.severity) m.delete(r.rule);
                              else m.set(r.rule, next);
                              return m;
                            });
                          }}
                        >
                          {CHOICES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={2} className="faint">
                      {busy ? 'Reading severities…' : 'No rule matches.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  );
}
