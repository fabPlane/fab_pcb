// Interactive placement tools. A tool session collects snapped world points from canvas
// clicks (CanvasSlot routes picks here while a tool is active), draws a preview through
// `ToolOverlay`, and on finish turns the points into items with the factories in
// `lib/create.ts`, committed as one transaction (BeginCommit → CreateItems → EndCommit).
//
//   board:     route (V = via + layer switch), via, line, rect, circle, arc, polygon, text,
//              zone (outline → net/layer prompt → RefillZones), footprint (library definition)
//   schematic: wire / bus (90° bends), junction, no-connect, label / global / hierarchical,
//              text, symbol (library definition), sheet (rect → name/file prompt)

import { create } from 'zustand';
import type { DocumentKind, ItemStore, PickResult, StoredItem } from '@/contracts';
import type { Services } from '@/services/types';
import { useAppStore } from '@/state/appStore';
import { useEditorStore } from '@/state/editorStore';
import { log } from '@/state/logStore';
import { prompt } from '@/state/promptStore';
import { useUiStore } from '@/state/uiStore';
import { snap } from '@/lib/geometry';
import {
  makeBoardShape,
  makeBoardText,
  makeFootprintInstance,
  makeJunction,
  makeLabel,
  makeNoConnect,
  makeSchematicLine,
  makeSchematicText,
  makeSheet,
  makeSymbolInstance,
  makeTrack,
  makeVia,
  makeZone,
  type LabelKind,
  type LabelShape,
  type LibraryFootprint,
  type Pt,
} from '@/lib/create';
import type { SchematicSymbol as SchematicSymbolDefinition } from '@fp-pcb/proto';

export type ToolId =
  | 'route'
  | 'via'
  | 'line'
  | 'rect'
  | 'circle'
  | 'arc'
  | 'polygon'
  | 'text'
  | 'zone'
  | 'footprint'
  | 'wire'
  | 'bus'
  | 'junction'
  | 'noconnect'
  | 'label'
  | 'globalLabel'
  | 'hierLabel'
  | 'schText'
  | 'symbol'
  | 'sheet';

export interface ToolPoint extends Pt {
  layer?: string;
}

export interface RouteVia {
  at: Pt;
  from: string;
  to: string;
}

export interface ToolSession {
  id: ToolId;
  /** Increments per startTool: writes after an await are skipped when a newer session replaced this one. */
  seq: number;
  storeKey: string;
  kind: DocumentKind;
  store: ItemStore;
  points: ToolPoint[];
  params: Record<string, unknown>;
  vias: RouteVia[];
  /** net picked up from the first click (routing) */
  net?: string;
  hint: string;
}

export type PreviewShape =
  | { kind: 'polyline'; pts: Pt[]; width: number; closed?: boolean; dashed?: boolean }
  | { kind: 'circle'; c: Pt; r: number; width: number }
  | { kind: 'rect'; a: Pt; b: Pt; width: number }
  | { kind: 'marker'; c: Pt; label?: string };

interface ToolState {
  session: ToolSession | null;
  lastClick: { t: number; x: number; y: number } | null;
  setSession(s: ToolSession | null): void;
}

export const useToolStore = create<ToolState>((set) => ({
  session: null,
  lastClick: null,
  setSession: (session) => set({ session }),
}));

let services: Services | null = null;
let toolSeq = 0;

/** True while `s` is still the live session (nothing started or cancelled a tool since). */
const stillActive = (s: Pick<ToolSession, 'seq'>): boolean => useToolStore.getState().session?.seq === s.seq;

/** Called once from the composition root; tools need the command service and documents. */
export function bindTools(s: Services): void {
  services = s;
}

const HINTS: Record<ToolId, string> = {
  route: 'Route: click to add segments · V places a via and switches layer · double-click / Enter finishes · Esc cancels',
  via: 'Via: click to place (repeat) · Esc to stop',
  line: 'Line: click start, click end (chains) · Esc to stop',
  rect: 'Rectangle: click two corners',
  circle: 'Circle: click centre, then a point on the radius',
  arc: 'Arc: click start, end, then a point on the arc',
  polygon: 'Polygon: click corners · double-click / Enter closes · Esc cancels',
  text: 'Text: click to place',
  zone: 'Zone outline: click corners · double-click / Enter closes, then choose net and layer',
  footprint: 'Footprint: click to place',
  wire: 'Wire: click to add 90° bends · double-click / Enter finishes · Esc cancels',
  bus: 'Bus: click to add 90° bends · double-click / Enter finishes · Esc cancels',
  junction: 'Junction: click to place (repeat) · Esc to stop',
  noconnect: 'No-connect: click on a pin end (repeat) · Esc to stop',
  label: 'Label: click to place',
  globalLabel: 'Global label: click to place',
  hierLabel: 'Hierarchical label: click to place',
  schText: 'Text: click to place',
  symbol: 'Symbol: click to place',
  sheet: 'Sheet: click two corners, then name it',
};

const ONE_SHOT = new Set<ToolId>(['text', 'footprint', 'label', 'globalLabel', 'hierLabel', 'schText', 'symbol', 'rect', 'circle', 'arc', 'sheet']);

export function activeTool(storeKey?: string): ToolSession | null {
  const s = useToolStore.getState().session;
  if (!s) return null;
  return storeKey === undefined || s.storeKey === storeKey ? s : null;
}

export function startTool(id: ToolId, doc: { key: string; kind: DocumentKind; store: ItemStore }, params: Record<string, unknown> = {}): void {
  const session: ToolSession = { id, seq: ++toolSeq, storeKey: doc.key, kind: doc.kind, store: doc.store, points: [], params, vias: [], hint: HINTS[id] };
  useToolStore.setState({ session, lastClick: null });
  useEditorStore.getState().setTool(doc.key, id);
  useEditorStore.getState().setSelection(doc.key, []);
}

export function cancelTool(): void {
  const s = useToolStore.getState().session;
  if (!s) return;
  useToolStore.setState({ session: null, lastClick: null });
  useEditorStore.getState().setTool(s.storeKey, 'select');
}

function snapPt(p: Pt): Pt {
  const g = useUiStore.getState().gridNm;
  return { x: snap(p.x, g), y: snap(p.y, g) };
}

function activeLayer(storeKey: string): string {
  return useEditorStore.getState().docs[storeKey]?.activeLayer ?? 'BL_F_Cu';
}

/** Track width / via sizes from the Default net class, else the design-rule minimums, else KiCad's defaults. */
export function routingDefaults(): { trackWidthNm: number; viaDiameterNm: number; viaDrillNm: number } {
  const docs = services?.documents;
  const nc = docs?.netclasses().find((n) => n.name === 'Default') ?? docs?.netclasses()[0];
  const rules = docs?.boardSetup().rules;
  return {
    trackWidthNm: nc?.trackWidthNm || rules?.minTrackWidthNm || 200_000,
    viaDiameterNm: nc?.viaDiameterNm || rules?.minViaDiameterNm || 600_000,
    viaDrillNm: nc?.viaDrillNm || rules?.minViaDrillNm || 300_000,
  };
}

/** Commits new items through the command service; the created ids become the selection. */
export async function createItems(session: Pick<ToolSession, 'store' | 'storeKey'>, message: string, items: StoredItem[]): Promise<boolean> {
  if (!services || items.length === 0) return false;
  try {
    await services.commands.run(session.store, message, (tx) => {
      for (const it of items) tx.create(it);
    });
    useEditorStore.getState().setSelection(session.storeKey, items.map((i) => i.id));
    useAppStore.getState().notify(message);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${message} failed: ${msg}`, 'error');
    useAppStore.getState().notify(`${message} failed: ${msg}`, 'error');
    return false;
  }
}

function isDoubleClick(p: Pt): boolean {
  const st = useToolStore.getState();
  const now = Date.now();
  const last = st.lastClick;
  useToolStore.setState({ lastClick: { t: now, x: p.x, y: p.y } });
  return !!last && now - last.t < 400 && last.x === p.x && last.y === p.y;
}

/** A canvas click while a tool is active. `hit` is the top pick result (net pickup for routing). */
export async function toolClick(storeKey: string, world: Pt, hit?: PickResult | null): Promise<void> {
  const s = activeTool(storeKey);
  if (!s) return;
  const p = snapPt(world);
  if (isDoubleClick(p)) {
    await toolFinish();
    return;
  }
  const layer = activeLayer(storeKey);
  const push = (pt: Pt) => useToolStore.setState({ session: { ...s, points: [...s.points, { ...pt, layer }] } });
  switch (s.id) {
    case 'route': {
      if (s.points.length === 0) {
        useToolStore.setState({ session: { ...s, points: [{ ...p, layer }], net: s.net ?? hit?.net } });
        return;
      }
      const last = s.points[s.points.length - 1]!;
      if (last.x === p.x && last.y === p.y) return;
      push(p);
      return;
    }
    case 'wire':
    case 'bus': {
      if (s.points.length === 0) {
        push(p);
        return;
      }
      const last = s.points[s.points.length - 1]!;
      const corner = { x: p.x, y: last.y };
      const pts = [...s.points];
      if (corner.x !== last.x || corner.y !== last.y) if (!(corner.x === p.x && corner.y === p.y)) pts.push({ ...corner, layer });
      if (!(last.x === p.x && last.y === p.y)) pts.push({ ...p, layer });
      useToolStore.setState({ session: { ...s, points: pts } });
      return;
    }
    case 'polygon':
    case 'zone': {
      const first = s.points[0];
      if (first && s.points.length >= 3 && first.x === p.x && first.y === p.y) {
        await toolFinish();
        return;
      }
      push(p);
      return;
    }
    case 'line': {
      if (s.points.length === 0) {
        push(p);
        return;
      }
      const a = s.points[s.points.length - 1]!;
      if (a.x === p.x && a.y === p.y) return;
      const width = Number(s.params.widthNm ?? 150_000);
      await createItems(s, 'Draw line', [makeBoardShape({ kind: 'segment', a, b: p }, layer, width)]);
      if (stillActive(s)) useToolStore.setState({ session: { ...useToolStore.getState().session!, points: [{ ...p, layer }] } });
      return;
    }
    case 'rect':
    case 'sheet': {
      if (s.points.length === 0) {
        push(p);
        return;
      }
      push(p);
      await toolFinish();
      return;
    }
    case 'circle': {
      push(p);
      if (s.points.length + 1 >= 2) await toolFinish();
      return;
    }
    case 'arc': {
      push(p);
      if (s.points.length + 1 >= 3) await toolFinish();
      return;
    }
    case 'via': {
      const d = routingDefaults();
      const copper = (services?.documents.layers() ?? []).filter((l) => l.kind === 'copper').map((l) => l.id);
      await createItems(s, 'Place via', [makeVia(p, { diameterNm: Number(s.params.diameterNm ?? d.viaDiameterNm), drillNm: Number(s.params.drillNm ?? d.viaDrillNm), layers: copper.length ? [copper[0]!, copper[copper.length - 1]!] : undefined, net: hit?.net })]);
      return;
    }
    case 'junction':
      await createItems(s, 'Place junction', [makeJunction(p)]);
      return;
    case 'noconnect':
      await createItems(s, 'Place no-connect', [makeNoConnect(p)]);
      return;
    case 'text': {
      const ok = await createItems(s, 'Place text', [makeBoardText(p, layer, { text: String(s.params.text ?? 'TEXT'), sizeNm: Number(s.params.sizeNm ?? 1_000_000) })]);
      if (ok && stillActive(s)) cancelTool();
      return;
    }
    case 'schText': {
      const ok = await createItems(s, 'Place text', [makeSchematicText(p, String(s.params.text ?? 'Text'), Number(s.params.sizeNm ?? 1_270_000))]);
      if (ok && stillActive(s)) cancelTool();
      return;
    }
    case 'label':
    case 'globalLabel':
    case 'hierLabel': {
      const kind: LabelKind = s.id === 'label' ? 'local' : s.id === 'globalLabel' ? 'global' : 'hier';
      const title = kind === 'local' ? 'Place label' : kind === 'global' ? 'Place global label' : 'Place hierarchical label';
      const ok = await createItems(s, title, [makeLabel(p, kind, String(s.params.text ?? 'NET'), { shape: (s.params.shape as LabelShape | undefined) ?? 'input', sizeNm: Number(s.params.sizeNm ?? 1_270_000) })]);
      if (ok && stillActive(s)) cancelTool();
      return;
    }
    case 'footprint': {
      const lib = s.params.library as LibraryFootprint;
      const ok = await createItems(s, `Place footprint ${s.params.reference}`, [makeFootprintInstance(p, layer.endsWith('_Cu') ? layer : 'BL_F_Cu', lib, String(s.params.reference), s.params.value as string | undefined)]);
      if (ok && stillActive(s)) cancelTool();
      return;
    }
    case 'symbol': {
      const def = s.params.definition as SchematicSymbolDefinition;
      const ok = await createItems(s, `Place symbol ${s.params.reference}`, [makeSymbolInstance(p, def, String(s.params.reference), String(s.params.value ?? ''), { unit: Number(s.params.unit ?? 1), footprint: s.params.footprint as string | undefined })]);
      if (ok && stillActive(s)) cancelTool();
      return;
    }
  }
}

/** Enter / double-click: turns the collected points into items. */
export async function toolFinish(): Promise<void> {
  const s = useToolStore.getState().session;
  if (!s) return;
  const pts = s.points;
  const layer = activeLayer(s.storeKey);
  const done = (ok: boolean, repeat = false) => {
    if (!ok || !stillActive(s)) return;
    if (repeat && !ONE_SHOT.has(s.id)) useToolStore.setState({ session: { ...s, points: [], vias: [], net: undefined } });
    else cancelTool();
  };
  switch (s.id) {
    case 'route': {
      const d = routingDefaults();
      const width = Number(s.params.widthNm ?? d.trackWidthNm);
      const items: StoredItem[] = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (a.x === b.x && a.y === b.y) continue;
        items.push(makeTrack(a, b, width, a.layer ?? layer, s.net));
      }
      for (const v of s.vias) items.push(makeVia(v.at, { diameterNm: d.viaDiameterNm, drillNm: d.viaDrillNm, layers: [v.from, v.to], net: s.net }));
      if (!items.length) {
        cancelTool();
        return;
      }
      done(await createItems(s, `Route ${items.length} item${items.length === 1 ? '' : 's'}${s.net ? ` on ${s.net}` : ''}`, items), true);
      return;
    }
    case 'wire':
    case 'bus': {
      const items: StoredItem[] = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (a.x === b.x && a.y === b.y) continue;
        items.push(makeSchematicLine(a, b, s.id));
      }
      if (!items.length) {
        cancelTool();
        return;
      }
      done(await createItems(s, `Draw ${s.id} (${items.length} segment${items.length === 1 ? '' : 's'})`, items), true);
      return;
    }
    case 'polygon': {
      if (pts.length < 3) {
        cancelTool();
        return;
      }
      done(await createItems(s, 'Draw polygon', [makeBoardShape({ kind: 'polygon', pts }, layer, Number(s.params.widthNm ?? 150_000), { filled: Boolean(s.params.filled) })]));
      return;
    }
    case 'rect': {
      if (pts.length < 2) return;
      done(await createItems(s, 'Draw rectangle', [makeBoardShape({ kind: 'rect', a: pts[0]!, b: pts[1]! }, layer, Number(s.params.widthNm ?? 150_000))]));
      return;
    }
    case 'circle': {
      if (pts.length < 2) return;
      const r = Math.hypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
      done(await createItems(s, 'Draw circle', [makeBoardShape({ kind: 'circle', c: pts[0]!, r }, layer, Number(s.params.widthNm ?? 150_000))]));
      return;
    }
    case 'arc': {
      if (pts.length < 3) return;
      done(await createItems(s, 'Draw arc', [makeBoardShape({ kind: 'arc', start: pts[0]!, mid: pts[2]!, end: pts[1]! }, layer, Number(s.params.widthNm ?? 150_000))]));
      return;
    }
    case 'zone': {
      if (pts.length < 3) {
        cancelTool();
        return;
      }
      const nets = services?.documents.nets() ?? [];
      const copper = (services?.documents.layers() ?? []).filter((l) => l.kind === 'copper');
      const answer = await prompt({
        title: 'Zone properties',
        description: `${pts.length}-corner outline`,
        fields: [
          { key: 'net', label: 'Net', type: 'select', default: s.params.net ?? nets[0]?.name ?? '', choices: [{ value: '', label: '<no net>' }, ...nets.map((n) => ({ value: n.name, label: n.name }))] },
          { key: 'layer', label: 'Layer', type: 'select', default: layer.endsWith('_Cu') ? layer : 'BL_F_Cu', choices: copper.map((l) => ({ value: l.id, label: l.name })) },
          { key: 'name', label: 'Name', type: 'string', default: '' },
          { key: 'clearance', label: 'Clearance', type: 'distance', default: 200_000 },
          { key: 'minThickness', label: 'Min. width', type: 'distance', default: 250_000 },
          { key: 'keepout', label: 'Rule area (keep-out)', type: 'boolean', default: false },
        ],
      });
      if (!answer) {
        if (stillActive(s)) cancelTool();
        return;
      }
      const ok = await createItems(s, 'Add zone', [makeZone(pts, [String(answer.layer)], { net: String(answer.net) || undefined, name: String(answer.name), clearanceNm: Number(answer.clearance), minThicknessNm: Number(answer.minThickness), keepout: Boolean(answer.keepout) })]);
      if (ok && !answer.keepout) {
        const refill = (services?.documents as { refillZones?: () => Promise<void> } | undefined)?.refillZones;
        if (refill) {
          try {
            await refill.call(services!.documents);
            log('RefillZones after zone creation');
          } catch (e) {
            log(`RefillZones failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
          }
        }
      }
      done(ok);
      return;
    }
    case 'sheet': {
      if (pts.length < 2) return;
      const used = new Set<string>();
      for (const it of s.store.byType('KOT_SCH_SHEET')) used.add(String((it.proto as { filenameField?: { text?: { text?: string } } }).filenameField?.text?.text ?? ''));
      let n = 1;
      while (used.has(`sheet${n}.kicad_sch`)) n++;
      const answer = await prompt({
        title: 'New hierarchical sheet',
        fields: [
          { key: 'name', label: 'Sheet name', type: 'string', default: `Sheet${n}` },
          { key: 'file', label: 'File name', type: 'string', default: `sheet${n}.kicad_sch`, help: 'Relative to the project; KiCad creates it on save' },
        ],
      });
      if (!answer) {
        if (stillActive(s)) cancelTool();
        return;
      }
      const ok = await createItems(s, `Add sheet ${answer.name}`, [makeSheet(pts[0]!, pts[1]!, String(answer.name), String(answer.file))]);
      if (ok) {
        const reload = (services?.documents as { reloadHierarchy?: () => Promise<void> } | undefined)?.reloadHierarchy;
        if (reload) await reload.call(services!.documents).catch((e: unknown) => log(`hierarchy reload failed: ${e instanceof Error ? e.message : String(e)}`, 'warn'));
      }
      done(ok);
      return;
    }
    default:
      cancelTool();
  }
}

/** Key handling while a tool is active: returns true when the key was consumed. */
export function toolKey(key: string): boolean {
  const s = useToolStore.getState().session;
  if (!s) return false;
  if (key === 'Escape') {
    if (s.points.length > 0 && (s.id === 'route' || s.id === 'wire' || s.id === 'bus' || s.id === 'polygon' || s.id === 'zone')) {
      // first Escape drops the pending run, second leaves the tool
      useToolStore.setState({ session: { ...s, points: [], vias: [], net: undefined } });
      return true;
    }
    cancelTool();
    return true;
  }
  if (key === 'Enter') {
    void toolFinish();
    return true;
  }
  if ((key === 'v' || key === 'V') && s.id === 'route') {
    const at = s.points[s.points.length - 1];
    if (!at) return true;
    const copper = (services?.documents.layers() ?? []).filter((l) => l.kind === 'copper').map((l) => l.id);
    const from = activeLayer(s.storeKey);
    const to = from === copper[0] ? (copper[copper.length - 1] ?? 'BL_B_Cu') : (copper[0] ?? 'BL_F_Cu');
    useEditorStore.getState().setActiveLayer(s.storeKey, to);
    const points = s.points.slice();
    points[points.length - 1] = { ...at, layer: to };
    useToolStore.setState({ session: { ...s, points, vias: [...s.vias, { at, from, to }] } });
    return true;
  }
  return false;
}

/** Preview geometry (world nm) for the overlay. */
export function toolPreview(s: ToolSession, cursor: Pt | null): PreviewShape[] {
  const c = cursor ? snapPt(cursor) : null;
  const out: PreviewShape[] = [];
  const pts = s.points;
  const d = routingDefaults();
  switch (s.id) {
    case 'route': {
      const width = Number(s.params.widthNm ?? d.trackWidthNm);
      if (pts.length) out.push({ kind: 'polyline', pts: c ? [...pts, c] : pts, width });
      for (const v of s.vias) out.push({ kind: 'circle', c: v.at, r: d.viaDiameterNm / 2, width: 0 });
      if (c) out.push({ kind: 'marker', c });
      return out;
    }
    case 'wire':
    case 'bus': {
      const w = s.id === 'bus' ? 300_000 : 150_000;
      const all = pts.slice();
      if (c && pts.length) {
        const last = pts[pts.length - 1]!;
        all.push({ x: c.x, y: last.y }, c);
      }
      if (all.length > 1) out.push({ kind: 'polyline', pts: all, width: w });
      if (c) out.push({ kind: 'marker', c });
      return out;
    }
    case 'line':
      if (pts.length && c) out.push({ kind: 'polyline', pts: [pts[pts.length - 1]!, c], width: Number(s.params.widthNm ?? 150_000) });
      if (c) out.push({ kind: 'marker', c });
      return out;
    case 'rect':
    case 'sheet':
      if (pts.length && c) out.push({ kind: 'rect', a: pts[0]!, b: c, width: 150_000 });
      if (c) out.push({ kind: 'marker', c });
      return out;
    case 'circle':
      if (pts.length && c) out.push({ kind: 'circle', c: pts[0]!, r: Math.hypot(c.x - pts[0]!.x, c.y - pts[0]!.y), width: 150_000 });
      if (c) out.push({ kind: 'marker', c });
      return out;
    case 'arc':
      if (pts.length >= 1 && c) out.push({ kind: 'polyline', pts: [...pts, c], width: 150_000, dashed: true });
      if (c) out.push({ kind: 'marker', c });
      return out;
    case 'polygon':
    case 'zone':
      if (pts.length) out.push({ kind: 'polyline', pts: c ? [...pts, c] : pts, width: 150_000, closed: pts.length >= 2, dashed: s.id === 'zone' });
      if (c) out.push({ kind: 'marker', c });
      return out;
    case 'via':
      if (c) out.push({ kind: 'circle', c, r: Number(s.params.diameterNm ?? d.viaDiameterNm) / 2, width: 0 });
      return out;
    case 'footprint': {
      if (!c) return out;
      const lib = s.params.library as LibraryFootprint | undefined;
      for (const m of lib?.items ?? []) {
        const p = (m as { position?: { xNm: bigint | number; yNm: bigint | number }; $typeName?: string }).position;
        if (p && (m as { $typeName?: string }).$typeName === 'kiapi.board.types.Pad') out.push({ kind: 'circle', c: { x: c.x + Number(p.xNm), y: c.y + Number(p.yNm) }, r: 400_000, width: 0 });
      }
      out.push({ kind: 'marker', c, label: String(s.params.reference ?? '') });
      return out;
    }
    case 'symbol':
      if (c) out.push({ kind: 'rect', a: { x: c.x - 2_540_000, y: c.y - 3_810_000 }, b: { x: c.x + 2_540_000, y: c.y + 3_810_000 }, width: 0 }, { kind: 'marker', c, label: String(s.params.reference ?? '') });
      return out;
    default:
      if (c) out.push({ kind: 'marker', c, label: s.params.text ? String(s.params.text) : undefined });
      return out;
  }
}
