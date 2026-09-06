// Three-column docked layout with a bottom panel. Sizes/collapsed flags live in the ui
// store (persisted). Each side accepts a rail label list so a collapsed panel still shows
// what it contains.

import type { ReactNode } from 'react';
import { useUiStore, type PanelSide } from '@/state/uiStore';
import { Splitter } from './Splitter';

interface DockLayoutProps {
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  bottom: ReactNode;
  leftRail: { label: string; onClick(): void }[];
  rightRail: { label: string; onClick(): void }[];
  bottomRail: { label: string; onClick(): void }[];
}

export function DockLayout({ left, center, right, bottom, leftRail, rightRail, bottomRail }: DockLayoutProps) {
  const panels = useUiStore((s) => s.panels);
  const setPanelSize = useUiStore((s) => s.setPanelSize);
  const togglePanel = useUiStore((s) => s.togglePanel);

  const rail = (side: PanelSide, items: { label: string; onClick(): void }[]) => (
    <div className={`collapsed-rail ${side}`}>
      {items.map((it) => (
        <button
          key={it.label}
          className="rail-btn"
          onClick={() => {
            togglePanel(side, false);
            it.onClick();
          }}
          title={`Show ${it.label}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="dock">
      <div className="dock-row">
        {panels.left.collapsed ? (
          rail('left', leftRail)
        ) : (
          <>
            <div className="dock-side left" style={{ width: panels.left.size }}>
              {left}
            </div>
            <Splitter direction="vertical" label="Resize left panel" onDelta={(d) => setPanelSize('left', panels.left.size + d)} onDoubleClick={() => togglePanel('left', true)} />
          </>
        )}
        <div className="dock-center">{center}</div>
        {panels.right.collapsed ? (
          rail('right', rightRail)
        ) : (
          <>
            <Splitter direction="vertical" label="Resize right panel" onDelta={(d) => setPanelSize('right', panels.right.size - d)} onDoubleClick={() => togglePanel('right', true)} />
            <div className="dock-side right" style={{ width: panels.right.size }}>
              {right}
            </div>
          </>
        )}
      </div>
      {panels.bottom.collapsed ? (
        rail('bottom', bottomRail)
      ) : (
        <>
          <Splitter direction="horizontal" label="Resize bottom panel" onDelta={(d) => setPanelSize('bottom', panels.bottom.size - d)} onDoubleClick={() => togglePanel('bottom', true)} />
          <div className="dock-bottom" style={{ height: panels.bottom.size }}>
            {bottom}
          </div>
        </>
      )}
    </div>
  );
}
