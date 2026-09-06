// Mounts a CanvasHost into a div and wires it to the editor store:
//   pick  -> selection (click, shift-click toggles)
//   hover -> hover id + cursor world position (status bar)
//   camera -> editor store (status bar zoom)
//   store -> selection / layer visibility / opacity / active layer / net highlight
// Also hosts the interactive move tool: press M with a selection, the pointer drags the
// items through an open transaction, click commits, Esc drops.

import { useEffect, useRef, useState } from 'react';
import type { CanvasHost, DocumentKind, ItemStore, PickResult } from '@/contracts';
import { useServices } from '@/services';
import type { Transaction } from '@/services/types';
import { useEditorStore } from '@/state/editorStore';
import { useUiStore, resolveTheme } from '@/state/uiStore';
import { translateItem, snap } from '@/lib/geometry';
import { createCanvasHost } from './hostFactory';
import { themeFor } from './theme';
import { MockCanvasHost } from './MockCanvasHost';
import { ToolOverlay } from './ToolOverlay';
import { activeTool, toolClick, toolFinish, useToolStore } from './tools';
import { CanvasContextMenu, type ContextMenuState } from './CanvasContextMenu';

export interface CanvasSlotProps {
  kind: DocumentKind;
  storeKey: string;
  store: ItemStore;
  layers: string[];
}

/** Per-slot registry so commands (zoom, fit, move) can reach the mounted host. */
const hosts = new Map<string, CanvasHost>();
export function getCanvasHost(storeKey: string): CanvasHost | undefined {
  return hosts.get(storeKey);
}

interface MoveSession {
  tx: Transaction;
  ids: string[];
  origin: { x: number; y: number };
  last: { dx: number; dy: number };
}
const moveSessions = new Map<string, MoveSession>();

export function beginMove(storeKey: string, store: ItemStore, tx: Transaction, ids: string[], origin: { x: number; y: number }): void {
  moveSessions.set(storeKey, { tx, ids, origin, last: { dx: 0, dy: 0 } });
  useEditorStore.getState().setTool(storeKey, 'move');
}

export async function endMove(storeKey: string, commit: boolean): Promise<void> {
  const s = moveSessions.get(storeKey);
  if (!s) return;
  moveSessions.delete(storeKey);
  useEditorStore.getState().setTool(storeKey, 'select');
  if (commit) await s.tx.commit();
  else await s.tx.drop();
}

export function isMoving(storeKey: string): boolean {
  return moveSessions.has(storeKey);
}

export function currentMoveTransaction(storeKey: string): Transaction | null {
  return moveSessions.get(storeKey)?.tx ?? null;
}

/** Renderer hosts expose the grid through `overlays.options`; the contract itself has no grid API. */
function applyGrid(host: CanvasHost, gridNm: number, show: boolean): void {
  const h = host as CanvasHost & { overlays?: { options: Record<string, unknown> }; requestRender?: () => void };
  if (!h.overlays) return;
  Object.assign(h.overlays.options, { showGrid: show, gridNm, gridSpacing: gridNm });
  h.requestRender?.();
}

export function CanvasSlot({ kind, storeKey, store, layers }: CanvasSlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<CanvasHost | null>(null);
  const services = useServices();
  const themeMode = useUiStore((s) => s.theme);
  const gridNm = useUiStore((s) => s.gridNm);
  const showGrid = useUiStore((s) => s.showGrid);
  const doc = useEditorStore((s) => s.docs[storeKey]);
  const ensure = useEditorStore((s) => s.ensure);
  const toolSession = useToolStore((s) => s.session);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => ensure(storeKey, kind), [ensure, storeKey, kind]);

  // mount / unmount
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const host = createCanvasHost(kind, storeKey, store);
    hostRef.current = host;
    hosts.set(storeKey, host);
    // Subscribed before mount so the host's own zoom-to-fit (emitted during / right after
    // mount) is what the store records; the store is never seeded with the pre-fit default.
    const offCam = host.onCameraChange((cam) => useEditorStore.getState().setCamera(storeKey, cam));
    host.mount(el, store, themeFor(resolveTheme(useUiStore.getState().theme)));
    // Restore the camera only when this document was viewed before.
    const d = useEditorStore.getState().docs[storeKey];
    if (d && d.camera.zoom > 0) host.setCamera(d.camera);
    if (host instanceof MockCanvasHost) host.setGrid(useUiStore.getState().gridNm, useUiStore.getState().showGrid);
    else applyGrid(host, useUiStore.getState().gridNm, useUiStore.getState().showGrid);

    // What the UI treats as picked: the object KIID (`ref`) when the store holds it (a pad,
    // a track), else the owning store item (footprint / symbol for their children).
    const pickedId = (hit: PickResult): string => (store.get(hit.ref) ? hit.ref : store.get(hit.owner) ? hit.owner : hit.ref);

    const offPick = host.onPick((hits, ev) => {
      const s = useEditorStore.getState();
      if (moveSessions.has(storeKey)) {
        void endMove(storeKey, true);
        return;
      }
      if (activeTool(storeKey)) {
        const rect = el.getBoundingClientRect();
        const world = host.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
        void toolClick(storeKey, world, hits[0] ?? null);
        return;
      }
      const top = hits[0];
      if (!top) {
        if (!ev.shiftKey) s.setSelection(storeKey, []);
        return;
      }
      const id = pickedId(top);
      if (ev.shiftKey) s.toggleSelection(storeKey, id);
      else s.setSelection(storeKey, [id]);
    });
    const offHover = host.onHover((hit, ev) => {
      const s = useEditorStore.getState();
      const rect = el.getBoundingClientRect();
      const world = host.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      s.setCursor(storeKey, world);
      s.setHover(storeKey, hit ? pickedId(hit) : null);
      const mv = moveSessions.get(storeKey);
      if (mv) {
        const grid = useUiStore.getState().gridNm;
        const dx = snap(world.x - mv.origin.x, grid);
        const dy = snap(world.y - mv.origin.y, grid);
        if (dx === mv.last.dx && dy === mv.last.dy) return;
        const ddx = dx - mv.last.dx;
        const ddy = dy - mv.last.dy;
        mv.last = { dx, dy };
        for (const id of mv.ids) {
          const it = store.get(id);
          if (!it) continue;
          const moved = translateItem(it, ddx, ddy);
          mv.tx.replace(id, moved.proto, { bbox: moved.bbox });
        }
      }
    });
    const onDblClick = () => {
      if (activeTool(storeKey)) void toolFinish();
    };
    el.addEventListener('dblclick', onDblClick);
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const hits = host.pick(ev.clientX - rect.left, ev.clientY - rect.top, 6);
      const s = useEditorStore.getState();
      const top = hits[0];
      if (top) {
        const id = pickedId(top);
        if (!s.docs[storeKey]?.selection.includes(id)) s.setSelection(storeKey, [id]);
      }
      setMenu({ x: ev.clientX, y: ev.clientY, target: top ? pickedId(top) : null });
    };
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      el.removeEventListener('dblclick', onDblClick);
      el.removeEventListener('contextmenu', onContextMenu);
      offPick();
      offHover();
      offCam();
      host.unmount();
      hosts.delete(storeKey);
      hostRef.current = null;
    };
  }, [kind, storeKey, store, services]);

  // theme
  useEffect(() => {
    const apply = () => hostRef.current?.setTheme(themeFor(resolveTheme(themeMode)));
    apply();
    if (themeMode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [themeMode]);

  // grid
  useEffect(() => {
    const h = hostRef.current;
    if (h instanceof MockCanvasHost) h.setGrid(gridNm, showGrid);
    else if (h) applyGrid(h, gridNm, showGrid);
  }, [gridNm, showGrid]);

  // editor state -> host
  const selection = doc?.selection;
  const hidden = doc?.hiddenLayers;
  const opacity = doc?.layerOpacity;
  const active = doc?.activeLayer;
  const nets = doc?.highlightNets;
  useEffect(() => hostRef.current?.setSelection(selection ?? []), [selection]);
  useEffect(() => {
    const h = hostRef.current;
    if (!h) return;
    const hiddenSet = new Set(hidden ?? []);
    for (const l of layers) h.setLayerVisible(l, !hiddenSet.has(l));
  }, [hidden, layers]);
  useEffect(() => {
    const h = hostRef.current;
    if (!h || !opacity) return;
    for (const [l, a] of Object.entries(opacity)) h.setLayerOpacity(l, a);
  }, [opacity]);
  useEffect(() => {
    if (active) hostRef.current?.setActiveLayer(active);
  }, [active]);
  useEffect(() => hostRef.current?.setHighlightNets(nets ?? []), [nets]);

  const tool = doc?.tool ?? 'select';
  const selCount = selection?.length ?? 0;
  const activeSession = toolSession && toolSession.storeKey === storeKey ? toolSession : null;
  return (
    <div className="canvas-slot" ref={ref} data-store={storeKey} data-tool={activeSession?.id ?? tool}>
      <ToolOverlay storeKey={storeKey} host={() => hostRef.current ?? undefined} />
      <div className="canvas-overlay">
        {tool === 'move' && <div className="hint tool">Moving {selCount} item{selCount === 1 ? '' : 's'} — click to place, Esc to cancel, R rotates</div>}
        {activeSession && (
          <div className="hint tool" data-testid="tool-hint">
            {activeSession.hint}
            {activeSession.points.length ? ` · ${activeSession.points.length} point${activeSession.points.length === 1 ? '' : 's'}` : ''}
          </div>
        )}
        {tool === 'select' && selCount === 0 && !activeSession && (
          <div className="hint">Click to select · Shift+click adds · Wheel zooms · Middle-drag or Alt-drag pans · Right-click for actions</div>
        )}
      </div>
      {menu && <CanvasContextMenu state={menu} storeKey={storeKey} store={store} kind={kind} onClose={() => setMenu(null)} />}
    </div>
  );
}
