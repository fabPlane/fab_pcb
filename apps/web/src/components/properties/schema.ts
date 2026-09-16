// Editing schema for an object shaped like a kiapi message. Two sources, same output:
//
//   - `fromDescriptor(desc)` reads the protobuf-es descriptor (`kiapiRegistry` from
//     `@fp-pcb/proto`) so real items are editable: enums get their value names, int64
//     distances stay bigint, `Distance` / `Angle` / `Vector2` / `KIID` / `Color` / `Ratio`
//     messages become the dedicated field kinds, oneofs expose their `case` / `value`.
//   - `inferKind(value)` guesses from the value shape (the mock's plain objects, or fields
//     the descriptor does not know about).
//
// `schemaFor(key, value, path, overrides, desc?)` merges both: descriptor first, inference
// as the fallback, then per-path overrides.

import { ScalarType, type DescEnum, type DescField, type DescMessage, type DescOneof } from '@bufbuild/protobuf';
import { kiapiRegistry } from '@fp-pcb/proto';
import { enumOptionsFor } from '@/lib/enums';

export type FieldKind = 'distance' | 'angle' | 'vector' | 'ratio' | 'color' | 'kiid' | 'enum' | 'bool' | 'number' | 'string' | 'message' | 'repeated' | 'unknown';

export interface FieldSchema {
  kind: FieldKind;
  label: string;
  readonly: boolean;
  hidden: boolean;
  /** enum value names (descriptor: every value; inferred: the prefix table) */
  options?: readonly string[];
  /** enum name -> number when the proto stores numeric enums (descriptor only) */
  enumValues?: Record<string, number>;
  multiline?: boolean;
  /** descriptor of a nested message / list element, when known */
  childDesc?: DescMessage;
  /** the oneof this key represents (value is `{ case, value }`) */
  oneof?: DescOneof;
}

/** Keys are dotted paths ('width', 'padStack.drill.diameter') or bare field names ('*.locked'). */
export type SchemaOverrides = Record<string, Partial<FieldSchema>>;

const READONLY_KEYS = new Set(['id', 'parent', 'path', 'symbolPath', 'filledPolygons', 'embeddedFiles', 'imageData', 'definition']);
const HIDDEN_KEYS = new Set(['@type', 'code', '$typeName']);

const KIID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_RE = /^[A-Z]{2,5}_[A-Za-z0-9_]+$/;

/** Message types with a dedicated editor. */
const SPECIAL_MESSAGES: Record<string, FieldKind> = {
  'kiapi.common.types.Distance': 'distance',
  'kiapi.common.types.Angle': 'angle',
  'kiapi.common.types.Vector2': 'vector',
  'kiapi.common.types.KIID': 'kiid',
  'kiapi.common.types.Color': 'color',
  'kiapi.common.types.Ratio': 'ratio',
};

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

const isNm = (v: unknown): boolean => typeof v === 'number' || typeof v === 'bigint';

export function inferKind(value: unknown): FieldKind {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'string') return ENUM_RE.test(value) ? 'enum' : 'string';
  if (Array.isArray(value)) return 'repeated';
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => k !== '$typeName');
    if (keys.length === 1 && keys[0] === 'valueNm' && isNm(value.valueNm)) return 'distance';
    if (keys.length === 1 && keys[0] === 'valueDegrees' && typeof value.valueDegrees === 'number') return 'angle';
    if (keys.length === 2 && isNm(value.xNm) && isNm(value.yNm)) return 'vector';
    if (keys.length === 1 && keys[0] === 'value' && typeof value.value === 'string' && KIID_RE.test(value.value)) return 'kiid';
    if (keys.length === 1 && keys[0] === 'value' && typeof value.value === 'number') return 'ratio';
    if (keys.length === 4 && ['r', 'g', 'b', 'a'].every((k) => typeof value[k] === 'number')) return 'color';
    return 'message';
  }
  return 'unknown';
}

/** The descriptor of a protobuf-es message object (by its `$typeName`), if the registry knows it. */
export function descriptorFor(proto: unknown): DescMessage | undefined {
  const name = (proto as { $typeName?: unknown } | null)?.$typeName;
  return typeof name === 'string' ? kiapiRegistry.getMessage(name) : undefined;
}

function enumSchema(e: DescEnum): Pick<FieldSchema, 'kind' | 'options' | 'enumValues'> {
  const values: Record<string, number> = {};
  for (const v of e.values) values[v.name] = v.number;
  return { kind: 'enum', options: e.values.map((v) => v.name), enumValues: values };
}

/** Schema of one descriptor field (list-ness aside). */
function fieldSchema(f: DescField): Partial<FieldSchema> {
  switch (f.fieldKind) {
    case 'enum':
      return enumSchema(f.enum);
    case 'message': {
      const special = SPECIAL_MESSAGES[f.message.typeName];
      return special ? { kind: special } : { kind: 'message', childDesc: f.message };
    }
    case 'scalar':
      if (f.scalar === ScalarType.BOOL) return { kind: 'bool' };
      if (f.scalar === ScalarType.STRING || f.scalar === ScalarType.BYTES) return { kind: 'string' };
      return { kind: 'number' };
    case 'list': {
      if (f.listKind === 'message') {
        const special = SPECIAL_MESSAGES[f.message.typeName];
        return { kind: 'repeated', childDesc: special ? undefined : f.message };
      }
      if (f.listKind === 'enum') {
        const e = enumSchema(f.enum);
        return { kind: 'repeated', options: e.options, enumValues: e.enumValues };
      }
      return { kind: 'repeated' };
    }
    case 'map':
      return { kind: 'message' };
    default:
      return {};
  }
}

/**
 * Field schema tree of a message descriptor, keyed by protobuf-es local field name (oneofs
 * appear under the oneof's local name). Used for whole-message previews; the panel itself
 * resolves fields lazily through `schemaFor(..., desc)`.
 */
export function fromDescriptor(desc: DescMessage): Record<string, FieldSchema> {
  const out: Record<string, FieldSchema> = {};
  for (const f of desc.fields) {
    if (f.oneof) continue;
    out[f.localName] = { label: humanize(f.localName), readonly: READONLY_KEYS.has(f.localName), hidden: false, kind: 'unknown', ...fieldSchema(f) };
  }
  for (const o of desc.oneofs) {
    out[o.localName] = { label: humanize(o.localName), readonly: false, hidden: false, kind: 'message', oneof: o };
  }
  return out;
}

/** The descriptor-derived schema of `key` inside `desc`, if the descriptor has such a field / oneof. */
export function descriptorField(desc: DescMessage | undefined, key: string): Partial<FieldSchema> | undefined {
  if (!desc) return undefined;
  const f = desc.fields.find((x) => x.localName === key);
  if (f) return fieldSchema(f);
  const o = desc.oneofs.find((x) => x.localName === key);
  if (o) return { kind: 'message', oneof: o };
  return undefined;
}

/** Descriptor of the message stored under `value` in a oneof `{ case, value }` pair. */
export function oneofValueDescriptor(o: DescOneof, caseName: unknown): DescMessage | undefined {
  const f = o.fields.find((x) => x.localName === caseName);
  return f?.fieldKind === 'message' ? f.message : undefined;
}

export function schemaFor(key: string, value: unknown, path: (string | number)[], overrides: SchemaOverrides = {}, desc?: DescMessage): FieldSchema {
  const fromDesc = typeof key === 'string' ? descriptorField(desc, key) : undefined;
  const inferred = inferKind(value);
  // The descriptor wins for enums (numeric in real protos) and special messages; a
  // descriptor "message" kind still defers to inference so Distance-shaped values work.
  let kind: FieldKind = fromDesc?.kind ?? inferred;
  if (fromDesc?.kind === 'message' && inferred !== 'message' && inferred !== 'unknown') kind = inferred;
  if (fromDesc?.kind === 'number' && inferred === 'number') kind = 'number';
  if (fromDesc?.kind === 'enum' && typeof value === 'string' && !ENUM_RE.test(value)) kind = 'string';
  if (value === undefined || value === null) kind = fromDesc?.kind === 'enum' ? 'enum' : kind === 'enum' ? 'enum' : 'unknown';
  const base: FieldSchema = {
    kind,
    label: typeof key === 'string' ? humanize(key) : `[${key}]`,
    readonly: READONLY_KEYS.has(String(key)) || kind === 'kiid',
    hidden: HIDDEN_KEYS.has(String(key)),
  };
  if (fromDesc?.options) {
    base.options = fromDesc.options;
    base.enumValues = fromDesc.enumValues;
  } else if (kind === 'enum' && typeof value === 'string') {
    base.options = enumOptionsFor(value) ?? undefined;
  }
  if (fromDesc?.childDesc) base.childDesc = fromDesc.childDesc;
  if (fromDesc?.oneof) base.oneof = fromDesc.oneof;
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
    KOT_PCB_FIELD: 'Field',
    KOT_PCB_REFERENCE_IMAGE: 'Reference image',
    KOT_PCB_TABLE: 'Table',
    KOT_PCB_BARCODE: 'Barcode',
    KOT_SCH_SYMBOL: 'Symbol',
    KOT_SCH_LINE: 'Wire',
    KOT_SCH_JUNCTION: 'Junction',
    KOT_SCH_NO_CONNECT: 'No-connect',
    KOT_SCH_LABEL: 'Label',
    KOT_SCH_LOCAL_LABEL: 'Label',
    KOT_SCH_GLOBAL_LABEL: 'Global label',
    KOT_SCH_HIER_LABEL: 'Hierarchical label',
    KOT_SCH_DIRECTIVE_LABEL: 'Directive label',
    KOT_SCH_SHEET: 'Sheet',
    KOT_SCH_TEXT: 'Text',
    KOT_SCH_TEXTBOX: 'Text box',
    KOT_SCH_SHAPE: 'Graphic shape',
    KOT_SCH_BITMAP: 'Image',
    KOT_SCH_RULE_AREA: 'Rule area',
    KOT_SCH_BUS_WIRE_ENTRY: 'Bus entry',
    KOT_SCH_BUS_BUS_ENTRY: 'Bus-bus entry',
    KOT_SCH_GROUP: 'Group',
    KOT_SCH_TABLE: 'Table',
  };
  return map[type] ?? humanize(type.replace(/^KOT_(PCB|SCH)_/, ''));
}
