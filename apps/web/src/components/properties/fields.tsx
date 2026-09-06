import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatDistance, parseDistance, type Unit, UNIT_ORDER } from '@/lib/units';
import { enumLabel } from '@/lib/enums';

interface Common {
  path: string; // dotted, for data-path
  readonly?: boolean;
}

/** Text input that commits on Enter/blur and reverts on Escape. */
function useDraft<T>(external: T, format: (v: T) => string) {
  const [draft, setDraft] = useState(() => format(external));
  const [dirtyState, setDirtyState] = useState(false);
  // `dirty` is mirrored in a ref so an Enter-commit followed by the blur it causes does not
  // commit twice (the state update has not flushed when blur fires).
  const dirtyRef = useRef(false);
  const setDirty = (d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  };
  useEffect(() => {
    if (!dirtyRef.current) setDraft(format(external));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);
  return { draft, setDraft, dirty: dirtyState, dirtyRef, setDirty };
}

export function DistanceField({ path, valueNm, unit, onChange, onCycleUnit, readonly, showNm = true }: Common & { valueNm: number; unit: Unit; onChange(nm: number): void; onCycleUnit?(): void; showNm?: boolean }) {
  const { draft, setDraft, dirtyRef, setDirty } = useDraft(valueNm, (v) => formatDistance(v, unit));
  useEffect(() => {
    setDraft(formatDistance(valueNm, unit));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit]);
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    if (!dirtyRef.current) return;
    const nm = parseDistance(draft, unit);
    if (nm === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDirty(false);
    if (nm !== valueNm) onChange(nm);
    else setDraft(formatDistance(valueNm, unit));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setDraft(formatDistance(valueNm, unit));
      setDirty(false);
      setInvalid(false);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = (unit === 'mm' ? 0.1 : unit === 'mil' ? 5 : 0.005) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const cur = parseDistance(draft, unit) ?? valueNm;
      const next = parseDistance(String(cur / (unit === 'mm' ? 1e6 : unit === 'mil' ? 25400 : 25.4e6) + step), unit);
      if (next !== null) onChange(next);
    }
  };
  return (
    <>
      <input
        className={`input num${invalid ? ' invalid' : ''}`}
        data-path={path}
        value={draft}
        disabled={readonly}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onBlur={commit}
        onKeyDown={onKey}
        spellCheck={false}
        title={`${valueNm} nm`}
      />
      <span className="unit" onClick={onCycleUnit} title="Click to change units (mm → mil → in)">
        {unit}
      </span>
      {showNm && <span className="sub">{valueNm.toLocaleString('en-US')} nm</span>}
    </>
  );
}

export function AngleField({ path, degrees, onChange, readonly }: Common & { degrees: number; onChange(deg: number): void }) {
  const { draft, setDraft, dirtyRef, setDirty } = useDraft(degrees, (v) => String(Math.round(v * 1000) / 1000));
  const commit = () => {
    if (!dirtyRef.current) return;
    const n = Number(draft);
    setDirty(false);
    if (Number.isFinite(n) && n !== degrees) onChange(n);
    else setDraft(String(degrees));
  };
  return (
    <>
      <input
        className="input num"
        data-path={path}
        value={draft}
        disabled={readonly}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(String(degrees));
            setDirty(false);
          }
        }}
      />
      <span className="unit">°</span>
    </>
  );
}

export function NumberField({ path, value, onChange, readonly, integer }: Common & { value: number; onChange(v: number): void; integer?: boolean }) {
  const { draft, setDraft, dirtyRef, setDirty } = useDraft(value, (v) => String(v));
  const commit = () => {
    if (!dirtyRef.current) return;
    const n = integer ? parseInt(draft, 10) : Number(draft);
    setDirty(false);
    if (Number.isFinite(n) && n !== value) onChange(n);
    else setDraft(String(value));
  };
  return (
    <input
      className="input num"
      data-path={path}
      value={draft}
      disabled={readonly}
      onChange={(e) => {
        setDraft(e.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function StringField({ path, value, onChange, readonly, multiline }: Common & { value: string; onChange(v: string): void; multiline?: boolean }) {
  const { draft, setDraft, dirtyRef, setDirty } = useDraft(value, (v) => v);
  const commit = () => {
    if (!dirtyRef.current) return;
    setDirty(false);
    if (draft !== value) onChange(draft);
  };
  if (multiline) {
    return (
      <textarea
        className="textarea"
        data-path={path}
        rows={3}
        value={draft}
        disabled={readonly}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
        }}
        onBlur={commit}
        style={{ flex: 1 }}
      />
    );
  }
  return (
    <input
      className="input"
      data-path={path}
      value={draft}
      disabled={readonly}
      onChange={(e) => {
        setDraft(e.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          setDirty(false);
        }
      }}
      spellCheck={false}
    />
  );
}

export function EnumField({ path, value, options, onChange, readonly }: Common & { value: string; options?: readonly string[]; onChange(v: string): void }) {
  if (!options) return <StringField path={path} value={value} onChange={onChange} readonly={readonly} />;
  const list = options.includes(value) ? options : [value, ...options];
  return (
    <select className="select" data-path={path} value={value} disabled={readonly} onChange={(e) => onChange(e.target.value)}>
      {list.map((o) => (
        <option key={o} value={o}>
          {enumLabel(o)}
        </option>
      ))}
    </select>
  );
}

export function BoolField({ path, value, onChange, readonly }: Common & { value: boolean; onChange(v: boolean): void }) {
  return <input type="checkbox" className="checkbox" data-path={path} checked={value} disabled={readonly} onChange={(e) => onChange(e.target.checked)} />;
}

export function ColorField({ path, value, onChange, readonly }: Common & { value: { r: number; g: number; b: number; a: number }; onChange(v: { r: number; g: number; b: number; a: number }): void }) {
  const hex = '#' + [value.r, value.g, value.b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  return (
    <>
      <input
        type="color"
        data-path={path}
        value={hex}
        disabled={readonly}
        onChange={(e) => {
          const h = e.target.value;
          onChange({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: value.a });
        }}
        style={{ width: 28, height: 20, padding: 0, border: '1px solid var(--border)', background: 'transparent' }}
      />
      <span className="text-ro">{hex}</span>
      <span className="unit">α {value.a.toFixed(2)}</span>
    </>
  );
}

export function UnitToggle({ unit, onChange }: { unit: Unit; onChange(u: Unit): void }) {
  return (
    <span className="units" role="radiogroup" aria-label="Units">
      {UNIT_ORDER.map((u) => (
        <button key={u} type="button" role="radio" aria-checked={u === unit} className={u === unit ? 'on' : ''} onClick={() => onChange(u)}>
          {u}
        </button>
      ))}
    </span>
  );
}
