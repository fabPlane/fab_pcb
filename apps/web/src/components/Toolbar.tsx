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
  const showRatsnest = useUiStore((s) => s.showRatsnest);
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
      {kind === 'board' && <ToolButton id="view.toggleRatsnest" glyph="⋰" label="Ratsnest" active={showRatsnest} />}
      <span className="sep" />
      {kind === 'schematic' ? (
        <>
          <ToolButton id="schematic.placeSymbol" glyph="A" label="Symbol" active={doc.tool === 'symbol'} />
          <ToolButton id="schematic.wire" glyph="W" label="Wire" active={doc.tool === 'wire'} />
          <ToolButton id="schematic.bus" glyph="B" label="Bus" active={doc.tool === 'bus'} />
          <ToolButton id="schematic.label" glyph="L" label="Label" active={doc.tool === 'label'} />
          <ToolButton id="schematic.globalLabel" glyph="G" active={doc.tool === 'globalLabel'} />
          <ToolButton id="schematic.hierLabel" glyph="H" active={doc.tool === 'hierLabel'} />
          <ToolButton id="schematic.junction" glyph="J" active={doc.tool === 'junction'} />
          <ToolButton id="schematic.noConnect" glyph="Q" active={doc.tool === 'noconnect'} />
          <ToolButton id="schematic.text" glyph="T" active={doc.tool === 'schText'} />
          <ToolButton id="schematic.sheet" glyph="S" label="Sheet" active={doc.tool === 'sheet'} />
          <span className="sep" />
          <ToolButton id="inspect.runErc" glyph="✓" label="ERC" />
          <ToolButton id="schematic.annotate" glyph="#" label="Annotate" />
          <ToolButton id="schematic.fieldsTable" glyph="▤" label="Fields" />
          <ToolButton id="schematic.updatePcb" glyph="→" label="Update PCB" />
        </>
      ) : (
        <>
          {kind === 'board' && <ToolButton id="board.placeFootprint" glyph="A" label="Footprint" active={doc.tool === 'footprint'} />}
          {kind === 'board' && <ToolButton id="tools.libraryBrowser" glyph="▦" label="Libraries" />}
          {kind === 'board' && <ToolButton id="board.route" glyph="X" label="Route" active={doc.tool === 'route'} />}
          {kind === 'board' && <ToolButton id="board.autoroute" glyph="⟿" label="Auto" />}
          {kind === 'board' && <ToolButton id="board.placeVia" glyph="◎" label="Via" active={doc.tool === 'via'} />}
          <ToolButton id="board.drawLine" glyph="╱" active={doc.tool === 'line'} />
          <ToolButton id="board.drawRect" glyph="▭" active={doc.tool === 'rect'} />
          <ToolButton id="board.drawCircle" glyph="○" active={doc.tool === 'circle'} />
          <ToolButton id="board.drawArc" glyph="◠" active={doc.tool === 'arc'} />
          <ToolButton id="board.drawPolygon" glyph="⬠" active={doc.tool === 'polygon'} />
          <ToolButton id="board.placeText" glyph="T" active={doc.tool === 'text'} />
          {kind === 'board' && <ToolButton id="board.drawZone" glyph="▨" label="Zone" active={doc.tool === 'zone'} />}
          {kind === 'board' && <ToolButton id="board.refillZones" glyph="B" label="Refill" />}
          <span className="sep" />
          {kind === 'board' && <ToolButton id="inspect.runDrc" glyph="✓" label="DRC" />}
          {kind === 'board' && <ToolButton id="tools.boardSetup" glyph="⚙" label="Setup" />}
          {kind === 'board' && <ToolButton id="window.view3d" glyph="⬡" label="3D" />}
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
