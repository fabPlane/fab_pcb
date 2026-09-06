import { useMemo, useState } from 'react';
import type { NetInfo } from '@/services/types';
import { useEditorDoc, useEditorStore } from '@/state/editorStore';
import { Panel } from './layout/Panel';

export function NetInspector({ storeKey, nets }: { storeKey: string; nets: NetInfo[] }) {
  const doc = useEditorDoc(storeKey);
  const toggle = useEditorStore((s) => s.toggleHighlightNet);
  const clear = useEditorStore((s) => s.setHighlightNets);
  const [filter, setFilter] = useState('');
  const list = useMemo(() => nets.filter((n) => n.name.toLowerCase().includes(filter.toLowerCase())), [nets, filter]);
  return (
    <Panel
      title="Nets"
      actions={
        doc.highlightNets.length > 0 ? (
          <button className="btn ghost sm" onClick={() => clear(storeKey, [])}>
            clear highlight
          </button>
        ) : undefined
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
            const on = doc.highlightNets.includes(n.name);
            return (
              <tr key={n.name} className={on ? 'selected' : ''} onClick={() => toggle(storeKey, n.name)} title="Click to toggle highlight">
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
    </Panel>
  );
}
