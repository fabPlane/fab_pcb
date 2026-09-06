import type { DocumentKind } from '@/contracts';
import { effectiveBinding, getCommand, type CommandContext } from '@/commands/registry';
import { formatBinding } from '@/lib/keys';
import { layerDisplayName } from '@/lib/enums';
import { useAppStore } from '@/state/appStore';
import { useEditorDoc, useEditorStore } from '@/state/editorStore';
import { useKeymapStore } from '@/state/keymapStore';
import { useHistoryStore } from '@/state/historyStore';
import { useUiStore } from '@/state/uiStore';
import type { LayerInfo } from '@/services/types';
import { Tip } from './layout/Tip';

function ToolButton({ id, glyph, label, active, disabled }: { id: string; glyph: string; label?: string; active?: boolean; disabled?: boolean }) {
  const cmd = getCommand(id);
  const overrides = useKeymapStore((s) => s.overrides);
  const editor = useAppStore((s) => s.activeEditor);
  if (!cmd) return null;
  const ctx: CommandContext = { editor };
  const binding = effectiveBinding(cmd, overrides);
  return (
    <Tip
      text={
        <>
          {cmd.title}
          {binding ? ` (${formatBinding(binding)})` : ''}
        </>
      }
    >
      <button className={`tool-btn${active ? ' active' : ''}`} onClick={() => void cmd.run(ctx)} disabled={disabled} aria-label={cmd.title}>
        <span className="glyph">{glyph}</span>
        {label && <span>{label}</span>}
      </button>
    </Tip>
  );
}

export function Toolbar({ kind, storeKey, layers }: { kind: DocumentKind; storeKey: string; layers: LayerInfo[] }) {
  const doc = useEditorDoc(storeKey);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const undo = useHistoryStore((s) => s.undo.length);
  const redo = useHistoryStore((s) => s.redo.length);
  const showGrid = useUiStore((s) => s.showGrid);
  const hasSel = doc.selection.length > 0;
  return (
    <div className="toolbar" role="toolbar">
      <ToolButton id="edit.undo" glyph="↶" disabled={undo === 0} />
      <ToolButton id="edit.redo" glyph="↷" disabled={redo === 0} />
      <span className="sep" />
      <ToolButton id="edit.move" glyph="✥" label="Move" active={doc.tool === 'move'} disabled={!hasSel} />
      <ToolButton id="edit.rotateCcw" glyph="⟲" disabled={!hasSel} />
      <ToolButton id="edit.rotateCw" glyph="⟳" disabled={!hasSel} />
      {kind !== 'schematic' && <ToolButton id="edit.flip" glyph="⇅" label="Flip" disabled={!hasSel} />}
      <ToolButton id="edit.duplicate" glyph="⧉" disabled={!hasSel} />
      <ToolButton id="edit.delete" glyph="⌫" disabled={!hasSel} />
      <span className="sep" />
      <ToolButton id="view.zoomIn" glyph="+" />
      <ToolButton id="view.zoomOut" glyph="−" />
      <ToolButton id="view.zoomFit" glyph="⤢" label="Fit" />
      <ToolButton id="view.toggleGrid" glyph="#" active={showGrid} />
      <span className="sep" />
      {kind === 'schematic' ? (
        <>
          <ToolButton id="schematic.placeSymbol" glyph="A" label="Symbol" />
          <ToolButton id="schematic.wire" glyph="W" label="Wire" />
          <ToolButton id="schematic.label" glyph="L" label="Label" />
          <ToolButton id="schematic.junction" glyph="J" />
          <ToolButton id="schematic.noConnect" glyph="Q" />
          <span className="sep" />
          <ToolButton id="inspect.runErc" glyph="✓" label="ERC" />
          <ToolButton id="schematic.updatePcb" glyph="→" label="Update PCB" />
        </>
      ) : (
        <>
          {kind === 'board' && <ToolButton id="board.placeFootprint" glyph="A" label="Footprint" />}
          {kind === 'board' && <ToolButton id="board.route" glyph="X" label="Route" />}
          {kind === 'board' && <ToolButton id="board.refillZones" glyph="B" label="Refill" />}
          <span className="sep" />
          {kind === 'board' && <ToolButton id="inspect.runDrc" glyph="✓" label="DRC" />}
          {kind === 'board' && <ToolButton id="tools.boardSetup" glyph="⚙" label="Setup" />}
          <span className="sep" />
          <label className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            layer
          </label>
          <select className="select" style={{ height: 22 }} value={doc.activeLayer} onChange={(e) => setActiveLayer(storeKey, e.target.value)} aria-label="Active layer">
            {layers.map((l) => (
              <option key={l.id} value={l.id}>
                {layerDisplayName(l.id)}
              </option>
            ))}
          </select>
        </>
      )}
      <span className="spacer" />
      <ToolButton id="inspect.highlightNet" glyph="◉" label="Highlight net" disabled={!hasSel} />
      <ToolButton id="tools.commandPalette" glyph="⌘" label="Commands" />
    </div>
  );
}
