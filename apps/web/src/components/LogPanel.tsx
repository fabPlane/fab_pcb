import { useEffect, useRef } from 'react';
import { useLogStore } from '@/state/logStore';

export function LogPanel() {
  const lines = useLogStore((s) => s.lines);
  const clear = useLogStore((s) => s.clear);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [lines.length]);
  return (
    <div className="panel">
      <div className="filter-bar">
        <span className="muted">Output from sessions, saves, jobs and rule checks</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={clear} disabled={lines.length === 0}>
          clear
        </button>
      </div>
      <div className="panel-body">
        <pre className="log">
          {lines.map((l) => (
            <div key={l.id} style={{ color: l.level === 'error' ? 'var(--danger)' : l.level === 'warn' ? 'var(--warning)' : undefined }}>
              <span className="faint">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
            </div>
          ))}
          <div ref={end} />
        </pre>
      </div>
    </div>
  );
}
