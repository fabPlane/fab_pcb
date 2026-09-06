// Creation and editing commands (batch 2 "editing parity"): the interactive placement tools
// from canvas/tools.ts, rotate-by-angle, set layer / net, align / distribute, copy / paste
// (the in-app clipboard replayed as CreateItems, and KiCad's clipboard text through
// SaveItemsToString / ParseAndCreateItemsFromString), the 3D tab and the page-settings dialog. Registered after the
// builtins so the placeholder entries with the same ids are replaced.

import { BoardLayer, type SchematicSymbol as SchematicSymbolDefinition } from '@kicad-web/proto';
import type { StoredItem } from '@/contracts';
import { getCanvasHost, isMoving } from '@/canvas/CanvasSlot';
import { activeTool, cancelTool, startTool, toolFinish, toolKey, type ToolId } from '@/canvas/tools';
import { cloneForPaste, nextReference, type LibraryFootprint } from '@/lib/create';
import { childrenOf, flipItem, itemAnchor, itemsCentre, referenceOf, rotateItem, translateItem } from '@/lib/geometry';
import { layerDisplayName } from '@/lib/enums';
import type { Services } from '@/services/types';
import { activeDocument, storeKeyFor } from '@/state/active';
import { useAppStore } from '@/state/appStore';
import { useEditorStore } from '@/state/editorStore';
import { log } from '@/state/logStore';
import { pickLibraryEntry } from '@/state/libraryStore';
import { prompt, promptValue } from '@/state/promptStore';
import { useUiStore } from '@/state/uiStore';
import { registerCommands, getCommand, type Command, type CommandContext } from './registry';
import { crossProbeSelection } from '@/services/crossProbe';

export interface LibraryAccess {
  footprint(libId: string): Promise<LibraryFootprint>;
  symbol(libId: string): Promise<SchematicSymbolDefinition>;
}

const inEditor = (ctx: CommandContext) => ctx.editor !== 'project' && ctx.editor !== '3d';
const inBoard = (ctx: CommandContext) => ctx.editor === 'board' || ctx.editor === 'footprint';
const inSchematic = (ctx: CommandContext) => ctx.editor === 'schematic';

interface Clipboard {
  items: StoredItem[];
  kind: string;
  centre: { x: number; y: number };
  /** KiCad clipboard s-expression (`SaveItemsToString`), when the services provide it. */
  text?: string;
}

/** Optional document-service extras (the KiCad services have them, the mock does not). */
interface ClipboardDocs {
  saveItemsToString?(kind: string, id: string, ids: string[]): Promise<string>;
  parseAndCreate?(kind: string, id: string, text: string): Promise<StoredItem[]>;
}
let clipboard: Clipboard | null = null;

/** For tests and the proof script. */
export function clipboardContents(): Clipboard | null {
  return clipboard;
}

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export function registerEditingCommands(services: Services, extras: { library?: LibraryAccess } = {}): () => void {
  const { commands, documents } = services;
  const notify = (t: string, kind?: 'info' | 'error') => useAppStore.getState().notify(t, kind);

  const selected = () => {
    const doc = activeDocument(services);
    if (!doc) return null;
    const sel = useEditorStore.getState().docs[doc.key]?.selection ?? [];
    const items = sel.map((id) => doc.store.get(id)).filter((x): x is StoredItem => !!x);
    return { ...doc, items };
  };
  const withChildren = (store: { all(): Iterable<StoredItem> }, items: StoredItem[]): StoredItem[] => {
    const out = new Map(items.map((i) => [i.id, i]));
    for (const it of items) for (const c of childrenOf(store, it.id)) out.set(c.id, c);
    return [...out.values()];
  };
  const begin = (id: ToolId, params: Record<string, unknown> = {}) => {
    const doc = activeDocument(services);
    if (!doc) return;
    if (isMoving(doc.key)) return;
    startTool(id, doc, params);
  };
  const usedReferences = (store: { all(): Iterable<StoredItem> }, type: string): string[] => [...store.all()].filter((i) => i.type === type).map(referenceOf);
  const clipDocs = documents as ClipboardDocs;
  const refOf = (v: unknown): string => (typeof v === 'string' ? v : String((v as { text?: string } | undefined)?.text ?? ''));

  const list: Command[] = [
    // ------------------------------------------------------------ board tools
    { id: 'board.route', title: 'Route track', group: 'Route', shortcut: 'X', when: inBoard, description: 'Click-click segments on the active layer; V drops a via and switches layer', run: () => begin('route') },
    { id: 'board.placeVia', title: 'Place via', group: 'Place', shortcut: 'Mod+Shift+V', when: inBoard, run: () => begin('via') },
    { id: 'board.drawLine', title: 'Draw line', group: 'Place', shortcut: 'Mod+Shift+L', when: inBoard, run: () => begin('line') },
    { id: 'board.drawRect', title: 'Draw rectangle', group: 'Place', shortcut: 'Mod+Shift+R', when: inBoard, run: () => begin('rect') },
    { id: 'board.drawCircle', title: 'Draw circle', group: 'Place', shortcut: 'Mod+Shift+C', when: inBoard, run: () => begin('circle') },
    { id: 'board.drawArc', title: 'Draw arc', group: 'Place', shortcut: 'Mod+Shift+A', when: inBoard, run: () => begin('arc') },
    { id: 'board.drawPolygon', title: 'Draw polygon', group: 'Place', when: inBoard, run: () => begin('polygon') },
    {
      id: 'board.placeText',
      title: 'Add text…',
      group: 'Place',
      shortcut: 'Mod+Shift+T',
      when: inBoard,
      run: async () => {
        const r = await prompt({ title: 'Add text', fields: [{ key: 'text', label: 'Text', type: 'string', default: 'TEXT' }, { key: 'size', label: 'Size', type: 'distance', default: 1_000_000 }] });
        if (!r || !String(r.text).trim()) return;
        begin('text', { text: String(r.text), sizeNm: Number(r.size) });
      },
    },
    { id: 'board.drawZone', title: 'Add filled zone…', group: 'Place', when: inBoard, keywords: ['copper pour', 'keepout', 'rule area'], run: () => begin('zone') },
    {
      id: 'board.placeFootprint',
      title: 'Place footprint…',
      group: 'Place',
      shortcut: 'A',
      when: (ctx) => ctx.editor === 'board',
      keywords: ['add component', 'library'],
      run: async () => {
        const doc = activeDocument(services);
        if (!doc) return;
        if (!extras.library) {
          notify('Footprint libraries need the KiCad services (the mock has no library access)', 'error');
          return;
        }
        // The browser is the primary picker; the LIB_ID field in its footer is the typing fallback.
        const libId = (await pickLibraryEntry('footprint', { purpose: 'place', title: 'Place footprint', description: 'Footprint libraries from the project and global fp-lib-table.' }))?.trim();
        if (!libId) return;
        const r = await prompt({
          title: `Place ${libId}`,
          fields: [
            { key: 'reference', label: 'Reference', type: 'string', default: nextReference('R', usedReferences(doc.store, 'KOT_PCB_FOOTPRINT')) },
            { key: 'value', label: 'Value', type: 'string', default: libId.split(':').pop() ?? '' },
          ],
        });
        if (!r) return;
        try {
          const lib = await extras.library.footprint(libId);
          const prefix = /^[A-Za-z]+/.exec(String(r.reference))?.[0] ?? 'REF';
          const reference = String(r.reference).trim() || nextReference(prefix, usedReferences(doc.store, 'KOT_PCB_FOOTPRINT'));
          begin('footprint', { library: lib, reference, value: String(r.value ?? '') || libId.split(':').pop() });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`OpenDocument(footprint ${libId}) failed: ${msg}`, 'error');
          notify(`Footprint ${libId}: ${msg}`, 'error');
        }
      },
    },
    {
      id: 'board.openFootprintEditor',
      title: 'Open footprint editor',
      group: 'Window',
      when: inBoard,
      description: 'Opens the selected footprint (or a library footprint by id) in the footprint editor',
      run: async () => {
        const sel = selected();
        const fp = sel?.items.find((i) => i.type === 'KOT_PCB_FOOTPRINT');
        const p = fp?.proto as { definition?: { id?: { libraryNickname?: string; entryName?: string } } } | undefined;
        let libId = p?.definition?.id ? `${p.definition.id.libraryNickname}:${p.definition.id.entryName}` : '';
        if (!libId) {
          const v = services.library ? await pickLibraryEntry('footprint', { purpose: 'browse', title: 'Open footprint' }) : await promptValue<string>('Open footprint', { label: 'Footprint', type: 'string', default: 'Resistor_SMD:R_0603_1608Metric' });
          if (!v) return;
          libId = v.trim();
        }
        documents.footprint(libId);
        useAppStore.getState().openDoc({ kind: 'footprint', id: libId, title: libId });
      },
    },
    // -------------------------------------------------------- schematic tools
    { id: 'schematic.wire', title: 'Draw wire', group: 'Place', shortcut: 'W', when: inSchematic, run: () => begin('wire') },
    { id: 'schematic.bus', title: 'Draw bus', group: 'Place', shortcut: 'B', when: inSchematic, run: () => begin('bus') },
    { id: 'schematic.junction', title: 'Place junction', group: 'Place', shortcut: 'J', when: inSchematic, run: () => begin('junction') },
    { id: 'schematic.noConnect', title: 'Place no-connect flag', group: 'Place', shortcut: 'Q', when: inSchematic, run: () => begin('noconnect') },
    ...(['label', 'globalLabel', 'hierLabel'] as const).map<Command>((id) => ({
      id: `schematic.${id}`,
      title: id === 'label' ? 'Place net label…' : id === 'globalLabel' ? 'Place global label…' : 'Place hierarchical label…',
      group: 'Place',
      shortcut: id === 'label' ? 'L' : id === 'globalLabel' ? 'Mod+L' : 'H',
      when: inSchematic,
      run: async () => {
        const fields = [
          { key: 'text', label: 'Label', type: 'string' as const, default: id === 'label' ? 'NET' : id === 'globalLabel' ? 'GLOBAL' : 'HIER' },
          { key: 'size', label: 'Size', type: 'distance' as const, default: 1_270_000 },
        ];
        if (id !== 'label') fields.push({ key: 'shape', label: 'Shape', type: 'select' as never, default: 'input', choices: ['input', 'output', 'bidi', 'tristate', 'passive'].map((v) => ({ value: v, label: v })) } as never);
        const r = await prompt({ title: id === 'label' ? 'Net label' : id === 'globalLabel' ? 'Global label' : 'Hierarchical label', fields });
        if (!r || !String(r.text).trim()) return;
        begin(id, { text: String(r.text).trim(), sizeNm: Number(r.size), shape: r.shape });
      },
    })),
    {
      id: 'schematic.text',
      title: 'Add text…',
      group: 'Place',
      shortcut: 'T',
      when: inSchematic,
      run: async () => {
        const r = await prompt({ title: 'Add text', fields: [{ key: 'text', label: 'Text', type: 'multiline', default: 'Text' }, { key: 'size', label: 'Size', type: 'distance', default: 1_270_000 }] });
        if (!r || !String(r.text).trim()) return;
        begin('schText', { text: String(r.text), sizeNm: Number(r.size) });
      },
    },
    {
      id: 'schematic.placeSymbol',
      title: 'Place symbol…',
      group: 'Place',
      shortcut: 'A',
      when: inSchematic,
      keywords: ['add component', 'library'],
      run: async () => {
        const doc = activeDocument(services);
        if (!doc) return;
        if (!extras.library) {
          notify('Symbol libraries need the KiCad services (the mock has no library access)', 'error');
          return;
        }
        const libId = (await pickLibraryEntry('symbol', { purpose: 'place', title: 'Place symbol', description: 'Symbol libraries from the project and global sym-lib-table.' }))?.trim();
        if (!libId) return;
        const r = await prompt({
          title: `Place ${libId}`,
          fields: [
            { key: 'reference', label: 'Reference', type: 'string', default: '', help: 'Empty = next free number for the symbol prefix' },
            { key: 'value', label: 'Value', type: 'string', default: '' },
            { key: 'footprint', label: 'Footprint', type: 'string', default: '' },
            { key: 'unit', label: 'Unit', type: 'number', default: 1 },
          ],
        });
        if (!r) return;
        try {
          const def = await extras.library.symbol(libId);
          const prefix = refOf(def.referenceField?.text) || 'U';
          const used: string[] = [];
          for (const sheet of documents.sheets()) {
            const walk = (s: (typeof sheet)[]): void => {
              for (const x of s) {
                const st = documents.sheet(x.path);
                if (st) used.push(...usedReferences(st, 'KOT_SCH_SYMBOL'));
                walk(x.children);
              }
            };
            walk([sheet]);
          }
          const reference = String(r.reference).trim() || nextReference(prefix, used);
          begin('symbol', { definition: def, reference, value: String(r.value ?? '') || refOf(def.valueField?.text) || libId.split(':').pop(), footprint: String(r.footprint ?? ''), unit: Number(r.unit) || 1 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`OpenDocument(symbol ${libId}) failed: ${msg}`, 'error');
          notify(`Symbol ${libId}: ${msg}`, 'error');
        }
      },
    },
    { id: 'schematic.sheet', title: 'Add hierarchical sheet…', group: 'Place', shortcut: 'S', when: inSchematic, run: () => begin('sheet') },
    {
      id: 'schematic.enterSheet',
      title: 'Enter sheet',
      group: 'Schematic',
      when: inSchematic,
      description: 'Opens the selected hierarchical sheet',
      run: () => {
        const sel = selected();
        const sheet = sel?.items.find((i) => i.type === 'KOT_SCH_SHEET');
        if (!sel || !sheet) return;
        const key = `${sel.id === '/' ? '' : sel.id.replace(/\/$/, '')}/${sheet.id}`;
        const find = (list: ReturnType<typeof documents.sheets>): { path: string; file: string } | undefined => {
          for (const s of list) {
            if (s.path === key || s.path.endsWith(`/${sheet.id}`)) return s;
            const c = find(s.children);
            if (c) return c;
          }
          return undefined;
        };
        const target = find(documents.sheets());
        if (target) useAppStore.getState().openDoc({ kind: 'schematic', id: target.path, title: target.file });
        else notify('Sheet not in the hierarchy yet (save and reopen the project)', 'error');
      },
    },
    // ---------------------------------------------------------- tool control
    { id: 'tool.finish', title: 'Finish tool', group: 'Edit', shortcut: 'Enter', when: (ctx) => inEditor(ctx) && !!activeTool(), hidden: true, run: () => toolFinish() },
    {
      id: 'edit.escape',
      title: 'Cancel / deselect',
      group: 'Edit',
      shortcut: 'Escape',
      when: inEditor,
      run: async (ctx) => {
        if (activeTool()) {
          toolKey('Escape');
          return;
        }
        await getCommand('edit.escape.builtin')?.run(ctx);
      },
    },
    {
      id: 'view.layerFlipSide',
      title: 'Switch active layer between front and back',
      group: 'View',
      shortcut: 'V',
      when: inBoard,
      run: (ctx) => {
        if (activeTool()?.id === 'route') {
          toolKey('V');
          return;
        }
        return getCommand('view.layerFlipSide.builtin')?.run(ctx);
      },
    },
    // ------------------------------------------------------------- editing
    {
      id: 'edit.rotateBy',
      title: 'Rotate by angle…',
      group: 'Edit',
      shortcut: 'Mod+R',
      when: inEditor,
      run: async () => {
        const sel = selected();
        if (!sel || !sel.items.length) return;
        const v = await promptValue<number>('Rotate selection', { label: 'Angle', type: 'number', default: 45, help: '°' }, 'Counter-clockwise, degrees. Schematic symbols snap to 90°.');
        if (v === null || !isFinite(v) || v === 0) return;
        const deg = sel.kind === 'schematic' ? Math.round(v / 90) * 90 : v;
        if (deg === 0) return;
        const all = withChildren(sel.store, sel.items);
        const centre = itemsCentre(sel.items);
        if (!centre) return;
        await commands.run(sel.store, `Rotate ${sel.items.length} item${sel.items.length === 1 ? '' : 's'} by ${deg}°`, (tx) => {
          for (const it of all) {
            const r = rotateItem(it, centre.x, centre.y, deg);
            tx.replace(it.id, r.proto, { bbox: r.bbox });
          }
        });
      },
    },
    {
      id: 'edit.setLayer',
      title: 'Set layer…',
      group: 'Edit',
      when: inBoard,
      run: async () => {
        const sel = selected();
        if (!sel || !sel.items.length) return;
        const layers = documents.layers();
        const current = sel.items[0]!.layer ?? 'BL_F_Cu';
        const v = await promptValue<string>('Set layer', { label: 'Layer', type: 'select', default: current, choices: layers.map((l) => ({ value: l.id, label: l.name })) });
        if (!v) return;
        const target = BoardLayer[v as keyof typeof BoardLayer];
        if (typeof target !== 'number') return;
        const centre = itemsCentre(sel.items);
        await commands.run(sel.store, `Set layer ${layerDisplayName(v)}`, (tx) => {
          for (const it of sel.items) {
            const p = it.proto as Record<string, unknown>;
            if (it.type === 'KOT_PCB_FOOTPRINT') {
              // footprints change side, not layer
              const side = v.startsWith('BL_B_') ? 'BL_B_Cu' : 'BL_F_Cu';
              if (it.layer === side || !centre) continue;
              const f = flipItem(it, centre.x);
              tx.replace(it.id, f.proto, { layer: f.layer, bbox: f.bbox });
              continue;
            }
            if (typeof p.layer === 'number') tx.update(it.id, [{ path: ['layer'], value: target }]);
            else if (typeof p.layer === 'string') tx.update(it.id, [{ path: ['layer'], value: v }]);
            else if (it.type === 'KOT_PCB_ZONE') tx.update(it.id, [{ path: ['layers'], value: [target] }]);
          }
        });
      },
    },
    {
      id: 'edit.setNet',
      title: 'Set net…',
      group: 'Edit',
      when: inBoard,
      keywords: ['assign net'],
      run: async () => {
        const sel = selected();
        if (!sel || !sel.items.length) return;
        const nets = documents.nets();
        const r = await prompt({
          title: 'Set net',
          fields: [
            { key: 'net', label: 'Net', type: 'select', default: sel.items[0]!.net ?? nets[0]?.name ?? '', choices: [{ value: '', label: '<no net>' }, ...nets.map((n) => ({ value: n.name, label: n.name }))] },
            { key: 'custom', label: 'or new net name', type: 'string', default: '' },
          ],
        });
        if (!r) return;
        const name = String(r.custom ?? '').trim() || String(r.net ?? '');
        await commands.run(sel.store, `Set net ${name || '<none>'}`, (tx) => {
          for (const it of sel.items) {
            const p = it.proto as { net?: unknown; settings?: { case?: string } };
            if (it.type === 'KOT_PCB_ZONE' && p.settings?.case === 'copperSettings') tx.update(it.id, [{ path: ['settings', 'value', 'net'], value: { name } }]);
            else if ('net' in p || ['KOT_PCB_TRACE', 'KOT_PCB_VIA', 'KOT_PCB_ARC', 'KOT_PCB_PAD', 'KOT_PCB_SHAPE'].includes(it.type)) tx.update(it.id, [{ path: ['net'], value: { name } }]);
          }
        });
      },
    },
    {
      id: 'edit.copy',
      title: 'Copy',
      group: 'Edit',
      shortcut: 'Mod+C',
      when: inEditor,
      run: () => {
        const sel = selected();
        if (!sel || !sel.items.length) return;
        const items = withChildren(sel.store, sel.items);
        const centre = itemsCentre(sel.items) ?? { x: 0, y: 0 };
        const clip: Clipboard = { items: items.map((i) => ({ ...i, item: undefined, proto: structuredCloneProto(i.proto) })), kind: sel.kind, centre };
        clipboard = clip;
        notify(`Copied ${sel.items.length} item${sel.items.length === 1 ? '' : 's'}`);
        // KiCad's own clipboard format as well (pasteable into the desktop editors and `edit.pasteText`).
        if (clipDocs.saveItemsToString && sel.kind !== 'footprint') {
          void clipDocs
            .saveItemsToString(sel.kind, sel.id, sel.items.map((i) => i.id))
            .then((text) => {
              clip.text = text;
              log(`SaveItemsToString: ${text.length} chars`);
              return typeof navigator !== 'undefined' && navigator.clipboard?.writeText ? navigator.clipboard.writeText(text) : undefined;
            })
            .catch((e: unknown) => log(`SaveItemsToString failed: ${e instanceof Error ? e.message : String(e)}`, 'warn'));
        }
      },
    },
    {
      id: 'edit.cut',
      title: 'Cut',
      group: 'Edit',
      shortcut: 'Mod+X',
      when: inEditor,
      run: async (ctx) => {
        await getCommand('edit.copy')?.run(ctx);
        await getCommand('edit.delete')?.run(ctx);
      },
    },
    {
      id: 'edit.paste',
      title: 'Paste',
      group: 'Edit',
      shortcut: 'Mod+V',
      when: inEditor,
      description: 'Pastes at the cursor (CreateItems with fresh ids)',
      run: async () => {
        const doc = activeDocument(services);
        if (!doc || !clipboard) return;
        const sameFamily = (clipboard.kind === 'schematic') === (doc.kind === 'schematic');
        if (!sameFamily) {
          notify('Clipboard holds items of another document type', 'error');
          return;
        }
        const grid = useUiStore.getState().gridNm;
        const cursor = useEditorStore.getState().docs[doc.key]?.cursor;
        const dx = cursor ? Math.round((cursor.x - clipboard.centre.x) / grid) * grid : grid * 2;
        const dy = cursor ? Math.round((cursor.y - clipboard.centre.y) / grid) * grid : grid * 2;
        const idMap = new Map<string, string>();
        const created: string[] = [];
        const items = clipboard.items.map((it) => cloneForPaste(it, dx, dy, idMap));
        await commands.run(doc.store, `Paste ${items.length} item${items.length === 1 ? '' : 's'}`, (tx) => {
          for (const it of items) {
            tx.create(it);
            if (!it.parent) created.push(it.id);
          }
        });
        useEditorStore.getState().setSelection(doc.key, created);
      },
    },
    {
      id: 'edit.pasteText',
      title: 'Paste KiCad clipboard text…',
      group: 'Edit',
      when: (ctx) => ctx.editor === 'board' || ctx.editor === 'schematic',
      keywords: ['ParseAndCreateItemsFromString', 's-expression', 'clipboard'],
      description: 'Pastes KiCad clipboard s-expression text (as copied from the desktop editors or Copy here) through ParseAndCreateItemsFromString',
      run: async () => {
        const doc = activeDocument(services);
        if (!doc) return;
        if (!clipDocs.parseAndCreate) {
          notify('Pasting KiCad clipboard text needs the KiCad services (the mock cannot parse s-expressions)', 'error');
          return;
        }
        let initial = clipboard?.text ?? '';
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          try {
            const sys = await navigator.clipboard.readText();
            if (sys.trim().startsWith('(')) initial = sys;
          } catch {
            /* permission denied: fall back to the in-app text */
          }
        }
        const r = await prompt({
          title: 'Paste KiCad clipboard text',
          description: 'The text is parsed by KiCad (ParseAndCreateItemsFromString); items get fresh ids and land at their original coordinates.',
          fields: [{ key: 'text', label: 'Text', type: 'multiline', default: initial }],
          okLabel: 'Paste',
        });
        const text = String(r?.text ?? '').trim();
        if (!text) return;
        try {
          const created = await clipDocs.parseAndCreate(doc.kind, doc.id, text);
          commands.record(
            doc.store,
            `Paste ${created.length} item${created.length === 1 ? '' : 's'} (KiCad text)`,
            created.map((item) => ({ kind: 'create' as const, item })),
            created.map((item) => ({ kind: 'delete' as const, item })),
          );
          useEditorStore.getState().setSelection(doc.key, created.filter((i) => !i.parent).map((i) => i.id));
          notify(`Pasted ${created.length} item${created.length === 1 ? '' : 's'} from KiCad text`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`ParseAndCreateItemsFromString failed: ${msg}`, 'error');
          notify(`Paste failed: ${msg}`, 'error');
        }
      },
    },
    ...alignCommands(services, selected),
    // -------------------------------------------------------------- windows
    {
      id: 'window.view3d',
      title: 'Open 3D viewer',
      group: 'Window',
      shortcut: 'Alt+3',
      keywords: ['glb', 'step', 'three'],
      when: () => !!documents.board(),
      run: () => useAppStore.getState().openDoc({ kind: '3d', id: '3d', title: '3D view' }),
    },
    { id: 'tools.pageSettings', title: 'Page settings / title block…', group: 'Tools', when: (ctx) => ctx.editor === 'board' || ctx.editor === 'schematic', keywords: ['drawing sheet', 'title'], run: () => useUiStore.getState().openDialog('page-settings') },
    {
      id: 'inspect.crossProbe',
      title: 'Cross-probe: show in the other editor',
      group: 'Inspect',
      shortcut: 'Mod+Shift+X',
      when: (ctx) => ctx.editor === 'board' || ctx.editor === 'schematic',
      description: 'Selects the symbol / footprint with the same reference in the schematic / board and switches to it',
      run: () => {
        const r = crossProbeSelection(services, { jump: true });
        if (!r) notify('No counterpart found for the selection', 'error');
      },
    },
  ];

  // keep the builtin bodies reachable under aliases
  const escapeBuiltin = getCommand('edit.escape');
  const flipBuiltin = getCommand('view.layerFlipSide');
  const aliases: Command[] = [];
  if (escapeBuiltin) aliases.push({ ...escapeBuiltin, id: 'edit.escape.builtin', hidden: true, shortcut: undefined });
  if (flipBuiltin) aliases.push({ ...flipBuiltin, id: 'view.layerFlipSide.builtin', hidden: true, shortcut: undefined });
  const off1 = registerCommands(aliases);
  const off2 = registerCommands(list);
  return () => {
    off2();
    off1();
    cancelTool();
  };
}

function structuredCloneProto<T>(p: T): T {
  // protobuf messages are plain objects (+ bigint) — structuredClone keeps both
  return structuredClone(p);
}

type Selected = () => (ReturnType<typeof activeDocument> & { items: StoredItem[] }) | null;

function alignCommands(services: Services, selected: Selected): Command[] {
  const { commands } = services;
  const box = (it: StoredItem) => it.bbox ?? (itemAnchor(it) ? { x: itemAnchor(it)!.x, y: itemAnchor(it)!.y, w: 0, h: 0 } : null);
  const run = (id: string, title: string, shortcut: string | undefined, fn: (items: { it: StoredItem; b: NonNullable<ReturnType<typeof box>> }[]) => Map<string, { dx: number; dy: number }>): Command => ({
    id,
    title,
    group: 'Edit',
    shortcut,
    when: (ctx) => ctx.editor !== 'project' && ctx.editor !== '3d',
    keywords: ['align', 'distribute'],
    run: async () => {
      const sel = selected();
      if (!sel || sel.items.length < 2) return;
      const rows = sel.items.map((it) => ({ it, b: box(it) })).filter((r): r is { it: StoredItem; b: NonNullable<ReturnType<typeof box>> } => !!r.b);
      const moves = fn(rows);
      const grid = useUiStore.getState().gridNm;
      await commands.run(sel.store, `${title} (${rows.length} items)`, (tx) => {
        for (const { it } of rows) {
          const m = moves.get(it.id);
          if (!m || (m.dx === 0 && m.dy === 0)) continue;
          const dx = it.type === 'KOT_SCH_SYMBOL' ? Math.round(m.dx / grid) * grid : m.dx;
          const dy = it.type === 'KOT_SCH_SYMBOL' ? Math.round(m.dy / grid) * grid : m.dy;
          for (const target of [it, ...childrenOf(sel.store, it.id)]) {
            const moved = translateItem(target, dx, dy);
            tx.replace(target.id, moved.proto, { bbox: moved.bbox });
          }
        }
      });
    },
  });
  const edge = (pick: (b: { x: number; y: number; w: number; h: number }) => number, reduce: (a: number, b: number) => number, axis: 'x' | 'y') => (rows: { it: StoredItem; b: { x: number; y: number; w: number; h: number } }[]) => {
    const target = rows.map((r) => pick(r.b)).reduce((a, b) => reduce(a, b));
    return new Map(rows.map((r) => [r.it.id, axis === 'x' ? { dx: target - pick(r.b), dy: 0 } : { dx: 0, dy: target - pick(r.b) }]));
  };
  const distribute = (axis: 'x' | 'y') => (rows: { it: StoredItem; b: { x: number; y: number; w: number; h: number } }[]) => {
    const sorted = rows.slice().sort((a, b) => (axis === 'x' ? a.b.x + a.b.w / 2 - (b.b.x + b.b.w / 2) : a.b.y + a.b.h / 2 - (b.b.y + b.b.h / 2)));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const c = (r: typeof first) => (axis === 'x' ? r.b.x + r.b.w / 2 : r.b.y + r.b.h / 2);
    const step = (c(last) - c(first)) / Math.max(1, sorted.length - 1);
    return new Map(sorted.map((r, i) => [r.it.id, axis === 'x' ? { dx: c(first) + i * step - c(r), dy: 0 } : { dx: 0, dy: c(first) + i * step - c(r) }]));
  };
  return [
    run('edit.alignLeft', 'Align left', undefined, edge((b) => b.x, Math.min, 'x')),
    run('edit.alignRight', 'Align right', undefined, edge((b) => b.x + b.w, Math.max, 'x')),
    run('edit.alignTop', 'Align top', undefined, edge((b) => b.y, Math.min, 'y')),
    run('edit.alignBottom', 'Align bottom', undefined, edge((b) => b.y + b.h, Math.max, 'y')),
    run('edit.alignCenterX', 'Align centres vertically', undefined, edge((b) => b.x + b.w / 2, (a, b) => (a + b) / 2, 'x')),
    run('edit.alignCenterY', 'Align centres horizontally', undefined, edge((b) => b.y + b.h / 2, (a, b) => (a + b) / 2, 'y')),
    run('edit.distributeH', 'Distribute horizontally', undefined, distribute('x')),
    run('edit.distributeV', 'Distribute vertically', undefined, distribute('y')),
  ];
}

export { storeKeyFor };
