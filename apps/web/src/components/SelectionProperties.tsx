// Bridges the editor selection to the schema-driven PropertiesPanel: one selected item
// edits its proto through an undoable transaction; several show a summary; none shows
// document statistics.

import { useEffect, useMemo, useState } from 'react';
import type { DocumentKind, ItemStore, StoredItem } from '@/contracts';
import { useServices } from '@/services';
import { useEditorDoc, useEditorStore } from '@/state/editorStore';
import { useUiStore } from '@/state/uiStore';
import type { Patch } from '@/lib/patch';
import { layerDisplayName } from '@/lib/enums';
import { Panel } from './layout/Panel';
import { PropertiesPanel } from './properties/PropertiesPanel';
import { humanize, typeLabel } from './properties/schema';

function useStoreRevision(store: ItemStore): number {
  const [rev, setRev] = useState(store.revision);
  useEffect(() => store.subscribe((d) => setRev(d.revision)), [store]);
  return rev;
}

export function SelectionProperties({ storeKey, store, kind }: { storeKey: string; store: ItemStore; kind: DocumentKind }) {
  const { commands } = useServices();
  const doc = useEditorDoc(storeKey);
  const setSelection = useEditorStore((s) => s.setSelection);
  const units = useUiStore((s) => s.units);
  const setUnits = useUiStore((s) => s.setUnits);
  const rev = useStoreRevision(store);
  const items = useMemo(() => doc.selection.map((id) => store.get(id)).filter((x): x is StoredItem => !!x), [doc.selection, store, rev]);

  if (items.length === 0) {
    const counts = new Map<string, number>();
    for (const it of store.all()) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
    return (
      <Panel title="Properties">
        <div className="empty-state" style={{ textAlign: 'left' }}>
          <div style={{ marginBottom: 8 }}>Nothing selected. Click an item on the canvas, or pick one from the list below.</div>
          <table className="table">
            <tbody>
              {[...counts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([type, n]) => (
                  <tr key={type} onClick={() => setSelection(storeKey, [...store.byType(type)].map((i) => i.id))} title="Select all of this type">
                    <td>{typeLabel(type)}</td>
                    <td className="num">{n}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="faint" style={{ marginTop: 8 }}>
            {kind === 'board' ? 'Board' : kind === 'schematic' ? 'Sheet' : 'Footprint'} revision {store.revision}
          </div>
        </div>
      </Panel>
    );
  }

  if (items.length > 1) {
    return (
      <Panel title={`Properties · ${items.length} items`} actions={<button className="btn ghost sm" onClick={() => setSelection(storeKey, [])}>clear</button>}>
        <div className="rows">
          {items.map((it) => (
            <div key={it.id} className="row" onClick={() => setSelection(storeKey, [it.id])} title="Click to edit this item alone">
              <span style={{ width: 90 }}>{typeLabel(it.type)}</span>
              <span className="mono truncate" style={{ flex: 1 }}>
                {itemSummary(it)}
              </span>
              {it.layer && <span className="faint">{layerDisplayName(it.layer)}</span>}
            </div>
          ))}
        </div>
      </Panel>
    );
  }

  const item = items[0]!;
  const onPatch = (patch: Patch) => {
    const field = patch.path.map((p) => (typeof p === 'number' ? `[${p}]` : humanize(String(p)).toLowerCase())).join(' › ');
    void commands.run(store, `Edit ${typeLabel(item.type).toLowerCase()} ${field}`, (tx) => tx.update(item.id, [patch]));
  };
  return (
    <Panel
      title="Properties"
      actions={
        item.parent ? (
          <button className="btn ghost sm" onClick={() => setSelection(storeKey, [item.parent!])} title="Select the parent item">
            parent
          </button>
        ) : undefined
      }
    >
      <PropertiesPanel value={item.proto as Record<string, unknown>} typeName={item.type} id={item.id} units={units} onUnitsChange={setUnits} onPatch={onPatch} />
    </Panel>
  );
}

export function itemSummary(it: StoredItem): string {
  const p = it.proto as Record<string, any>;
  switch (it.type) {
    case 'KOT_PCB_FOOTPRINT':
      return `${p.referenceField?.text?.text ?? ''} ${p.valueField?.text?.text ?? ''}`.trim();
    case 'KOT_PCB_PAD':
      return `pad ${p.number ?? ''}${it.net ? ` [${it.net}]` : ''}`;
    case 'KOT_PCB_TRACE':
    case 'KOT_PCB_ARC':
    case 'KOT_PCB_VIA':
      return it.net ? `[${it.net}]` : '';
    case 'KOT_PCB_ZONE':
      return p.name ?? '';
    case 'KOT_PCB_TEXT':
    case 'KOT_SCH_TEXT':
      return p.text?.text ?? '';
    case 'KOT_SCH_SYMBOL':
      return `${p.referenceField?.text?.text ?? ''} ${p.valueField?.text?.text ?? ''}`.trim();
    case 'KOT_SCH_LOCAL_LABEL':
    case 'KOT_SCH_GLOBAL_LABEL':
    case 'KOT_SCH_HIER_LABEL':
      return p.text?.text ?? '';
    case 'KOT_SCH_SHEET':
      return p.sheetName?.text?.text ?? '';
    default:
      return it.id.slice(0, 8);
  }
}
