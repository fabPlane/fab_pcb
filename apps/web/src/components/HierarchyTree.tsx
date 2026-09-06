import { useState } from 'react';
import type { SheetInfo } from '@/services/types';
import { Panel } from './layout/Panel';

interface HierarchyTreeProps {
  sheets: SheetInfo[];
  activePath: string;
  onOpen(path: string): void;
}

export function HierarchyTree({ sheets, activePath, onOpen }: HierarchyTreeProps) {
  return (
    <Panel title="Hierarchy">
      {sheets.map((s) => (
        <SheetNode key={s.path} sheet={s} depth={0} activePath={activePath} onOpen={onOpen} />
      ))}
    </Panel>
  );
}

function SheetNode({ sheet, depth, activePath, onOpen }: { sheet: SheetInfo; depth: number; activePath: string; onOpen(path: string): void }) {
  const [open, setOpen] = useState(true);
  const hasChildren = sheet.children.length > 0;
  return (
    <>
      <div
        className={`tree-item${sheet.path === activePath ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onOpen(sheet.path)}
        onDoubleClick={() => setOpen((o) => !o)}
        title={sheet.file}
      >
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          {hasChildren ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="icon">▤</span>
        <span className="truncate">{sheet.name}</span>
        <span className="tag">p.{sheet.page}</span>
      </div>
      {open && sheet.children.map((c) => <SheetNode key={c.path} sheet={c} depth={depth + 1} activePath={activePath} onOpen={onOpen} />)}
    </>
  );
}
