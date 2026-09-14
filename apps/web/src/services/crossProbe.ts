// Cross-probing between the board and the schematic by reference designator: selecting a
// footprint selects the symbol with the same reference on its sheet (and vice versa), so the
// other editor tab shows it highlighted when switched to. KiCad's SyncSelection / FocusOnItem
// are GUI-only, hence the client-side match.

import type { StoredItem } from '@/contracts';
import { getCanvasHost } from '@/canvas/CanvasSlot';
import { itemAnchor, referenceOf } from '@/lib/geometry';
import type { Services, SheetInfo } from '@/services/types';
import { storeKeyFor } from '@/state/active';
import { useAppStore } from '@/state/appStore';
import { useEditorStore } from '@/state/editorStore';
import { log } from '@/state/logStore';

const refOf = referenceOf;

function flatten(sheets: SheetInfo[]): SheetInfo[] {
  const out: SheetInfo[] = [];
  const walk = (s: SheetInfo) => {
    out.push(s);
    s.children.forEach(walk);
  };
  sheets.forEach(walk);
  return out;
}

export interface CrossProbeHit {
  kind: 'board' | 'schematic';
  storeKey: string;
  sheetPath?: string;
  ids: string[];
  references: string[];
}

/** Finds the counterpart(s) of the current selection in the other document family. */
export function findCounterpart(services: Services, from: { kind: 'board' | 'schematic'; storeKey: string; items: StoredItem[] }): CrossProbeHit | null {
  const refs = from.items
    .filter((i) => i.type === (from.kind === 'board' ? 'KOT_PCB_FOOTPRINT' : 'KOT_SCH_SYMBOL'))
    .map(refOf)
    .filter(Boolean);
  if (!refs.length) return null;
  const want = new Set(refs);
  if (from.kind === 'board') {
    for (const sheet of flatten(services.documents.sheets())) {
      const store = services.documents.sheet(sheet.path);
      if (!store) continue;
      const ids = [...store.byType('KOT_SCH_SYMBOL')].filter((s) => want.has(refOf(s))).map((s) => s.id);
      if (ids.length) return { kind: 'schematic', storeKey: storeKeyFor('schematic', sheet.path), sheetPath: sheet.path, ids, references: refs };
    }
    return null;
  }
  const board = services.documents.board();
  if (!board) return null;
  const ids = [...board.byType('KOT_PCB_FOOTPRINT')].filter((f) => want.has(refOf(f))).map((f) => f.id);
  return ids.length ? { kind: 'board', storeKey: 'board', ids, references: refs } : null;
}

let syncing = false;

/** Mirrors the active editor's selection into the other document; `jump` also switches tabs and centres the view. */
export function crossProbeSelection(services: Services, opts: { jump?: boolean } = {}): CrossProbeHit | null {
  const app = useAppStore.getState();
  const ed = useEditorStore.getState();
  let from: { kind: 'board' | 'schematic'; storeKey: string; items: StoredItem[] } | null = null;
  if (app.activeEditor === 'board') {
    const store = services.documents.board();
    if (store) from = { kind: 'board', storeKey: 'board', items: (ed.docs.board?.selection ?? []).map((id) => store.get(id)).filter((x): x is StoredItem => !!x) };
  } else if (app.activeEditor === 'schematic') {
    const key = storeKeyFor('schematic', app.activeSheet);
    const store = services.documents.sheet(app.activeSheet);
    if (store) from = { kind: 'schematic', storeKey: key, items: (ed.docs[key]?.selection ?? []).map((id) => store.get(id)).filter((x): x is StoredItem => !!x) };
  }
  if (!from) return null;
  const hit = findCounterpart(services, from);
  if (!hit) return null;
  syncing = true;
  try {
    const cur = ed.docs[hit.storeKey]?.selection ?? [];
    if (cur.length !== hit.ids.length || cur.some((id, i) => id !== hit.ids[i])) {
      ed.ensure(hit.storeKey, hit.kind);
      ed.setSelection(hit.storeKey, hit.ids);
    }
    if (opts.jump) {
      if (hit.kind === 'board') app.openDoc({ kind: 'board', id: 'board', title: `${app.session?.projectName ?? 'board'}.kicad_pcb` });
      else {
        const sheet = flatten(services.documents.sheets()).find((s) => s.path === hit.sheetPath);
        app.openDoc({ kind: 'schematic', id: hit.sheetPath!, title: sheet?.file ?? hit.sheetPath! });
      }
      const store = hit.kind === 'board' ? services.documents.board() : services.documents.sheet(hit.sheetPath!);
      const first = store?.get(hit.ids[0]!);
      const anchor = first ? itemAnchor(first) : null;
      if (anchor) setTimeout(() => getCanvasHost(hit.storeKey)?.setCamera({ x: anchor.x, y: anchor.y }), 50);
    }
    log(`cross-probe: ${hit.references.join(', ')} → ${hit.kind}${hit.sheetPath ? ` ${hit.sheetPath}` : ''} (${hit.ids.length} item${hit.ids.length === 1 ? '' : 's'})`);
  } finally {
    syncing = false;
  }
  return hit;
}

/** Keeps the two selections in step automatically (footprint ↔ symbol by reference). */
export function installCrossProbe(services: Services): () => void {
  let last: Record<string, string[]> = {};
  return useEditorStore.subscribe((state) => {
    if (syncing) return;
    const app = useAppStore.getState();
    const key = app.activeEditor === 'board' ? 'board' : app.activeEditor === 'schematic' ? storeKeyFor('schematic', app.activeSheet) : null;
    if (!key) return;
    const sel = state.docs[key]?.selection ?? [];
    const prev = last[key] ?? [];
    if (sel.length === prev.length && sel.every((id, i) => id === prev[i])) return;
    last = { ...last, [key]: sel };
    if (sel.length === 0) return;
    crossProbeSelection(services);
  });
}
