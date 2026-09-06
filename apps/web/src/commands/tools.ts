// Batch-3 commands: the library browser, the board-wide tools KiCad performs itself (teardrops,
// autoplace, global deletion, update footprints from library), the schematic workflow dialogs and
// the ratsnest toggle. Registered after `editing.ts`, so the ids here win over the placeholders.
//
// The board tools change the document outside a commit; the services re-sync the store, and the
// history panel's server-undo mode is what takes them back.

import { GLOBAL_DELETE_TYPES } from '@/services/kicad/KicadBoardTools';
import type { Services } from '@/services/types';
import { activeDocument } from '@/state/active';
import { useAppStore } from '@/state/appStore';
import { useEditorStore } from '@/state/editorStore';
import { pickLibraryEntry } from '@/state/libraryStore';
import { log } from '@/state/logStore';
import { prompt } from '@/state/promptStore';
import { useUiStore } from '@/state/uiStore';
import { BOARD_LAYERS, layerDisplayName } from '@/lib/enums';
import { registerCommands, type Command, type CommandContext } from './registry';

const inBoard = (ctx: CommandContext) => ctx.editor === 'board';
const inSchematic = (ctx: CommandContext) => ctx.editor === 'schematic';

export function registerToolCommands(services: Services): () => void {
  const notify = (t: string, kind?: 'info' | 'error') => useAppStore.getState().notify(t, kind);
  const needsKicad = (what: string) => notify(`${what} needs the KiCad services (the mock has no server-side board tools)`, 'error');

  /** Runs `fn`, reporting failures as a toast + log line rather than an unhandled rejection. */
  const guard = async (label: string, fn: () => Promise<string | void>): Promise<void> => {
    try {
      const msg = await fn();
      if (msg) {
        log(`${label}: ${msg}`);
        notify(msg);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(`${label} failed: ${m}`, 'error');
      notify(`${label}: ${m}`, 'error');
    }
  };

  const selectedFootprints = (): string[] => {
    const doc = activeDocument(services);
    if (!doc) return [];
    const sel = useEditorStore.getState().docs[doc.key]?.selection ?? [];
    return sel.filter((id) => doc.store.get(id)?.type === 'KOT_PCB_FOOTPRINT');
  };

  const list: Command[] = [
    // ------------------------------------------------------------------ libraries
    {
      id: 'tools.libraryBrowser',
      title: 'Browse libraries…',
      group: 'Tools',
      shortcut: 'Mod+Shift+A',
      keywords: ['footprint', 'symbol', 'library', 'parts'],
      description: 'Footprint and symbol libraries with a preview of the selected entry',
      run: async (ctx) => {
        if (!services.library) return needsKicad('The library browser');
        const kind = ctx.editor === 'schematic' ? 'symbol' : 'footprint';
        const libId = await pickLibraryEntry(kind, { purpose: 'browse', title: kind === 'footprint' ? 'Footprint libraries' : 'Symbol libraries' });
        if (libId) log(`library browser: ${libId}`);
      },
    },
    // -------------------------------------------------------------------- view
    {
      id: 'view.toggleRatsnest',
      title: 'Toggle ratsnest',
      group: 'View',
      shortcut: 'Alt+R',
      when: inBoard,
      keywords: ['airlines', 'unrouted'],
      run: () => useUiStore.getState().toggleRatsnest(),
    },
    // ------------------------------------------------------------------- board
    {
      id: 'board.teardrops',
      title: 'Add teardrops…',
      group: 'Board',
      when: inBoard,
      keywords: ['teardrop', 'fillet'],
      run: async () => {
        if (!services.board) return needsKicad('Teardrops');
        const r = await prompt({
          title: 'Add teardrops',
          description: 'KiCad rebuilds the teardrop zones for the targets you pick (SetTeardrops).',
          fields: [
            { key: 'vias', label: 'Vias', type: 'boolean', default: true },
            { key: 'pthPads', label: 'Through-hole pads', type: 'boolean', default: true },
            { key: 'smdPads', label: 'SMD pads', type: 'boolean', default: false },
            { key: 'trackToTrack', label: 'Track-to-track', type: 'boolean', default: false },
            { key: 'roundShapesOnly', label: 'Round shapes only', type: 'boolean', default: false },
          ],
        });
        if (!r) return;
        await guard('SetTeardrops', async () => {
          const n = await services.board!.setTeardrops({
            vias: !!r.vias,
            pthPads: !!r.pthPads,
            smdPads: !!r.smdPads,
            trackToTrack: !!r.trackToTrack,
            roundShapesOnly: !!r.roundShapesOnly,
          });
          return `${n} teardrop${n === 1 ? '' : 's'} created`;
        });
      },
    },
    {
      id: 'board.removeTeardrops',
      title: 'Remove all teardrops',
      group: 'Board',
      when: inBoard,
      run: async () => {
        if (!services.board) return needsKicad('Teardrops');
        await guard('RemoveTeardrops', async () => {
          const n = await services.board!.removeTeardrops();
          return `${n} teardrop${n === 1 ? '' : 's'} removed`;
        });
      },
    },
    {
      id: 'board.autoplace',
      title: 'Autoplace footprints…',
      group: 'Board',
      when: inBoard,
      keywords: ['arrange', 'place'],
      run: async () => {
        if (!services.board) return needsKicad('Autoplace');
        const sel = selectedFootprints();
        const r = await prompt({
          title: 'Autoplace footprints',
          description: sel.length ? `${sel.length} footprint(s) selected.` : 'Nothing selected — every footprint is placed. The board needs an Edge.Cuts outline.',
          fields: [
            { key: 'scope', label: 'Scope', type: 'select', default: sel.length ? 'selection' : 'all', choices: [{ value: 'selection', label: `Selection (${sel.length})` }, { value: 'all', label: 'Every footprint' }] },
            { key: 'includeOffboard', label: 'Include footprints outside the outline', type: 'boolean', default: true },
          ],
        });
        if (!r) return;
        await guard('AutoplaceFootprints', async () => {
          const res = await services.board!.autoplace(r.scope === 'selection' ? sel : [], { includeOffboard: !!r.includeOffboard });
          if (!res.ok) return 'Autoplace needs a board outline on Edge.Cuts';
          return `${res.placedCount} footprint(s) placed`;
        });
      },
    },
    {
      id: 'board.updateFootprints',
      title: 'Update footprints from library…',
      group: 'Board',
      when: inBoard,
      keywords: ['refresh', 'library', 'sync'],
      run: async () => {
        if (!services.board) return needsKicad('Updating footprints');
        const r = await prompt({
          title: 'Update footprints from library',
          description: 'Re-reads each footprint from its library and replaces the board copy.',
          fields: [
            { key: 'references', label: 'References', type: 'string', default: '', placeholder: 'R1 R2 C3 — empty for every footprint', help: 'Space or comma separated' },
            { key: 'onlyChanged', label: 'Skip footprints that already match', type: 'boolean', default: true },
          ],
        });
        if (!r) return;
        await guard('UpdateFootprintsFromLibrary', async () => {
          const refs = String(r.references ?? '')
            .split(/[\s,]+/)
            .filter(Boolean);
          const res = await services.board!.updateFootprintsFromLibrary(refs, { onlyChanged: !!r.onlyChanged });
          for (const m of res.messages) log(`  ${m}`);
          return `${res.updatedCount} updated, ${res.unchangedCount} unchanged${res.missing.length ? `, ${res.missing.length} missing (${res.missing.join(', ')})` : ''}`;
        });
      },
    },
    {
      id: 'board.globalDeletion',
      title: 'Global deletion…',
      group: 'Board',
      when: inBoard,
      keywords: ['delete all', 'clear board', 'purge'],
      run: async () => {
        if (!services.board) return needsKicad('Global deletion');
        const layers = services.documents.layers();
        const r = await prompt({
          title: 'Global deletion',
          description: 'Deletes every item of the chosen types. This is a board-wide edit — undo goes through KiCad.',
          fields: [
            ...GLOBAL_DELETE_TYPES.map((t) => ({ key: t.type, label: t.label, type: 'boolean' as const, default: false })),
            { key: 'layer', label: 'Restrict to layer', type: 'select', default: '', choices: [{ value: '', label: 'Every layer' }, ...(layers.length ? layers : BOARD_LAYERS.map((id) => ({ id, name: layerDisplayName(id) }))).map((l) => ({ value: l.id, label: layerDisplayName(l.id) }))] },
            { key: 'locked', label: 'Locked items', type: 'select', default: 'unlocked', choices: [{ value: 'unlocked', label: 'Skip locked items' }, { value: 'all', label: 'Include locked items' }, { value: 'locked', label: 'Only locked items' }] },
            { key: 'boardEdges', label: 'Also board outline (Edge.Cuts)', type: 'boolean', default: false },
            { key: 'teardrops', label: 'Also teardrop zones', type: 'boolean', default: false },
          ],
        });
        if (!r) return;
        const types = GLOBAL_DELETE_TYPES.filter((t) => r[t.type]).map((t) => t.type);
        if (!types.length) return notify('Pick at least one item type to delete', 'error');
        await guard('GlobalDeletion', async () => {
          const n = await services.board!.globalDeletion({
            types,
            layers: r.layer ? [String(r.layer)] : [],
            locked: r.locked as 'all' | 'locked' | 'unlocked',
            boardEdges: !!r.boardEdges,
            teardrops: !!r.teardrops,
          });
          return `${n} item${n === 1 ? '' : 's'} deleted`;
        });
      },
    },
    { id: 'board.severities', title: 'DRC severities…', group: 'Board', when: inBoard, keywords: ['rules', 'ignore', 'warning'], run: () => useUiStore.getState().openDialog('severities') },
    // --------------------------------------------------------------- schematic
    { id: 'schematic.annotate', title: 'Annotate schematic…', group: 'Schematic', when: inSchematic, keywords: ['reference', 'designator', 'renumber'], run: () => useUiStore.getState().openDialog('annotate') },
    { id: 'schematic.fieldsTable', title: 'Symbol fields table…', group: 'Schematic', when: inSchematic, keywords: ['bom', 'fields', 'values'], run: () => useUiStore.getState().openDialog('fields-table') },
    { id: 'schematic.assignFootprints', title: 'Assign footprints…', group: 'Schematic', when: inSchematic, keywords: ['cvpcb', 'footprint'], run: () => useUiStore.getState().openDialog('fields-table') },
    { id: 'schematic.updatePcb', title: 'Update PCB from schematic…', group: 'Schematic', shortcut: 'F8', when: inSchematic, keywords: ['netlist', 'sync'], run: () => useUiStore.getState().openDialog('update-pcb') },
    { id: 'board.updateFromSchematic', title: 'Update PCB from schematic…', group: 'Board', shortcut: 'F8', when: inBoard, keywords: ['netlist', 'import'], run: () => useUiStore.getState().openDialog('update-pcb') },
    { id: 'schematic.ercSeverities', title: 'ERC severities…', group: 'Schematic', when: inSchematic, run: () => useUiStore.getState().openDialog('severities') },
  ];
  return registerCommands(list);
}
