// SVG preview of the active placement tool, drawn in screen space above the canvas host
// (pointer-events: none, so the host keeps receiving clicks). Re-renders on tool state,
// cursor and camera changes; world → screen through the host.

import { useMemo } from 'react';
import type { CanvasHost } from '@/contracts';
import { useEditorStore } from '@/state/editorStore';
import { toolPreview, useToolStore, type PreviewShape } from './tools';

export function ToolOverlay({ storeKey, host }: { storeKey: string; host: () => CanvasHost | undefined }) {
  const session = useToolStore((s) => s.session);
  const cursor = useEditorStore((s) => s.docs[storeKey]?.cursor ?? null);
  const camera = useEditorStore((s) => s.docs[storeKey]?.camera);
  const shapes = useMemo<PreviewShape[]>(() => (session && session.storeKey === storeKey ? toolPreview(session, cursor) : []), [session, cursor, storeKey]);
  void camera;
  const h = host();
  if (!session || session.storeKey !== storeKey || !h) return null;
  const w2s = (p: { x: number; y: number }) => h.worldToScreen(p.x, p.y);
  const px = (nm: number) => Math.max(1, nm * (camera?.zoom ?? 0));
  return (
    <svg className="tool-overlay" data-tool={session.id} aria-hidden="true">
      {shapes.map((s, i) => {
        switch (s.kind) {
          case 'polyline': {
            const pts = s.pts.map(w2s);
            const d = pts.map((p, j) => `${j ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + (s.closed ? ' Z' : '');
            return <path key={i} d={d} strokeWidth={px(s.width)} strokeDasharray={s.dashed ? '6 4' : undefined} />;
          }
          case 'circle': {
            const c = w2s(s.c);
            return <circle key={i} cx={c.x} cy={c.y} r={px(s.r)} strokeWidth={s.width ? px(s.width) : 1.5} fill={s.width ? 'none' : 'currentColor'} fillOpacity={0.35} />;
          }
          case 'rect': {
            const a = w2s(s.a);
            const b = w2s(s.b);
            return (
              <rect
                key={i}
                x={Math.min(a.x, b.x)}
                y={Math.min(a.y, b.y)}
                width={Math.abs(b.x - a.x)}
                height={Math.abs(b.y - a.y)}
                strokeWidth={s.width ? px(s.width) : 1.5}
                strokeDasharray={s.width ? undefined : '6 4'}
              />
            );
          }
          case 'marker': {
            const c = w2s(s.c);
            return (
              <g key={i}>
                <line x1={c.x - 8} y1={c.y} x2={c.x + 8} y2={c.y} strokeWidth={1} />
                <line x1={c.x} y1={c.y - 8} x2={c.x} y2={c.y + 8} strokeWidth={1} />
                {s.label && (
                  <text x={c.x + 10} y={c.y - 6}>
                    {s.label}
                  </text>
                )}
              </g>
            );
          }
        }
      })}
    </svg>
  );
}
