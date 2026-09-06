// Mounts a CanvasHost into a div and wires it to the editor store:
//   pick  -> selection (click, shift-click toggles)
//   hover -> hover id + cursor world position (status bar)
//   camera -> editor store (status bar zoom)
//   store -> selection / layer visibility / opacity / active layer / net highlight
// Also hosts the interactive move tool: press M with a selection, the pointer drags the
// items through an open transaction, click commits, Esc drops.

import { useEffect, useRef } from 'react';
import type { CanvasHost, DocumentKind, ItemStore } from '@/contracts';
import { useServices } from '@/services';
import type { Transaction } from '@/services/types';
import { useEditorStore } from '@/state/editorStore';
import { useUiStore, resolveTheme } from '@/state/uiStore';
import { translateItem, snap } from '@/lib/geometry';
import { createCanvasHost } from './hostFactory';
import { themeFor } from './theme';
import { MockCanvasHost } from './MockCanvasHost';

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

export function CanvasSlot({ kind, storeKey, store, layers }: CanvasSlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<CanvasHost | null>(null);
  const services = useServices();
  const themeMode = useUiStore((s) => s.theme);
  const gridNm = useUiStore((s) => s.gridNm);
  const showGrid = useUiStore((s) => s.showGrid);
  const doc = useEditorStore((s) => s.docs[storeKey]);
  const ensure = useEditorStore((s) => s.ensure);

  useEffect(() => ensure(storeKey, kind), [ensure, storeKey, kind]);

  // mount / unmount
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const host = createCanvasHost(kind);
    hostRef.current = host;
    hosts.set(storeKey, host);
    host.mount(el, store, themeFor(resolveTheme(useUiStore.getState().theme)));
    const st = useEditorStore.getState();
    const d = st.docs[storeKey];
    if (d && d.camera.zoom > 0) host.setCamera(d.camera);
    else st.setCamera(storeKey, host.getCamera());

    const offPick = host.onPick((hits, ev) => {
      const s = useEditorStore.getState();
      if (moveSessions.has(storeKey)) {
        void endMove(storeKey, true);
        return;
      }
      const top = hits[0];
      if (!top) {
        if (!ev.shiftKey) s.setSelection(storeKey, []);
        return;
      }
      if (ev.shiftKey) s.toggleSelection(storeKey, top.id);
      else s.setSelection(storeKey, [top.id]);
    });
    const offHover = host.onHover((hit, ev) => {
      const s = useEditorStore.getState();
      const rect = el.getBoundingClientRect();
      const world = host.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      s.setCursor(storeKey, world);
      s.setHover(storeKey, hit?.id ?? null);
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
    const offCam = host.onCameraChange((cam) => useEditorStore.getState().setCamera(storeKey, cam));
    return () => {
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
  return (
    <div className="canvas-slot" ref={ref} data-store={storeKey}>
      <div className="canvas-overlay">
        {tool === 'move' && <div className="hint tool">Moving {selCount} item{selCount === 1 ? '' : 's'} — click to place, Esc to cancel, R rotates</div>}
        {tool === 'select' && selCount === 0 && (
          <div className="hint">Click to select · Shift+click adds · Wheel zooms · Middle-drag or Alt-drag pans</div>
        )}
      </div>
    </div>
  );
}
