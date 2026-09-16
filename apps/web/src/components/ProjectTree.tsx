import type { DocumentKind } from '@/contracts';
import type { SheetInfo } from '@/services/types';
import { Panel } from './layout/Panel';

interface ProjectTreeProps {
  projectName: string;
  projectPath: string;
  boardFile: string;
  sheets: SheetInfo[];
  footprints: string[];
  active: { kind: DocumentKind | 'project'; id?: string };
  dirty: Partial<Record<DocumentKind, boolean>>;
  onOpen(kind: DocumentKind, id: string, title: string): void;
}

export function ProjectTree({ projectName, projectPath, boardFile, sheets, footprints, active, dirty, onOpen }: ProjectTreeProps) {
  const flat: { sheet: SheetInfo; depth: number }[] = [];
  const walk = (s: SheetInfo, depth: number) => {
    flat.push({ sheet: s, depth });
    s.children.forEach((c) => walk(c, depth + 1));
  };
  sheets.forEach((s) => walk(s, 0));
  return (
    <Panel title="Project">
      <div className="tree-item" title={projectPath}>
        <span className="twisty">▾</span>
        <span className="icon" style={{ color: 'var(--accent)' }}>
          ◆
        </span>
        <span className="truncate" style={{ fontWeight: 600 }}>
          {projectName}.kicad_pro
        </span>
      </div>
      <div className={`tree-item${active.kind === 'board' ? ' selected' : ''}`} style={{ paddingLeft: 20 }} onClick={() => onOpen('board', 'board', boardFile)}>
        <span className="twisty" />
        <span className="icon">▦</span>
        <span className="truncate">{boardFile}</span>
        {dirty.board && (
          <span className="tag" style={{ color: 'var(--warning)' }}>
            ●
          </span>
        )}
      </div>
      {flat.map(({ sheet, depth }) => (
        <div
          key={sheet.path}
          className={`tree-item${active.kind === 'schematic' && active.id === sheet.path ? ' selected' : ''}`}
          style={{ paddingLeft: 20 + depth * 14 }}
          onClick={() => onOpen('schematic', sheet.path, sheet.file)}
        >
          <span className="twisty" />
          <span className="icon">▤</span>
          <span className="truncate">{sheet.file}</span>
          <span className="tag">
            {sheet.name}
            {dirty.schematic && depth === 0 ? ' ●' : ''}
          </span>
        </div>
      ))}
      {footprints.map((fp) => (
        <div key={fp} className={`tree-item${active.kind === 'footprint' && active.id === fp ? ' selected' : ''}`} style={{ paddingLeft: 20 }} onClick={() => onOpen('footprint', fp, fp)}>
          <span className="twisty" />
          <span className="icon">▣</span>
          <span className="truncate">{fp}</span>
          {dirty.footprint && (
            <span className="tag" style={{ color: 'var(--warning)' }}>
              ●
            </span>
          )}
        </div>
      ))}
    </Panel>
  );
}
