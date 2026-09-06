// Infers an editing schema from a plain object shaped like a kiapi message. When the
// generated proto package is available, `fromDescriptor(DescMessage)` can produce the
// same FieldSchema tree from real descriptors; the panel does not care which.

import { enumOptionsFor } from '@/lib/enums';

export type FieldKind =
  | 'distance'
  | 'angle'
  | 'vector'
  | 'ratio'
  | 'color'
  | 'kiid'
  | 'enum'
  | 'bool'
  | 'number'
  | 'string'
  | 'message'
  | 'repeated'
  | 'unknown';

export interface FieldSchema {
  kind: FieldKind;
  label: string;
  readonly: boolean;
  hidden: boolean;
  options?: readonly string[];
  multiline?: boolean;
}

/** Keys are dotted paths ('width', 'padStack.drill.diameter') or bare field names ('*.locked'). */
export type SchemaOverrides = Record<string, Partial<FieldSchema>>;

const READONLY_KEYS = new Set(['id', 'parent', 'path', 'symbolPath', 'filledPolygons', 'embeddedFiles', 'imageData']);
const HIDDEN_KEYS = new Set(['@type', 'code']);

const KIID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_RE = /^[A-Z]{2,5}_[A-Za-z0-9_]+$/;

export function humanize(key: string): string {
  if (key === 'xNm') return 'X';
  if (key === 'yNm') return 'Y';
  if (key === 'valueNm') return 'Value';
  if (key === 'valueDegrees') return 'Angle';
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function inferKind(value: unknown): FieldKind {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return ENUM_RE.test(value) ? 'enum' : 'string';
  if (Array.isArray(value)) return 'repeated';
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'valueNm' && typeof value.valueNm === 'number') return 'distance';
    if (keys.length === 1 && keys[0] === 'valueDegrees' && typeof value.valueDegrees === 'number') return 'angle';
    if (keys.length === 2 && typeof value.xNm === 'number' && typeof value.yNm === 'number') return 'vector';
    if (keys.length === 1 && keys[0] === 'value' && typeof value.value === 'string' && KIID_RE.test(value.value)) return 'kiid';
    if (keys.length === 1 && keys[0] === 'value' && typeof value.value === 'number') return 'ratio';
    if (keys.length === 4 && ['r', 'g', 'b', 'a'].every((k) => typeof value[k] === 'number')) return 'color';
    return 'message';
  }
  return 'unknown';
}

export function schemaFor(key: string, value: unknown, path: (string | number)[], overrides: SchemaOverrides = {}): FieldSchema {
  const kind = inferKind(value);
  const base: FieldSchema = {
    kind,
    label: typeof key === 'string' ? humanize(key) : `[${key}]`,
    readonly: READONLY_KEYS.has(String(key)) || kind === 'kiid',
    hidden: HIDDEN_KEYS.has(String(key)),
  };
  if (kind === 'enum' && typeof value === 'string') base.options = enumOptionsFor(value) ?? undefined;
  if (kind === 'string' && typeof value === 'string' && value.includes('\n')) base.multiline = true;
  const dotted = path.map(String).join('.');
  const star = `*.${String(key)}`;
  return { ...base, ...(overrides[star] ?? {}), ...(overrides[dotted] ?? {}) };
}

/** Human-readable name for a kiapi object type. */
export function typeLabel(type: string | undefined): string {
  if (!type) return 'Item';
  const map: Record<string, string> = {
    KOT_PCB_FOOTPRINT: 'Footprint',
    KOT_PCB_PAD: 'Pad',
    KOT_PCB_SHAPE: 'Graphic shape',
    KOT_PCB_TEXT: 'Text',
    KOT_PCB_TEXTBOX: 'Text box',
    KOT_PCB_TRACE: 'Track',
    KOT_PCB_VIA: 'Via',
    KOT_PCB_ARC: 'Arc track',
    KOT_PCB_ZONE: 'Zone',
    KOT_PCB_GROUP: 'Group',
    KOT_PCB_DIMENSION: 'Dimension',
    KOT_SCH_SYMBOL: 'Symbol',
    KOT_SCH_LINE: 'Wire',
    KOT_SCH_JUNCTION: 'Junction',
    KOT_SCH_NO_CONNECT: 'No-connect',
    KOT_SCH_LOCAL_LABEL: 'Label',
    KOT_SCH_GLOBAL_LABEL: 'Global label',
    KOT_SCH_HIER_LABEL: 'Hierarchical label',
    KOT_SCH_SHEET: 'Sheet',
    KOT_SCH_TEXT: 'Text',
    KOT_SCH_TEXTBOX: 'Text box',
  };
  return map[type] ?? humanize(type.replace(/^KOT_(PCB|SCH)_/, ''));
}
