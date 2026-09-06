// Schema-driven editor for an object shaped like a kiapi message. Emits `Patch`es; the
// caller decides how to apply them (the editors route them through CommandService so
// every edit is undoable).

import { Fragment, useMemo } from 'react';
import type { Patch, PatchPath } from '@/lib/patch';
import type { Unit } from '@/lib/units';
import { AngleField, BoolField, ColorField, DistanceField, EnumField, NumberField, StringField, UnitToggle } from './fields';
import { schemaFor, typeLabel, type SchemaOverrides } from './schema';

export interface PropertiesPanelProps {
  value: Record<string, unknown>;
  typeName?: string;
  id?: string;
  units: Unit;
  onUnitsChange?(u: Unit): void;
  onPatch(patch: Patch): void;
  overrides?: SchemaOverrides;
  /** Field names to render first, in this order. */
  priority?: string[];
  /** Groups opened by default. */
  openGroups?: string[];
}

const DEFAULT_PRIORITY = ['number', 'name', 'text', 'position', 'start', 'mid', 'end', 'orientation', 'layer', 'layers', 'width', 'net', 'locked', 'type', 'shape'];

export function PropertiesPanel({ value, typeName, id, units, onUnitsChange, onPatch, overrides = {}, priority = DEFAULT_PRIORITY, openGroups }: PropertiesPanelProps) {
  const cycle = () => onUnitsChange?.(units === 'mm' ? 'mil' : units === 'mil' ? 'in' : 'mm');
  const entries = useMemo(() => {
    const keys = Object.keys(value);
    const rank = (k: string) => {
      const i = priority.indexOf(k);
      return i === -1 ? 1000 : i;
    };
    return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [value, priority]);

  const scalars = entries.filter((k) => !isGroupKind(value[k]));
  const groups = entries.filter((k) => isGroupKind(value[k]));
  const open = new Set(openGroups ?? ['text', 'position', 'padStack', 'referenceField', 'valueField', 'transform', 'attributes']);

  return (
    <div className="props">
      <div className="props-title">
        <span className="type">{typeLabel(typeName)}</span>
        {id && (
          <span className="id" title={id}>
            {id.slice(0, 8)}
          </span>
        )}
      </div>
      <div className="prop-group" style={{ borderTop: 'none' }}>
        {scalars.map((k) => (
          <Field key={k} name={k} value={value[k]} path={[k]} units={units} onPatch={onPatch} overrides={overrides} cycleUnit={cycle} depth={0} />
        ))}
      </div>
      {groups.map((k) => (
        <Group key={k} name={k} value={value[k]} path={[k]} units={units} onPatch={onPatch} overrides={overrides} cycleUnit={cycle} depth={0} defaultOpen={open.has(k)} />
      ))}
      <div className="props-footer">
        <span className="faint">Enter commits · Esc reverts · ↑↓ steps</span>
        <UnitToggle unit={units} onChange={(u) => onUnitsChange?.(u)} />
      </div>
    </div>
  );
}

function isGroupKind(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  if (!v || typeof v !== 'object') return false;
  const keys = Object.keys(v as object);
  if (keys.length === 1 && (keys[0] === 'valueNm' || keys[0] === 'valueDegrees' || keys[0] === 'value')) return false;
  if (keys.length === 2 && 'xNm' in (v as object) && 'yNm' in (v as object)) return false;
  if (keys.length === 4 && 'r' in (v as object) && 'a' in (v as object)) return false;
  return true;
}

interface FieldProps {
  name: string | number;
  value: unknown;
  path: PatchPath;
  units: Unit;
  onPatch(p: Patch): void;
  overrides: SchemaOverrides;
  cycleUnit(): void;
  depth: number;
}

function Field({ name, value, path, units, onPatch, overrides, cycleUnit, depth }: FieldProps) {
  const schema = schemaFor(String(name), value, path, overrides);
  if (schema.hidden) return null;
  const dotted = path.join('.');
  const set = (sub: PatchPath, v: unknown) => onPatch({ path: [...path, ...sub], value: v });
  const style = { ['--indent' as string]: `${depth * 10}px` };
  const label = (
    <span className={`label${schema.readonly ? ' readonly' : ''}`} title={dotted}>
      {schema.label}
    </span>
  );
  switch (schema.kind) {
    case 'distance':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <DistanceField path={`${dotted}.valueNm`} valueNm={(value as { valueNm: number }).valueNm} unit={units} onChange={(nm) => set(['valueNm'], nm)} onCycleUnit={cycleUnit} readonly={schema.readonly} showNm={false} />
          </div>
          <span className="sub">{(value as { valueNm: number }).valueNm.toLocaleString('en-US')} nm</span>
        </div>
      );
    case 'angle':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <AngleField path={`${dotted}.valueDegrees`} degrees={(value as { valueDegrees: number }).valueDegrees} onChange={(d) => set(['valueDegrees'], d)} readonly={schema.readonly} />
          </div>
        </div>
      );
    case 'vector': {
      const v = value as { xNm: number; yNm: number };
      return (
        <>
          <div className="prop-row" style={style}>
            {label}
            <div className="value">
              <span className="unit" style={{ width: 12 }}>X</span>
              <DistanceField path={`${dotted}.xNm`} valueNm={v.xNm} unit={units} onChange={(nm) => set(['xNm'], nm)} onCycleUnit={cycleUnit} readonly={schema.readonly} showNm={false} />
            </div>
            <span className="sub">{v.xNm.toLocaleString('en-US')} nm</span>
          </div>
          <div className="prop-row" style={style}>
            <span className="label" />
            <div className="value">
              <span className="unit" style={{ width: 12 }}>Y</span>
              <DistanceField path={`${dotted}.yNm`} valueNm={v.yNm} unit={units} onChange={(nm) => set(['yNm'], nm)} onCycleUnit={cycleUnit} readonly={schema.readonly} showNm={false} />
            </div>
            <span className="sub">{v.yNm.toLocaleString('en-US')} nm</span>
          </div>
        </>
      );
    }
    case 'ratio':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <NumberField path={`${dotted}.value`} value={(value as { value: number }).value} onChange={(n) => set(['value'], n)} readonly={schema.readonly} />
          </div>
        </div>
      );
    case 'color':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <ColorField path={dotted} value={value as { r: number; g: number; b: number; a: number }} onChange={(c) => set([], c)} readonly={schema.readonly} />
          </div>
        </div>
      );
    case 'kiid':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <span className="text-ro" title={(value as { value: string }).value}>
              {(value as { value: string }).value}
            </span>
          </div>
        </div>
      );
    case 'enum':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <EnumField path={dotted} value={value as string} options={schema.options} onChange={(v) => set([], v)} readonly={schema.readonly} />
          </div>
        </div>
      );
    case 'bool':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <BoolField path={dotted} value={value as boolean} onChange={(v) => set([], v)} readonly={schema.readonly} />
          </div>
        </div>
      );
    case 'number':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <NumberField path={dotted} value={value as number} onChange={(v) => set([], v)} readonly={schema.readonly} />
          </div>
        </div>
      );
    case 'string':
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <StringField path={dotted} value={value as string} onChange={(v) => set([], v)} readonly={schema.readonly} multiline={schema.multiline} />
          </div>
        </div>
      );
    case 'message':
    case 'repeated':
      return <Group name={name} value={value} path={path} units={units} onPatch={onPatch} overrides={overrides} cycleUnit={cycleUnit} depth={depth} defaultOpen={false} />;
    default:
      return (
        <div className="prop-row" style={style}>
          {label}
          <div className="value">
            <span className="text-ro">{value === undefined || value === null ? '—' : String(value)}</span>
          </div>
        </div>
      );
  }
}

function Group({ name, value, path, units, onPatch, overrides, cycleUnit, depth, defaultOpen }: FieldProps & { defaultOpen: boolean }) {
  const schema = schemaFor(String(name), value, path, overrides);
  if (schema.hidden) return null;
  const isArray = Array.isArray(value);
  const entries: [string | number, unknown][] = isArray ? (value as unknown[]).map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>);
  const count = entries.length;
  const arr = value as unknown[];
  return (
    <details className="prop-group" open={defaultOpen} style={{ ['--indent' as string]: `${depth * 10}px` }}>
      <summary style={{ paddingLeft: `calc(var(--space-3) + ${depth * 10}px)` }}>
        {schema.label}
        <span className="count">
          {isArray ? `${count} item${count === 1 ? '' : 's'}` : ''}
          {isArray && !schema.readonly && count > 0 && (
            <button
              className="btn ghost sm"
              style={{ marginLeft: 6 }}
              title="Duplicate last element"
              onClick={(e) => {
                e.preventDefault();
                onPatch({ path: [...path, count], value: JSON.parse(JSON.stringify(arr[count - 1])) });
              }}
            >
              +
            </button>
          )}
        </span>
      </summary>
      {count === 0 && <div className="prop-row" style={{ ['--indent' as string]: `${(depth + 1) * 10}px` }}><span className="label faint">empty</span></div>}
      {entries.map(([k, v]) => (
        <Fragment key={String(k)}>
          {isArray && !isGroupKind(v) ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 22px', alignItems: 'center' }}>
              <Field name={k} value={v} path={[...path, k]} units={units} onPatch={onPatch} overrides={overrides} cycleUnit={cycleUnit} depth={depth + 1} />
              {!schema.readonly && (
                <button className="btn ghost sm" title="Remove" onClick={() => onPatch({ path: [...path, k], value: undefined })}>
                  ×
                </button>
              )}
            </div>
          ) : (
            <Field name={k} value={v} path={[...path, k]} units={units} onPatch={onPatch} overrides={overrides} cycleUnit={cycleUnit} depth={depth + 1} />
          )}
        </Fragment>
      ))}
    </details>
  );
}
