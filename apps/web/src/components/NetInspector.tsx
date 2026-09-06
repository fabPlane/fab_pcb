// Nets of the board: highlight toggles, and — when the KiCad services are present — the measured
// copper length of the highlighted nets from `GetNetLengths`, with sortable columns.
//
// Lengths are asked for on demand rather than on every store change: `GetNetLengths` walks the
// connectivity, so it is not something to run per keystroke.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServices } from '@/services';
import type { NetInfo, NetLengthRow } from '@/services/types';
import { useEditorDoc, useEditorStore } from '@/state/editorStore';
import { useUiStore } from '@/state/uiStore';
import { formatDistance } from '@/lib/units';
import { layerDisplayName } from '@/lib/enums';
import { Panel } from './layout/Panel';

type SortKey = 'net' | 'netclass' | 'totalNm' | 'padCount' | 'viaCount' | 'delayPs';

const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: 'net', label: 'Net' },
  { key: 'netclass', label: 'Class' },
  { key: 'totalNm', label: 'Length', num: true },
  { key: 'padCount', label: 'Pads', num: true },
  { key: 'viaCount', label: 'Vias', num: true },
  { key: 'delayPs', label: 'Delay ps', num: true },
];

export function NetInspector({ storeKey, nets }: { storeKey: string; nets: NetInfo[] }) {
  const { board } = useServices();
  const doc = useEditorDoc(storeKey);
  const toggle = useEditorStore((s) => s.toggleHighlightNet);
  const clear = useEditorStore((s) => s.setHighlightNets);
  const units = useUiStore((s) => s.units);
  const [filter, setFilter] = useState('');
  const [lengths, setLengths] = useState<NetLengthRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'totalNm', dir: -1 });

  const highlighted = doc.highlightNets;
  const highlightKey = highlighted.join('|');
  const list = useMemo(() => nets.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase())), [nets, filter]);

  const measure = useCallback(
    async (only: string[]) => {
      if (!board) return;
      setBusy(true);
      setError(null);
      try {
        setLengths(await board.netLengths(only));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLengths([]);
      } finally {
        setBusy(false);
      }
    },
    [board],
  );

  // Measure whatever is highlighted; nothing highlighted measures every net.
  useEffect(() => {
    if (!board) return;
    void measure(highlightKey ? highlightKey.split('|') : []);
  }, [board, measure, highlightKey]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q ? lengths.filter((l) => l.net.toLowerCase().includes(q)) : lengths;
    return [...base].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return c * sort.dir;
    });
  }, [lengths, filter, sort]);

  const header = (c: (typeof COLUMNS)[number]) => (
    <th
      key={c.key}
      className={c.num ? 'num sortable' : 'sortable'}
      data-sort={c.key}
      aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? ((s.dir * -1) as 1 | -1) : c.num ? -1 : 1 }))}
    >
      {c.label}
      {sort.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <Panel
      title="Nets"
      actions={
        <>
          {board && (
            <button className="btn ghost sm" onClick={() => void measure(highlighted)} disabled={busy} title="Re-read GetNetLengths">
              {busy ? '…' : 'measure'}
            </button>
          )}
          {highlighted.length > 0 && (
            <button className="btn ghost sm" onClick={() => clear(storeKey, [])}>
              clear highlight
            </button>
          )}
        </>
      }
    >
      <div className="filter-bar">
        <input className="input" placeholder="Filter nets" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 18 }}></th>
            <th>Net</th>
            <th>Class</th>
            <th className="num">Items</th>
          </tr>
        </thead>
        <tbody>
          {list.map((n) => {
            const on = highlighted.includes(n.name);
            return (
              <tr key={n.name} className={on ? 'selected' : ''} onClick={() => toggle(storeKey, n.name)} title="Click to toggle highlight (and measure)" data-net={n.name}>
                <td>{on ? '◉' : '○'}</td>
                <td className="mono">{n.name}</td>
                <td className="muted">{n.netclass}</td>
                <td className="num">{n.items}</td>
              </tr>
            );
          })}
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="faint">
                No nets match “{filter}”.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {board && (
        <div className="net-lengths" data-testid="net-lengths">
          <div className="section-head">{highlighted.length ? `Lengths · ${highlighted.length} highlighted net(s)` : 'Lengths · all nets'}</div>
          {error && (
            <div className="empty-state" style={{ color: 'var(--danger)' }} role="alert">
              {error}
            </div>
          )}
          <table className="table">
            <thead>
              <tr>{COLUMNS.map(header)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.net}
                  className={highlighted.includes(r.net) ? 'selected' : ''}
                  onClick={() => toggle(storeKey, r.net)}
                  data-length-net={r.net}
                  title={r.byLayer.map((l) => `${layerDisplayName(l.layer)}: ${formatDistance(l.lengthNm, units, 3)} ${units}`).join('\n')}
                >
                  <td className="mono">{r.net}</td>
                  <td className="muted">{r.netclass}</td>
                  <td className="num">
                    {formatDistance(r.totalNm, units, 3)} {units}
                  </td>
                  <td className="num">{r.padCount}</td>
                  <td className="num">{r.viaCount}</td>
                  <td className="num">{r.delayPs || '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="faint">
                    {busy ? 'Measuring…' : 'No routed copper on these nets.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
