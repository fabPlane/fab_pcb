import { useCallback, useMemo, useState } from 'react';
import type { DocumentKind } from '@/contracts';
import { useServices, useServiceVersion } from '@/services';
import type { JobDefinition, JobOption, JobRun } from '@/services/types';

export function JobsPanel({ document }: { document: DocumentKind }) {
  const { jobs } = useServices();
  const subscribe = useCallback((cb: () => void) => jobs.onChange(cb), [jobs]);
  useServiceVersion(subscribe);
  const defs = useMemo(() => jobs.jobs().filter((j) => j.document === document || j.document === 'project'), [jobs, document]);
  const [selectedJob, setSelectedJob] = useState<string>(defs[0]?.id ?? '');
  const [options, setOptions] = useState<Record<string, Record<string, unknown>>>({});
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const def = defs.find((d) => d.id === selectedJob) ?? defs[0];
  const runs = jobs.runs();
  const run = runs.find((r) => r.id === selectedRun) ?? runs[0];

  const optionsFor = (d: JobDefinition): Record<string, unknown> => {
    const base: Record<string, unknown> = {};
    for (const o of d.options) base[o.key] = o.default;
    return { ...base, ...(options[d.id] ?? {}) };
  };

  const start = async () => {
    if (!def) return;
    const r = await jobs.run(def.id, optionsFor(def));
    setSelectedRun(r.id);
  };

  return (
    <div className="jobs-layout">
      <div>
        {defs.map((d) => (
          <div key={d.id} className={`row${d.id === def?.id ? ' selected' : ''}`} onClick={() => setSelectedJob(d.id)}>
            <span className="truncate">{d.title}</span>
          </div>
        ))}
      </div>
      <div>
        {def && (
          <div className="job-form">
            <p className="desc">{def.description}</p>
            <div className="cmd">{def.command}</div>
            <div className="form-grid">
              {def.options.map((o) => (
                <OptionField key={o.key} option={o} value={optionsFor(def)[o.key]} onChange={(v) => setOptions({ ...options, [def.id]: { ...(options[def.id] ?? {}), [o.key]: v } })} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button className="btn primary" onClick={start}>
                Run {def.title}
              </button>
              <button className="btn" onClick={() => setOptions({ ...options, [def.id]: {} })}>
                Reset options
              </button>
            </div>
          </div>
        )}
      </div>
      <div>
        <div className="filter-bar">
          <span className="muted">{runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : 'No jobs run yet'}</span>
          <span className="spacer" />
          {runs.length > 0 && (
            <button className="btn ghost sm" onClick={() => jobs.clearFinished()}>
              clear finished
            </button>
          )}
        </div>
        {runs.map((r) => (
          <RunItem key={r.id} run={r} selected={r.id === run?.id} onSelect={() => setSelectedRun(r.id)} />
        ))}
        {run && (
          <>
            <pre className="log">{run.log.join('\n')}</pre>
            {run.outputs.length > 0 && (
              <div className="outputs">
                {run.outputs.map((o) => (
                  <div key={o.name} className="output-row">
                    <span className="name" title={`${o.path}/${o.name}`}>
                      {o.name}
                    </span>
                    <span className="faint">{(o.bytes / 1024).toFixed(1)} KiB</span>
                    {o.url ? (
                      <a className="btn ghost sm" href={o.url} download={o.name} target="_blank" rel="noreferrer" title={`${o.path}/${o.name}`}>
                        download
                      </a>
                    ) : (
                      <button className="btn ghost sm" title="Not inside the bridge workspace root" disabled>
                        download
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunItem({ run, selected, onSelect }: { run: JobRun; selected: boolean; onSelect(): void }) {
  const dur = run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s` : '';
  return (
    <div className={`run-item${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="head">
        <span>{run.title}</span>
        <span className="faint">{new Date(run.startedAt).toLocaleTimeString()}</span>
        <span className={`state ${run.state}`}>
          {run.state === 'done' ? `done · ${dur}` : run.state === 'failed' ? 'failed' : run.state === 'running' ? `${Math.round(run.progress * 100)}%` : 'queued'}
        </span>
      </div>
      {(run.state === 'running' || run.state === 'queued') && (
        <div className="progress">
          <div style={{ width: `${run.progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

function OptionField({ option, value, onChange }: { option: JobOption; value: unknown; onChange(v: unknown): void }) {
  switch (option.type) {
    case 'boolean':
      return (
        <>
          <label>{option.label}</label>
          <input type="checkbox" className="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        </>
      );
    case 'select':
      return (
        <>
          <label>{option.label}</label>
          <select className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {option.choices?.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </>
      );
    case 'layers': {
      const set = new Set((value as string[]) ?? []);
      return (
        <>
          <label style={{ alignSelf: 'start', paddingTop: 2 }}>{option.label}</label>
          <div className="layer-checks">
            {option.choices?.map((c) => (
              <label key={c.value}>
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={set.has(c.value)}
                  onChange={(e) => {
                    const next = new Set(set);
                    if (e.target.checked) next.add(c.value);
                    else next.delete(c.value);
                    onChange((option.choices ?? []).map((x) => x.value).filter((v) => next.has(v)));
                  }}
                />
                {c.label}
              </label>
            ))}
          </div>
        </>
      );
    }
    case 'number':
      return (
        <>
          <label>{option.label}</label>
          <input className="input num" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} />
        </>
      );
    default:
      return (
        <>
          <label>{option.label}</label>
          <input className="input mono" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </>
      );
  }
}
