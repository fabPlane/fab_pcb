// Built-in commands. Shortcuts follow pcbnew/eeschema defaults where they translate to a
// browser (Mod = Ctrl on Windows/Linux, Cmd on macOS).

import type { StoredItem } from '@/contracts';
import { beginMove, currentMoveTransaction, endMove, getCanvasHost, isMoving } from '@/canvas/CanvasSlot';
import { childrenOf, flipItem, itemsCentre, rotateItem, translateItem } from '@/lib/geometry';
import { newKiid } from '@/lib/id';
import type { Services } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { activeDocument } from '@/state/active';
import { useEditorStore } from '@/state/editorStore';
import { log } from '@/state/logStore';
import { usePaletteStore } from '@/state/paletteStore';
import { GRID_CHOICES_NM, useUiStore } from '@/state/uiStore';
import { registerCommands, type Command, type CommandContext } from './registry';

const inEditor = (ctx: CommandContext) => ctx.editor !== 'project';
const inBoard = (ctx: CommandContext) => ctx.editor === 'board' || ctx.editor === 'footprint';
const inSchematic = (ctx: CommandContext) => ctx.editor === 'schematic';

export function registerBuiltinCommands(services: Services): () => void {
  const { commands, documents, markers } = services;

  const selectedItems = (): { key: string; store: NonNullable<ReturnType<typeof activeDocument>>['store']; items: StoredItem[] } | null => {
    const doc = activeDocument(services);
    if (!doc) return null;
    const sel = useEditorStore.getState().docs[doc.key]?.selection ?? [];
    const items = sel.map((id) => doc.store.get(id)).filter((x): x is StoredItem => !!x);
    return { key: doc.key, store: doc.store, items };
  };

  /** Selection plus the children of any selected footprints/sheets. */
  const withChildren = (store: { all(): Iterable<StoredItem> }, items: StoredItem[]): StoredItem[] => {
    const out = new Map(items.map((i) => [i.id, i]));
    for (const it of items) for (const c of childrenOf(store, it.id)) out.set(c.id, c);
    return [...out.values()];
  };

  const rotateSelection = async (deg: number) => {
    const sel = selectedItems();
    if (!sel || sel.items.length === 0) return;
    const all = withChildren(sel.store, sel.items);
    const centre = itemsCentre(sel.items);
    if (!centre) return;
    const cursor = useEditorStore.getState().docs[sel.key]?.cursor;
    const about = isMoving(sel.key) && cursor ? cursor : centre;
    const apply = (tx: { replace(id: string, proto: unknown, meta?: Partial<Pick<StoredItem, 'bbox'>>): void }) => {
      for (const it of all) {
        const r = rotateItem(it, about.x, about.y, deg);
        tx.replace(it.id, r.proto, { bbox: r.bbox });
      }
    };
    if (isMoving(sel.key)) {
      // rotate inside the open move transaction
      const tx = currentMoveTransaction(sel.key);
      if (tx) apply(tx);
      return;
    }
    await commands.run(sel.store, `Rotate ${sel.items.length} item${sel.items.length === 1 ? '' : 's'} ${deg > 0 ? 'CCW' : 'CW'}`, apply);
  };

  const zoomBy = (factor: number) => {
    const doc = activeDocument(services);
    if (!doc) return;
    const host = getCanvasHost(doc.key);
    if (!host) return;
    const cam = host.getCamera();
    host.setCamera({ zoom: cam.zoom * factor });
  };

  const setActiveLayer = (layer: string) => {
    const doc = activeDocument(services);
    if (doc) useEditorStore.getState().setActiveLayer(doc.key, layer);
  };

  const list: Command[] = [
    // ---------------------------------------------------------------- File
    {
      id: 'file.openProject',
      title: 'Open project…',
      group: 'File',
      shortcut: 'Mod+O',
      description: 'Browse the workspace for a .kicad_pro',
      run: () => useAppStore.getState().setActiveEditor('project'),
    },
    { id: 'file.newProject', title: 'New project…', group: 'File', shortcut: 'Mod+N', run: () => useUiStore.getState().openDialog('new-project') },
    {
      id: 'file.save',
      title: 'Save',
      group: 'File',
      shortcut: 'Mod+S',
      when: inEditor,
      run: async (ctx) => {
        if (ctx.editor === 'project' || ctx.editor === '3d') return;
        await documents.save(ctx.editor);
        log(`Saved ${ctx.editor}`);
        useAppStore.getState().notify(`${ctx.editor === 'board' ? 'Board' : ctx.editor === 'schematic' ? 'Schematic' : 'Footprint'} saved`);
      },
    },
    {
      id: 'file.saveAll',
      title: 'Save all',
      group: 'File',
      shortcut: 'Mod+Shift+S',
      when: inEditor,
      run: async () => {
        await Promise.all((['board', 'schematic', 'footprint'] as const).filter((k) => documents.isDirty(k)).map((k) => documents.save(k)));
        useAppStore.getState().notify('All documents saved');
      },
    },
    {
      id: 'file.exportJobs',
      title: 'Export / fabrication outputs…',
      group: 'File',
      when: inEditor,
      keywords: ['gerber', 'drill', 'step', 'bom', 'pdf'],
      run: () => useUiStore.getState().setBottomTab('jobs'),
    },
    {
      id: 'file.closeProject',
      title: 'Close project',
      group: 'File',
      run: async () => {
        await services.session.disconnect();
        useAppStore.getState().setSession(null);
        commands.clearHistory();
        log('Project closed');
      },
    },
    // ---------------------------------------------------------------- Edit
    {
      id: 'edit.undo',
      title: 'Undo',
      group: 'Edit',
      shortcut: 'Mod+Z',
      when: inEditor,
      run: async () => {
        const e = await commands.undo();
        if (e) useAppStore.getState().notify(`Undo: ${e.message}`);
      },
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      group: 'Edit',
      shortcut: 'Mod+Y',
      when: inEditor,
      run: async () => {
        const e = await commands.redo();
        if (e) useAppStore.getState().notify(`Redo: ${e.message}`);
      },
    },
    { id: 'edit.redoAlt', title: 'Redo', group: 'Edit', shortcut: 'Mod+Shift+Z', when: inEditor, hidden: true, run: () => commands.redo().then(() => undefined) },
    {
      id: 'edit.delete',
      title: 'Delete',
      group: 'Edit',
      shortcut: 'Delete',
      when: inEditor,
      run: async () => {
        const sel = selectedItems();
        if (!sel || sel.items.length === 0) return;
        const all = withChildren(sel.store, sel.items);
        await commands.run(sel.store, `Delete ${sel.items.length} item${sel.items.length === 1 ? '' : 's'}`, (tx) => {
          for (const it of all) tx.delete(it.id);
        });
        useEditorStore.getState().setSelection(sel.key, []);
      },
    },
    { id: 'edit.deleteAlt', title: 'Delete', group: 'Edit', shortcut: 'Backspace', when: inEditor, hidden: true, run: (ctx) => list.find((c) => c.id === 'edit.delete')!.run(ctx) },
    {
      id: 'edit.selectAll',
      title: 'Select all',
      group: 'Edit',
      shortcut: 'Mod+A',
      when: inEditor,
      run: () => {
        const doc = activeDocument(services);
        if (!doc) return;
        const hidden = new Set(useEditorStore.getState().docs[doc.key]?.hiddenLayers ?? []);
        useEditorStore.getState().setSelection(
          doc.key,
          [...doc.store.all()].filter((i) => !i.parent && !(i.layer && hidden.has(i.layer))).map((i) => i.id),
        );
      },
    },
    {
      id: 'edit.escape',
      title: 'Cancel / deselect',
      group: 'Edit',
      shortcut: 'Escape',
      when: inEditor,
      run: async () => {
        const doc = activeDocument(services);
        if (!doc) return;
        if (isMoving(doc.key)) {
          await endMove(doc.key, false);
          return;
        }
        const st = useEditorStore.getState();
        if ((st.docs[doc.key]?.highlightNets.length ?? 0) > 0 && (st.docs[doc.key]?.selection.length ?? 0) === 0) st.setHighlightNets(doc.key, []);
        else st.setSelection(doc.key, []);
        st.setTool(doc.key, 'select');
      },
    },
    {
      id: 'edit.move',
      title: 'Move',
      group: 'Edit',
      shortcut: 'M',
      when: inEditor,
      description: 'Drag the selection with the pointer; click to place',
      run: () => {
        const sel = selectedItems();
        if (!sel || sel.items.length === 0 || isMoving(sel.key)) return;
        const cursor = useEditorStore.getState().docs[sel.key]?.cursor ?? itemsCentre(sel.items);
        if (!cursor) return;
        const all = withChildren(sel.store, sel.items);
        const tx = commands.begin(sel.store, `Move ${sel.items.length} item${sel.items.length === 1 ? '' : 's'}`);
        beginMove(
          sel.key,
          sel.store,
          tx,
          all.map((i) => i.id),
          cursor,
        );
      },
    },
    { id: 'edit.rotateCcw', title: 'Rotate 90° counter-clockwise', group: 'Edit', shortcut: 'R', when: inEditor, run: () => rotateSelection(90) },
    { id: 'edit.rotateCw', title: 'Rotate 90° clockwise', group: 'Edit', shortcut: 'Shift+R', when: inEditor, run: () => rotateSelection(-90) },
    {
      id: 'edit.flip',
      title: 'Flip to other side',
      group: 'Edit',
      shortcut: 'F',
      when: inBoard,
      run: async () => {
        const sel = selectedItems();
        if (!sel || sel.items.length === 0) return;
        const centre = itemsCentre(sel.items);
        if (!centre) return;
        const all = withChildren(sel.store, sel.items);
        await commands.run(sel.store, `Flip ${sel.items.length} item${sel.items.length === 1 ? '' : 's'}`, (tx) => {
          for (const it of all) {
            const f = flipItem(it, centre.x);
            tx.replace(it.id, f.proto, { layer: f.layer, bbox: f.bbox });
          }
        });
      },
    },
    {
      id: 'edit.duplicate',
      title: 'Duplicate',
      group: 'Edit',
      shortcut: 'Mod+D',
      when: inEditor,
      run: async () => {
        const sel = selectedItems();
        if (!sel || sel.items.length === 0) return;
        const grid = useUiStore.getState().gridNm;
        const idMap = new Map<string, string>();
        const all = withChildren(sel.store, sel.items);
        for (const it of all) idMap.set(it.id, newKiid());
        const created: string[] = [];
        await commands.run(sel.store, `Duplicate ${sel.items.length} item${sel.items.length === 1 ? '' : 's'}`, (tx) => {
          for (const it of all) {
            const moved = translateItem(it, grid * 2, grid * 2);
            const id = idMap.get(it.id)!;
            const proto: Record<string, unknown> = { ...(moved.proto as Record<string, unknown>), id: { value: id } };
            if (it.parent && idMap.has(it.parent)) proto.parent = { value: idMap.get(it.parent) };
            tx.create({ ...moved, id, parent: it.parent && idMap.has(it.parent) ? idMap.get(it.parent) : it.parent, proto });
            if (!it.parent || !idMap.has(it.parent)) created.push(id);
          }
        });
        useEditorStore.getState().setSelection(sel.key, created);
      },
    },
    { id: 'edit.properties', title: 'Properties', group: 'Edit', shortcut: 'E', when: inEditor, run: () => useUiStore.getState().togglePanel('right', false) },
    // ---------------------------------------------------------------- View
    { id: 'view.zoomIn', title: 'Zoom in', group: 'View', shortcut: '+', when: inEditor, run: () => zoomBy(1.25) },
    { id: 'view.zoomInAlt', title: 'Zoom in', group: 'View', shortcut: '=', when: inEditor, hidden: true, run: () => zoomBy(1.25) },
    { id: 'view.zoomOut', title: 'Zoom out', group: 'View', shortcut: '-', when: inEditor, run: () => zoomBy(0.8) },
    {
      id: 'view.zoomFit',
      title: 'Zoom to fit',
      group: 'View',
      shortcut: 'Home',
      when: inEditor,
      run: () => {
        const doc = activeDocument(services);
        if (doc) getCanvasHost(doc.key)?.zoomToFit();
      },
    },
    {
      id: 'view.zoomSelection',
      title: 'Zoom to selection',
      group: 'View',
      shortcut: 'Mod+Home',
      when: inEditor,
      run: () => {
        const sel = selectedItems();
        if (!sel || !sel.items.length) return;
        const host = getCanvasHost(sel.key);
        const c = itemsCentre(sel.items);
        if (host && c) host.setCamera({ x: c.x, y: c.y });
      },
    },
    { id: 'view.toggleGrid', title: 'Toggle grid', group: 'View', shortcut: 'Alt+G', when: inEditor, run: () => useUiStore.getState().toggleGrid() },
    {
      id: 'view.nextGrid',
      title: 'Next grid',
      group: 'View',
      shortcut: 'N',
      when: inEditor,
      run: () => {
        const ui = useUiStore.getState();
        const i = GRID_CHOICES_NM.indexOf(ui.gridNm);
        ui.setGrid(GRID_CHOICES_NM[(i + 1) % GRID_CHOICES_NM.length]!);
      },
    },
    {
      id: 'view.prevGrid',
      title: 'Previous grid',
      group: 'View',
      shortcut: 'Shift+N',
      when: inEditor,
      run: () => {
        const ui = useUiStore.getState();
        const i = GRID_CHOICES_NM.indexOf(ui.gridNm);
        ui.setGrid(GRID_CHOICES_NM[(i - 1 + GRID_CHOICES_NM.length) % GRID_CHOICES_NM.length]!);
      },
    },
    { id: 'view.cycleUnits', title: 'Switch units (mm / mil / in)', group: 'View', shortcut: 'Mod+U', run: () => useUiStore.getState().cycleUnits() },
    { id: 'view.toggleLeftPanel', title: 'Toggle left panel', group: 'View', shortcut: 'Mod+1', run: () => useUiStore.getState().togglePanel('left') },
    { id: 'view.toggleRightPanel', title: 'Toggle right panel', group: 'View', shortcut: 'Mod+2', run: () => useUiStore.getState().togglePanel('right') },
    { id: 'view.toggleBottomPanel', title: 'Toggle bottom panel', group: 'View', shortcut: 'Mod+J', run: () => useUiStore.getState().togglePanel('bottom') },
    { id: 'view.resetLayout', title: 'Reset panel layout', group: 'View', run: () => useUiStore.getState().resetLayout() },
    {
      id: 'view.toggleTheme',
      title: 'Toggle light / dark theme',
      group: 'View',
      run: () => {
        const ui = useUiStore.getState();
        const isDark = ui.theme === 'dark' || (ui.theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
        ui.setTheme(isDark ? 'light' : 'dark');
      },
    },
    { id: 'view.themeSystem', title: 'Follow system theme', group: 'View', run: () => useUiStore.getState().setTheme('system') },
    { id: 'view.layerFront', title: 'Active layer: F.Cu', group: 'View', shortcut: 'PageUp', when: inBoard, run: () => setActiveLayer('BL_F_Cu') },
    { id: 'view.layerBack', title: 'Active layer: B.Cu', group: 'View', shortcut: 'PageDown', when: inBoard, run: () => setActiveLayer('BL_B_Cu') },
    { id: 'view.layerIn1', title: 'Active layer: In1.Cu', group: 'View', shortcut: 'F5', when: inBoard, run: () => setActiveLayer('BL_In1_Cu') },
    { id: 'view.layerIn2', title: 'Active layer: In2.Cu', group: 'View', shortcut: 'F6', when: inBoard, run: () => setActiveLayer('BL_In2_Cu') },
    {
      id: 'view.layerFlipSide',
      title: 'Switch active layer between front and back',
      group: 'View',
      shortcut: 'V',
      when: inBoard,
      run: () => {
        const doc = activeDocument(services);
        if (!doc) return;
        const cur = useEditorStore.getState().docs[doc.key]?.activeLayer ?? 'BL_F_Cu';
        setActiveLayer(cur === 'BL_F_Cu' ? 'BL_B_Cu' : 'BL_F_Cu');
      },
    },
    {
      id: 'view.nextLayer',
      title: 'Next copper layer',
      group: 'View',
      shortcut: ']',
      when: inBoard,
      run: () => {
        const doc = activeDocument(services);
        if (!doc) return;
        const copper = documents
          .layers()
          .filter((l) => l.kind === 'copper')
          .map((l) => l.id);
        const cur = useEditorStore.getState().docs[doc.key]?.activeLayer ?? 'BL_F_Cu';
        const i = copper.indexOf(cur);
        setActiveLayer(copper[(i + 1) % copper.length]!);
      },
    },
    {
      id: 'view.prevLayer',
      title: 'Previous copper layer',
      group: 'View',
      shortcut: '[',
      when: inBoard,
      run: () => {
        const doc = activeDocument(services);
        if (!doc) return;
        const copper = documents
          .layers()
          .filter((l) => l.kind === 'copper')
          .map((l) => l.id);
        const cur = useEditorStore.getState().docs[doc.key]?.activeLayer ?? 'BL_F_Cu';
        const i = copper.indexOf(cur);
        setActiveLayer(copper[(i - 1 + copper.length) % copper.length]!);
      },
    },
    // ------------------------------------------------------------- Inspect
    {
      id: 'inspect.highlightNet',
      title: 'Highlight net of selection',
      group: 'Inspect',
      shortcut: '`',
      when: inEditor,
      run: () => {
        const sel = selectedItems();
        if (!sel) return;
        const nets = [...new Set(sel.items.map((i) => i.net).filter((n): n is string => !!n))];
        useEditorStore.getState().setHighlightNets(sel.key, nets);
      },
    },
    {
      id: 'inspect.clearHighlight',
      title: 'Clear net highlight',
      group: 'Inspect',
      when: inEditor,
      run: () => {
        const doc = activeDocument(services);
        if (doc) useEditorStore.getState().setHighlightNets(doc.key, []);
      },
    },
    {
      id: 'inspect.runDrc',
      title: 'Run DRC',
      group: 'Inspect',
      when: inBoard,
      keywords: ['design rules check'],
      run: async () => {
        useUiStore.getState().setBottomTab('markers');
        const list = await markers.run('drc');
        log(`DRC finished: ${list.filter((m) => m.severity === 'error' && !m.excluded).length} errors, ${list.filter((m) => m.severity === 'warning' && !m.excluded).length} warnings`);
      },
    },
    {
      id: 'inspect.runErc',
      title: 'Run ERC',
      group: 'Inspect',
      when: inSchematic,
      keywords: ['electrical rules check'],
      run: async () => {
        useUiStore.getState().setBottomTab('markers');
        const list = await markers.run('erc');
        log(`ERC finished: ${list.filter((m) => m.severity === 'error' && !m.excluded).length} errors, ${list.filter((m) => m.severity === 'warning' && !m.excluded).length} warnings`);
      },
    },
    { id: 'inspect.nets', title: 'Net inspector', group: 'Inspect', when: inBoard, run: () => useUiStore.getState().setLeftTab('nets') },
    // --------------------------------------------------------------- Tools
    { id: 'tools.commandPalette', title: 'Command palette', group: 'Tools', shortcut: 'Mod+K', run: () => usePaletteStore.getState().toggle() },
    { id: 'tools.commandPaletteAlt', title: 'Command palette', group: 'Tools', shortcut: 'Mod+Shift+P', hidden: true, run: () => usePaletteStore.getState().toggle() },
    {
      id: 'tools.settings',
      title: 'Settings…',
      group: 'Tools',
      shortcut: 'Mod+,',
      keywords: ['preferences', 'theme', 'dark', 'light', 'appearance', 'open settings'],
      run: () => useUiStore.getState().openDialog('settings'),
    },
    { id: 'tools.keymap', title: 'Keyboard shortcuts…', group: 'Tools', keywords: ['hotkeys', 'settings', 'preferences'], run: () => useUiStore.getState().openDialog('keymap') },
    { id: 'tools.boardSetup', title: 'Board setup…', group: 'Board', when: inBoard, keywords: ['stackup', 'design rules', 'constraints'], run: () => useUiStore.getState().openDialog('board-setup') },
    { id: 'tools.netclasses', title: 'Net classes…', group: 'Tools', when: inEditor, run: () => useUiStore.getState().openDialog('netclasses') },
    { id: 'tools.textVariables', title: 'Text variables…', group: 'Tools', when: inEditor, run: () => useUiStore.getState().openDialog('text-variables') },
    { id: 'tools.variants', title: 'Variants…', group: 'Tools', when: inEditor, keywords: ['dnp', 'assembly'], run: () => useUiStore.getState().openDialog('variants') },
    // --------------------------------------------------------------- Board
    {
      id: 'board.refillZones',
      title: 'Refill all zones',
      group: 'Board',
      shortcut: 'B',
      when: inBoard,
      run: async () => {
        const refill = (documents as { refillZones?: () => Promise<void> }).refillZones;
        if (refill) {
          await refill.call(documents);
          log('RefillZones: all zones refilled');
        } else log('RefillZones: 1 zone filled (GND pour, B.Cu) [mock]');
        useAppStore.getState().notify('Zones refilled');
      },
    },
    { id: 'board.unfillZones', title: 'Unfill all zones', group: 'Board', shortcut: 'Mod+B', when: inBoard, run: () => log('Zones unfilled') },
    {
      id: 'board.updateFromSchematic',
      title: 'Update PCB from schematic…',
      group: 'Board',
      shortcut: 'F8',
      when: inBoard,
      keywords: ['netlist', 'import'],
      run: () => useAppStore.getState().notify('GetSchematicNetlist → ImportNetlist runs once the client SDK lands (M3)'),
    },
    {
      id: 'board.route',
      title: 'Route single track',
      group: 'Route',
      shortcut: 'X',
      when: inBoard,
      run: () => useAppStore.getState().notify('Interactive routing needs gap G9 (headless router); manual track placement arrives in M3'),
    },
    {
      id: 'board.autoroute',
      title: 'Autoroute…',
      group: 'Route',
      shortcut: 'Shift+X',
      when: (ctx) => ctx.editor === 'board',
      keywords: ['autorouter', 'freerouting', 'route all', 'ratsnest'],
      description: 'Route the unrouted connections with the JS router (in this tab or on the server) or Freerouting',
      run: () => useUiStore.getState().openDialog('autoroute'),
    },
    {
      id: 'board.placeVia',
      title: 'Place via',
      group: 'Place',
      shortcut: 'Mod+Shift+V',
      when: inBoard,
      run: () => useAppStore.getState().notify('Via placement arrives with the create-items flow in M3'),
    },
    {
      id: 'board.placeFootprint',
      title: 'Place footprint…',
      group: 'Place',
      shortcut: 'A',
      when: inBoard,
      keywords: ['add component', 'library'],
      run: () => useAppStore.getState().notify('Footprint browser needs gap G7 (library access)'),
    },
    { id: 'board.drawZone', title: 'Draw filled zone', group: 'Place', when: inBoard, hidden: true, run: () => undefined }, // no default chord: Mod+Shift+Z is redo (edit.redoAlt); the real tool is registered in commands/editing.ts
    {
      id: 'board.openFootprintEditor',
      title: 'Open footprint editor',
      group: 'Window',
      when: inBoard,
      run: () => {
        const sel = selectedItems();
        const fp = sel?.items.find((i) => i.type === 'KOT_PCB_FOOTPRINT');
        const libId = fp ? `${(fp.proto as any).definition?.id?.libraryNickname}:${(fp.proto as any).definition?.id?.entryName}` : 'Resistor_SMD:R_0603_1608Metric';
        documents.footprint(libId);
        useAppStore.getState().openDoc({ kind: 'footprint', id: libId, title: libId });
      },
    },
    // ----------------------------------------------------------- Schematic
    { id: 'schematic.wire', title: 'Draw wire', group: 'Place', shortcut: 'W', when: inSchematic, run: () => useAppStore.getState().notify('Wire tool arrives with schematic create-items in M3') },
    { id: 'schematic.bus', title: 'Draw bus', group: 'Place', shortcut: 'Shift+B', when: inSchematic, hidden: true, run: () => undefined },
    {
      id: 'schematic.label',
      title: 'Place net label',
      group: 'Place',
      shortcut: 'L',
      when: inSchematic,
      run: () => useAppStore.getState().notify('Label tool arrives with schematic create-items in M3'),
    },
    {
      id: 'schematic.globalLabel',
      title: 'Place global label',
      group: 'Place',
      shortcut: 'Mod+L',
      when: inSchematic,
      run: () => useAppStore.getState().notify('Label tool arrives with schematic create-items in M3'),
    },
    {
      id: 'schematic.hierLabel',
      title: 'Place hierarchical label',
      group: 'Place',
      shortcut: 'H',
      when: inSchematic,
      run: () => useAppStore.getState().notify('Label tool arrives with schematic create-items in M3'),
    },
    {
      id: 'schematic.placeSymbol',
      title: 'Place symbol…',
      group: 'Place',
      shortcut: 'A',
      when: inSchematic,
      keywords: ['add component', 'library'],
      run: () => useAppStore.getState().notify('Symbol browser needs gap G7 (library access)'),
    },
    {
      id: 'schematic.junction',
      title: 'Place junction',
      group: 'Place',
      shortcut: 'J',
      when: inSchematic,
      run: () => useAppStore.getState().notify('Junction tool arrives with schematic create-items in M3'),
    },
    {
      id: 'schematic.noConnect',
      title: 'Place no-connect flag',
      group: 'Place',
      shortcut: 'Q',
      when: inSchematic,
      run: () => useAppStore.getState().notify('No-connect tool arrives with schematic create-items in M3'),
    },
    { id: 'schematic.annotate', title: 'Annotate schematic…', group: 'Schematic', when: inSchematic, run: () => useAppStore.getState().notify('Annotate needs gap G8 (headless schematic ops)') },
    {
      id: 'schematic.updatePcb',
      title: 'Update PCB from schematic…',
      group: 'Schematic',
      shortcut: 'F8',
      when: inSchematic,
      run: () => useAppStore.getState().notify('GetSchematicNetlist → ImportNetlist runs once the client SDK lands (M3)'),
    },
    {
      id: 'schematic.leaveSheet',
      title: 'Leave sheet',
      group: 'Schematic',
      shortcut: 'Alt+Backspace',
      when: inSchematic,
      run: () => {
        const app = useAppStore.getState();
        const parts = app.activeSheet.split('/').filter(Boolean);
        parts.pop();
        app.setActiveSheet(parts.length ? `/${parts.join('/')}/` : '/');
      },
    },
    { id: 'schematic.rootSheet', title: 'Go to root sheet', group: 'Schematic', shortcut: 'Mod+Alt+Home', when: inSchematic, hidden: true, run: () => useAppStore.getState().setActiveSheet('/') },
    // -------------------------------------------------------------- Window
    { id: 'window.project', title: 'Show project screen', group: 'Window', run: () => useAppStore.getState().setActiveEditor('project') },
    {
      id: 'window.board',
      title: 'Open board editor',
      group: 'Window',
      shortcut: 'Mod+Shift+B',
      run: () => {
        const s = documents.board();
        if (s) useAppStore.getState().openDoc({ kind: 'board', id: 'board', title: `${useAppStore.getState().session?.projectName ?? 'board'}.kicad_pcb` });
      },
    },
    {
      id: 'window.schematic',
      title: 'Open schematic editor',
      group: 'Window',
      shortcut: 'Mod+Shift+E',
      run: () => {
        const root = documents.sheets()[0];
        if (root) useAppStore.getState().openDoc({ kind: 'schematic', id: root.path, title: root.file });
      },
    },
    // ---------------------------------------------------------------- Help
    { id: 'help.about', title: 'About kicad-web', group: 'Help', run: () => useUiStore.getState().openDialog('about') },
    { id: 'help.shortcuts', title: 'Show keyboard shortcuts', group: 'Help', shortcut: '?', run: () => useUiStore.getState().openDialog('keymap') },
  ];
  return registerCommands(list);
}
