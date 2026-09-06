import { useEffect, useRef, useState } from 'react';
import { usePromptStore, type PromptField } from '@/state/promptStore';
import { useUiStore } from '@/state/uiStore';
import { formatDistance, parseDistance } from '@/lib/units';
import { Dialog } from '../layout/Dialog';

function initial(fields: PromptField[], units: 'mm' | 'mil' | 'in'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.key] = f.type === 'distance' && typeof f.default === 'number' ? formatDistance(f.default, units) : (f.default ?? (f.type === 'boolean' ? false : ''));
  return out;
}

export function PromptDialog() {
  const spec = usePromptStore((s) => s.spec);
  const finish = usePromptStore((s) => s.finish);
  const units = useUiStore((s) => s.units);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (spec) {
      setValues(initial(spec.fields, units));
      setTimeout(() => firstRef.current?.focus(), 30);
    }
  }, [spec, units]);
  if (!spec) return null;

  const submit = () => {
    const out: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const v = values[f.key];
      if (f.type === 'distance') out[f.key] = parseDistance(String(v ?? ''), units) ?? (typeof f.default === 'number' ? f.default : 0);
      else if (f.type === 'number') out[f.key] = Number(v ?? f.default ?? 0);
      else out[f.key] = v;
    }
    finish(out);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && finish(null)}
      title={spec.title}
      description={spec.description}
      size="narrow"
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => finish(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} data-testid="prompt-ok">
            {spec.okLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <form
        className="form-grid prompt-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {spec.fields.map((f, i) => {
          const v = values[f.key];
          const set = (nv: unknown) => setValues({ ...values, [f.key]: nv });
          const ref = i === 0 ? (firstRef as never) : undefined;
          return (
            <div key={f.key} style={{ display: 'contents' }}>
              <label htmlFor={`prompt-${f.key}`}>{f.label}</label>
              {f.type === 'select' ? (
                <select id={`prompt-${f.key}`} ref={ref} className="select" value={String(v ?? '')} onChange={(e) => set(e.target.value)} data-prompt={f.key}>
                  {f.choices?.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'boolean' ? (
                <input id={`prompt-${f.key}`} ref={ref} type="checkbox" className="checkbox" checked={Boolean(v)} onChange={(e) => set(e.target.checked)} data-prompt={f.key} />
              ) : f.type === 'multiline' ? (
                <textarea id={`prompt-${f.key}`} ref={ref} className="textarea" rows={4} value={String(v ?? '')} onChange={(e) => set(e.target.value)} data-prompt={f.key} />
              ) : (
                <span className="field-with-unit">
                  <input id={`prompt-${f.key}`} ref={ref} className={`input${f.type === 'distance' || f.type === 'number' ? ' num' : ''}`} value={String(v ?? '')} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} data-prompt={f.key} autoComplete="off" />
                  {f.type === 'distance' && <span className="unit">{units}</span>}
                  {f.type === 'number' && f.help === '°' && <span className="unit">°</span>}
                </span>
              )}
              {f.help && f.help !== '°' && <div className="help">{f.help}</div>}
            </div>
          );
        })}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
