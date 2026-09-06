import type { ReactNode } from 'react';

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>{title}</span>
        <span className="spacer" />
        {actions}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  badge?: ReactNode;
}

export function PanelTabs<T extends string>({ tabs, active, onChange, actions }: { tabs: TabDef<T>[]; active: T; onChange(id: T): void; actions?: ReactNode }) {
  return (
    <div className="panel-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={`panel-tab${t.id === active ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.badge}
        </button>
      ))}
      <span className="spacer" />
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
