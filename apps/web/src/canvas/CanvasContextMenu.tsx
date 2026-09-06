// Right-click menu on the canvas: the editing commands that apply to the item under the
// pointer (or the selection), run through the command registry so shortcuts stay in sync.

import { useEffect, useRef } from 'react';
import type { DocumentKind, ItemStore } from '@/contracts';
import { effectiveBinding, getCommand, type CommandContext } from '@/commands/registry';
import { formatBinding } from '@/lib/keys';
import { useAppStore } from '@/state/appStore';
import { useKeymapStore } from '@/state/keymapStore';
import { typeLabel } from '@/components/properties/schema';

export interface ContextMenuState {
  x: number;
  y: number;
  /** picked store item id, or null on empty canvas */
  target: string | null;
}

function entriesFor(kind: DocumentKind, type: string | undefined): (string | '-')[] {
  if (!type) {
    return kind === 'schematic'
      ? ['edit.paste', '-', 'schematic.wire', 'schematic.bus', 'schematic.label', 'schematic.placeSymbol', 'schematic.sheet', '-', 'view.zoomFit']
      : ['edit.paste', '-', 'board.route', 'board.placeVia', 'board.placeFootprint', 'board.drawZone', 'board.placeText', '-', 'view.zoomFit'];
  }
  const common = ['edit.move', 'edit.rotateCcw', 'edit.rotateCw', 'edit.rotateBy', '-', 'edit.copy', 'edit.duplicate', 'edit.delete', '-', 'edit.properties'];
  if (type === 'KOT_PCB_FOOTPRINT') return ['board.openFootprintEditor', 'edit.flip', 'edit.setLayer', '-', ...common, 'inspect.crossProbe'];
  if (type === 'KOT_PCB_TRACE' || type === 'KOT_PCB_VIA' || type === 'KOT_PCB_ARC' || type === 'KOT_PCB_ZONE') return ['edit.setNet', 'edit.setLayer', 'inspect.highlightNet', '-', ...common];
  if (type.startsWith('KOT_PCB_')) return ['edit.setLayer', 'edit.flip', '-', ...common];
  if (type === 'KOT_SCH_SYMBOL') return ['inspect.crossProbe', '-', ...common];
  if (type === 'KOT_SCH_SHEET') return ['schematic.enterSheet', '-', ...common];
  return common;
}

export function CanvasContextMenu({ state, storeKey, store, kind, onClose }: { state: ContextMenuState; storeKey: string; store: ItemStore; kind: DocumentKind; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const editor = useAppStore((s) => s.activeEditor);
  const overrides = useKeymapStore((s) => s.overrides);
  void storeKey;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const item = state.target ? store.get(state.target) : undefined;
  const ctx: CommandContext = { editor };
  const entries = entriesFor(kind, item?.type)
    .map((id) => (id === '-' ? '-' : getCommand(id)))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const width = 240;
  const x = Math.min(state.x, (typeof window !== 'undefined' ? window.innerWidth : 2000) - width - 8);
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: x, top: state.y }} data-testid="canvas-context-menu">
      {item && (
        <div className="context-title">
          {typeLabel(item.type)}
          <span className="faint mono"> {item.id.slice(0, 8)}</span>
        </div>
      )}
      {entries.map((c, i) => {
        if (c === '-') return <div key={`sep-${i}`} className="menu-separator" />;
        const enabled = !c.when || c.when(ctx);
        const binding = effectiveBinding(c, overrides);
        return (
          <button
            key={c.id}
            className="context-item"
            role="menuitem"
            disabled={!enabled}
            onClick={() => {
              onClose();
              void c.run(ctx);
            }}
          >
            <span>{c.title}</span>
            {binding && <span className="faint">{formatBinding(binding)}</span>}
          </button>
        );
      })}
    </div>
  );
}
