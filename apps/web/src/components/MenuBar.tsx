import * as Menubar from '@radix-ui/react-menubar';
import { Fragment } from 'react';
import { effectiveBinding, getCommand, type CommandContext } from '@/commands/registry';
import { formatBinding } from '@/lib/keys';
import { useAppStore } from '@/state/appStore';
import { useKeymapStore } from '@/state/keymapStore';
import { useUiStore } from '@/state/uiStore';

type MenuEntry = string | '-' | { label: string };

const MENUS: { label: string; items: MenuEntry[] }[] = [
  { label: 'File', items: ['file.newProject', 'file.openProject', '-', 'file.save', 'file.saveAll', '-', 'file.exportJobs', '-', 'file.closeProject'] },
  { label: 'Edit', items: ['edit.undo', 'edit.redo', '-', 'edit.move', 'edit.rotateCcw', 'edit.rotateCw', 'edit.flip', 'edit.duplicate', 'edit.delete', '-', 'edit.selectAll', 'edit.escape', '-', 'edit.properties'] },
  {
    label: 'View',
    items: ['view.zoomIn', 'view.zoomOut', 'view.zoomFit', 'view.zoomSelection', '-', 'view.toggleGrid', 'view.nextGrid', 'view.cycleUnits', '-', { label: 'Layers' }, 'view.layerFront', 'view.layerBack', 'view.layerIn1', 'view.layerIn2', 'view.layerFlipSide', '-', 'view.toggleLeftPanel', 'view.toggleRightPanel', 'view.toggleBottomPanel', 'view.resetLayout', '-', 'view.toggleTheme', 'view.themeSystem'],
  },
  { label: 'Place', items: ['board.placeFootprint', 'board.placeVia', 'board.route', '-', 'schematic.placeSymbol', 'schematic.wire', 'schematic.label', 'schematic.globalLabel', 'schematic.hierLabel', 'schematic.junction', 'schematic.noConnect'] },
  { label: 'Inspect', items: ['inspect.runDrc', 'inspect.runErc', '-', 'inspect.highlightNet', 'inspect.clearHighlight', 'inspect.nets'] },
  { label: 'Tools', items: ['tools.boardSetup', 'tools.netclasses', 'tools.textVariables', 'tools.variants', '-', 'board.refillZones', 'board.unfillZones', 'board.updateFromSchematic', 'schematic.annotate', 'schematic.updatePcb', '-', 'board.openFootprintEditor', '-', 'tools.commandPalette', 'tools.keymap'] },
  { label: 'Window', items: ['window.project', 'window.board', 'window.schematic'] },
  { label: 'Help', items: ['help.shortcuts', 'help.about'] },
];

export function MenuBar() {
  const editor = useAppStore((s) => s.activeEditor);
  const overrides = useKeymapStore((s) => s.overrides);
  const dialog = useUiStore((s) => s.dialog);
  void dialog;
  const ctx: CommandContext = { editor };
  return (
    <Menubar.Root className="menubar">
      {MENUS.map((menu) => {
        const items = menu.items
          .map((entry) => {
            if (entry === '-') return entry;
            if (typeof entry === 'object') return entry;
            const cmd = getCommand(entry);
            if (!cmd || cmd.hidden) return null;
            return cmd;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        return (
          <Menubar.Menu key={menu.label}>
            <Menubar.Trigger className="menubar-trigger">{menu.label}</Menubar.Trigger>
            <Menubar.Portal>
              <Menubar.Content className="menu-content" align="start" sideOffset={2}>
                {items.map((it, i) => {
                  if (it === '-') {
                    const prev = items[i - 1];
                    const next = items[i + 1];
                    if (!prev || !next || prev === '-') return null;
                    return <Menubar.Separator key={`sep-${i}`} className="menu-separator" />;
                  }
                  if (!('run' in it)) return <Menubar.Label key={`label-${i}`} className="menu-label">{it.label}</Menubar.Label>;
                  const cmd = it;
                  const enabled = !cmd.when || cmd.when(ctx);
                  const binding = effectiveBinding(cmd, overrides);
                  return (
                    <Fragment key={cmd.id}>
                      <Menubar.Item className="menu-item" disabled={!enabled} onSelect={() => void cmd.run(ctx)}>
                        <span className="label">{cmd.title}</span>
                        {binding && <span className="kbd">{formatBinding(binding)}</span>}
                      </Menubar.Item>
                    </Fragment>
                  );
                })}
              </Menubar.Content>
            </Menubar.Portal>
          </Menubar.Menu>
        );
      })}
    </Menubar.Root>
  );
}
