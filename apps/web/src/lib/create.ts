// Factories for new KiCad items: protobuf-es messages shaped the way the C++ deserializers
// expect them (see the KiCad tree: pcbnew/pcb_track.cpp, pcbnew/footprint.cpp,
// eeschema/sch_line.cpp, eeschema/api/api_sch_utils.cpp ...). Every factory returns a
// `StoredItem` ready for `Transaction.create()`; ids are fresh KIIDs. Pure functions, unit
// tested in test/create.test.ts.

import { create, type DescMessage, type Message } from '@bufbuild/protobuf';
import type { Any } from '@bufbuild/protobuf/wkt';
import {
  BoardGraphicShapeSchema,
  BoardLayer,
  BoardTextSchema,
  FootprintInstanceSchema,
  GlobalLabelSchema,
  HierarchicalLabelSchema,
  JunctionSchema,
  LocalLabelSchema,
  LockedState,
  NoConnectMarkerSchema,
  PadStackShape,
  PadStackType,
  SchematicLabelShape,
  SchematicLabelSpinStyle,
  SchematicLineSchema,
  SchematicLineType,
  SchematicSymbolInstanceSchema,
  SchematicSymbolOrientation,
  SchematicTextSchema,
  SheetSymbolSchema,
  TrackSchema,
  ViaSchema,
  ViaType,
  ZoneBorderStyle,
  ZoneFillMode,
  ZoneSchema,
  ZoneType,
  kiapiRegistry,
  packAny,
  type FootprintInstance,
  type SchematicSymbol as SchematicSymbolDefinition,
} from '@fp-pcb/proto';
import type { StoredItem } from '@/contracts';
import { newKiid } from './id';
import { structuredCloneSafe } from './patch';

export interface Pt {
  x: number;
  y: number;
}

const V = (p: Pt) => ({ xNm: BigInt(Math.round(p.x)), yNm: BigInt(Math.round(p.y)) });
const D = (nm: number) => ({ valueNm: BigInt(Math.round(nm)) });
const layerEnum = (id: string): BoardLayer => (BoardLayer[id as keyof typeof BoardLayer] as BoardLayer | undefined) ?? BoardLayer.BL_F_Cu;

function stored(type: string, proto: Message, extra: Partial<StoredItem> = {}): StoredItem {
  const id = (proto as { id?: { value?: string } }).id?.value ?? '';
  return { id, type, proto, ...extra };
}

/** Bounding box of a set of points, padded by `pad` nm. */
export function bboxOf(points: Pt[], pad = 0): StoredItem['bbox'] {
  if (!points.length) return undefined;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
}

// ---------------------------------------------------------------------------- board

export function makeTrack(a: Pt, b: Pt, widthNm: number, layer: string, net?: string): StoredItem {
  const proto = create(TrackSchema, {
    id: { value: newKiid() },
    start: V(a),
    end: V(b),
    width: D(widthNm),
    layer: layerEnum(layer),
    locked: LockedState.LS_UNLOCKED,
    net: net ? { name: net } : undefined,
  });
  return stored('KOT_PCB_TRACE', proto, { layer, net, bbox: bboxOf([a, b], widthNm / 2) });
}

export interface ViaSpec {
  diameterNm: number;
  drillNm: number;
  /** Copper layers spanned, first = start. Default F.Cu → B.Cu. */
  layers?: string[];
  net?: string;
}

export function makeVia(at: Pt, spec: ViaSpec): StoredItem {
  const layers = spec.layers?.length ? spec.layers : ['BL_F_Cu', 'BL_B_Cu'];
  const first = layers[0]!;
  const last = layers[layers.length - 1]!;
  const proto = create(ViaSchema, {
    id: { value: newKiid() },
    position: V(at),
    type: ViaType.VT_THROUGH,
    locked: LockedState.LS_UNLOCKED,
    net: spec.net ? { name: spec.net } : undefined,
    padStack: {
      type: PadStackType.PST_NORMAL,
      layers: layers.map(layerEnum),
      drill: { diameter: { xNm: BigInt(Math.round(spec.drillNm)), yNm: BigInt(Math.round(spec.drillNm)) }, startLayer: layerEnum(first), endLayer: layerEnum(last) },
      copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: PadStackShape.PSS_CIRCLE, size: { xNm: BigInt(Math.round(spec.diameterNm)), yNm: BigInt(Math.round(spec.diameterNm)) } }],
    },
  });
  return stored('KOT_PCB_VIA', proto, { layer: first, net: spec.net, bbox: bboxOf([at], spec.diameterNm / 2) });
}

export type ShapeGeometry =
  | { kind: 'segment'; a: Pt; b: Pt }
  | { kind: 'rect'; a: Pt; b: Pt }
  | { kind: 'circle'; c: Pt; r: number }
  | { kind: 'arc'; start: Pt; mid: Pt; end: Pt }
  | { kind: 'polygon'; pts: Pt[] };

function geometryInit(g: ShapeGeometry) {
  switch (g.kind) {
    case 'segment':
      return { case: 'segment' as const, value: { start: V(g.a), end: V(g.b) } };
    case 'rect':
      return { case: 'rectangle' as const, value: { topLeft: V({ x: Math.min(g.a.x, g.b.x), y: Math.min(g.a.y, g.b.y) }), bottomRight: V({ x: Math.max(g.a.x, g.b.x), y: Math.max(g.a.y, g.b.y) }) } };
    case 'circle':
      return { case: 'circle' as const, value: { center: V(g.c), radiusPoint: V({ x: g.c.x + g.r, y: g.c.y }) } };
    case 'arc':
      return { case: 'arc' as const, value: { start: V(g.start), mid: V(g.mid), end: V(g.end) } };
    case 'polygon':
      return { case: 'polygon' as const, value: polySet(g.pts) };
  }
}

export function polySet(pts: Pt[]) {
  return { polygons: [{ outline: { closed: true, nodes: pts.map((p) => ({ geometry: { case: 'point' as const, value: V(p) } })) }, holes: [] }] };
}

export function geometryPoints(g: ShapeGeometry): Pt[] {
  switch (g.kind) {
    case 'segment':
    case 'rect':
      return [g.a, g.b];
    case 'circle':
      return [
        { x: g.c.x - g.r, y: g.c.y - g.r },
        { x: g.c.x + g.r, y: g.c.y + g.r },
      ];
    case 'arc':
      return [g.start, g.mid, g.end];
    case 'polygon':
      return g.pts;
  }
}

export function makeBoardShape(g: ShapeGeometry, layer: string, widthNm: number, opts: { filled?: boolean; net?: string } = {}): StoredItem {
  const proto = create(BoardGraphicShapeSchema, {
    id: { value: newKiid() },
    layer: layerEnum(layer),
    locked: LockedState.LS_UNLOCKED,
    net: opts.net ? { name: opts.net } : undefined,
    shape: { attributes: { stroke: { width: D(widthNm) }, fill: { fillType: opts.filled ? 2 : 1 } }, geometry: geometryInit(g) },
  });
  return stored('KOT_PCB_SHAPE', proto, { layer, net: opts.net, bbox: bboxOf(geometryPoints(g), widthNm / 2) });
}

export interface TextSpec {
  text: string;
  sizeNm?: number;
  thicknessNm?: number;
  angleDeg?: number;
}

export function makeBoardText(at: Pt, layer: string, spec: TextSpec): StoredItem {
  const size = spec.sizeNm ?? 1_000_000;
  const proto = create(BoardTextSchema, {
    id: { value: newKiid() },
    layer: layerEnum(layer),
    locked: LockedState.LS_UNLOCKED,
    text: {
      text: spec.text,
      position: V(at),
      attributes: {
        size: { xNm: BigInt(size), yNm: BigInt(size) },
        strokeWidth: D(spec.thicknessNm ?? Math.round(size * 0.15)),
        angle: { valueDegrees: spec.angleDeg ?? 0 },
        visible: true,
        horizontalAlignment: 2,
        verticalAlignment: 2,
      },
    },
  });
  const w = size * 0.8 * Math.max(1, spec.text.length);
  return stored('KOT_PCB_TEXT', proto, { layer, bbox: { x: at.x - w / 2, y: at.y - size / 2, w, h: size } });
}

export interface ZoneSpec {
  net?: string;
  name?: string;
  clearanceNm?: number;
  minThicknessNm?: number;
  /** rule area instead of copper */
  keepout?: boolean;
}

export function makeZone(pts: Pt[], layers: string[], spec: ZoneSpec = {}): StoredItem {
  const proto = create(ZoneSchema, {
    id: { value: newKiid() },
    type: spec.keepout ? ZoneType.ZT_RULE_AREA : ZoneType.ZT_COPPER,
    layers: layers.map(layerEnum),
    name: spec.name ?? '',
    outline: polySet(pts),
    locked: LockedState.LS_UNLOCKED,
    border: { style: ZoneBorderStyle.ZBS_DIAGONAL_EDGE, pitch: D(500_000) },
    settings: spec.keepout
      ? { case: 'ruleAreaSettings', value: { keepoutCopper: true, keepoutTracks: true, keepoutVias: true } }
      : {
          case: 'copperSettings',
          value: { net: spec.net ? { name: spec.net } : undefined, clearance: D(spec.clearanceNm ?? 200_000), minThickness: D(spec.minThicknessNm ?? 250_000), fillMode: ZoneFillMode.ZFM_SOLID },
        },
  });
  return stored('KOT_PCB_ZONE', proto, { layer: layers[0], net: spec.net, bbox: bboxOf(pts) });
}

/** What the library footprint document served (`OpenDocument(DOCTYPE_FOOTPRINT)` + `GetItems`). */
export interface LibraryFootprint {
  libId: string;
  /** Pads, shapes, texts, zones … in footprint-local coordinates (decoded messages). */
  items: Message[];
  /** Mandatory fields (Reference, Value, Datasheet, Description) in local coordinates. */
  fields: Message[];
}

function shiftVec(v: unknown, dx: number, dy: number): unknown {
  if (!v || typeof v !== 'object') return v;
  const o = v as { xNm?: bigint | number; yNm?: bigint | number };
  if (typeof o.xNm !== 'bigint' && typeof o.xNm !== 'number') return v;
  return { ...o, xNm: BigInt(Math.round(Number(o.xNm) + dx)), yNm: BigInt(Math.round(Number(o.yNm) + dy)) };
}

const POSITIONAL = ['position', 'start', 'end', 'mid', 'center', 'radiusPoint', 'topLeft', 'bottomRight', 'p0', 'p1', 'p2', 'p3'];

/** Translates every coordinate of a decoded footprint child (pad / shape / text / zone) by (dx, dy). */
export function translateChild<T>(msg: T, dx: number, dy: number): T {
  const walk = (o: unknown, key?: string): unknown => {
    if (!o || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map((el) => walk(el, key));
    const rec = o as Record<string, unknown>;
    if (key && POSITIONAL.includes(key) && (typeof rec.xNm === 'bigint' || typeof rec.xNm === 'number')) return shiftVec(rec, dx, dy);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = k === 'size' || k === 'offset' || k === 'diameter' || k === 'anchor' ? v : walk(v, k);
    return out;
  };
  return walk(msg) as T;
}

/**
 * A footprint instance at `at` on `layer` from a library footprint. KiCad's `FOOTPRINT::Deserialize`
 * rebuilds pads/shapes from `definition.items` (absolute board coordinates, as `PAD::Serialize`
 * writes them), so the library children are translated by the placement position; fields are
 * translated the same way. Orientation is left at 0 (rotate after placing).
 */
export function makeFootprintInstance(at: Pt, layer: string, lib: LibraryFootprint, reference: string, value?: string): StoredItem {
  const [nick, ...rest] = lib.libId.split(':');
  const entry = rest.join(':');
  const items: Any[] = [];
  for (const m of lib.items) {
    const desc = kiapiRegistry.getMessage(m.$typeName);
    if (!desc) continue;
    const moved = translateChild(structuredCloneSafe(m) as Record<string, unknown>, at.x, at.y);
    delete moved.id;
    delete moved.parent;
    items.push(packAny(desc, create(desc, moved as never)));
  }
  const fieldByName = (name: string) => {
    const f = lib.fields.find((m) => (m as { name?: string }).name === name) as Record<string, unknown> | undefined;
    if (!f) return undefined;
    const moved = translateChild(structuredCloneSafe(f), at.x, at.y) as Record<string, any>;
    if (moved.text) {
      delete moved.text.id;
      delete moved.text.parent;
    }
    return moved;
  };
  const ref = fieldByName('Reference') ?? {
    name: 'Reference',
    visible: true,
    text: {
      layer: BoardLayer.BL_F_SilkS,
      text: { text: '', position: V({ x: at.x, y: at.y - 1_500_000 }), attributes: { size: { xNm: 1_000_000n, yNm: 1_000_000n }, strokeWidth: D(150_000), visible: true } },
    },
  };
  if (ref.text?.text) ref.text.text.text = reference;
  const val = fieldByName('Value') ?? {
    name: 'Value',
    visible: true,
    text: {
      layer: BoardLayer.BL_F_Fab,
      text: { text: '', position: V({ x: at.x, y: at.y + 1_500_000 }), attributes: { size: { xNm: 1_000_000n, yNm: 1_000_000n }, strokeWidth: D(150_000), visible: true } },
    },
  };
  if (val.text?.text && value !== undefined) val.text.text.text = value;
  const proto: FootprintInstance = create(FootprintInstanceSchema, {
    id: { value: newKiid() },
    position: V(at),
    orientation: { valueDegrees: 0 },
    layer: layerEnum(layer),
    locked: LockedState.LS_UNLOCKED,
    definition: { id: { libraryNickname: nick ?? '', entryName: entry }, items },
    referenceField: ref as never,
    valueField: val as never,
    datasheetField: fieldByName('Datasheet') as never,
    descriptionField: fieldByName('Description') as never,
  });
  const pts: Pt[] = [];
  for (const m of lib.items) {
    const p = (m as { position?: { xNm: bigint | number; yNm: bigint | number } }).position;
    if (p) pts.push({ x: at.x + Number(p.xNm), y: at.y + Number(p.yNm) });
  }
  return stored('KOT_PCB_FOOTPRINT', proto, { layer, bbox: bboxOf(pts.length ? pts : [at], 1_000_000) });
}

/** Next free reference for a prefix (`R` → `R7`) given the references in use. */
export function nextReference(prefix: string, used: Iterable<string>): string {
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  for (const r of used) {
    const m = re.exec(r);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

// ------------------------------------------------------------------------ schematic

const TEXT_SIZE = 1_270_000;
const textAttrs = (size = TEXT_SIZE) => ({ size: { xNm: BigInt(size), yNm: BigInt(size) }, visible: true, horizontalAlignment: 1, verticalAlignment: 2 });

export function makeSchematicLine(a: Pt, b: Pt, type: 'wire' | 'bus' | 'graphic', widthNm = 0): StoredItem {
  const t = type === 'wire' ? SchematicLineType.SLT_WIRE : type === 'bus' ? SchematicLineType.SLT_BUS : SchematicLineType.SLT_GRAPHIC;
  const proto = create(SchematicLineSchema, { id: { value: newKiid() }, start: V(a), end: V(b), type: t, stroke: { width: D(widthNm) }, locked: LockedState.LS_UNLOCKED });
  return stored('KOT_SCH_LINE', proto, { bbox: bboxOf([a, b], 100_000) });
}

export function makeJunction(at: Pt, diameterNm = 0): StoredItem {
  const proto = create(JunctionSchema, { id: { value: newKiid() }, position: V(at), diameter: D(diameterNm), locked: LockedState.LS_UNLOCKED });
  return stored('KOT_SCH_JUNCTION', proto, { bbox: bboxOf([at], 400_000) });
}

export function makeNoConnect(at: Pt): StoredItem {
  const proto = create(NoConnectMarkerSchema, { id: { value: newKiid() }, position: V(at), size: D(0), locked: LockedState.LS_UNLOCKED });
  return stored('KOT_SCH_NO_CONNECT', proto, { bbox: bboxOf([at], 400_000) });
}

export type LabelKind = 'local' | 'global' | 'hier';
export type LabelShape = 'input' | 'output' | 'bidi' | 'tristate' | 'passive';

const LABEL_SHAPES: Record<LabelShape, SchematicLabelShape> = {
  input: SchematicLabelShape.SLSH_INPUT,
  output: SchematicLabelShape.SLSH_OUTPUT,
  bidi: SchematicLabelShape.SLSH_BIDI,
  tristate: SchematicLabelShape.SLSH_TRISTATE,
  passive: SchematicLabelShape.SLSH_PASSIVE,
};

export function makeLabel(at: Pt, kind: LabelKind, text: string, opts: { shape?: LabelShape; sizeNm?: number; spin?: 'left' | 'up' | 'right' | 'bottom' } = {}): StoredItem {
  const spin = { left: SchematicLabelSpinStyle.SLSS_LEFT, up: SchematicLabelSpinStyle.SLSS_UP, right: SchematicLabelSpinStyle.SLSS_RIGHT, bottom: SchematicLabelSpinStyle.SLSS_BOTTOM }[
    opts.spin ?? 'right'
  ];
  const base = { id: { value: newKiid() }, position: V(at), text: { text, position: V(at), attributes: textAttrs(opts.sizeNm) }, spinStyle: spin, locked: LockedState.LS_UNLOCKED };
  const shape = LABEL_SHAPES[opts.shape ?? 'input'];
  const size = opts.sizeNm ?? TEXT_SIZE;
  const bbox = { x: at.x, y: at.y - size, w: size * 0.8 * Math.max(1, text.length), h: size * 2 };
  if (kind === 'local') return stored('KOT_SCH_LABEL', create(LocalLabelSchema, base), { net: text, bbox });
  if (kind === 'global') return stored('KOT_SCH_GLOBAL_LABEL', create(GlobalLabelSchema, { ...base, shape }), { net: text, bbox });
  return stored('KOT_SCH_HIER_LABEL', create(HierarchicalLabelSchema, { ...base, shape }), { net: text, bbox });
}

export function makeSchematicText(at: Pt, text: string, sizeNm = TEXT_SIZE): StoredItem {
  const proto = create(SchematicTextSchema, { id: { value: newKiid() }, text: { text, position: V(at), attributes: textAttrs(sizeNm) }, locked: LockedState.LS_UNLOCKED });
  return stored('KOT_SCH_TEXT', proto, { bbox: { x: at.x, y: at.y - sizeNm, w: sizeNm * 0.8 * Math.max(1, text.length), h: sizeNm } });
}

export function makeSheet(a: Pt, b: Pt, name: string, fileName: string): StoredItem {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  const proto = create(SheetSymbolSchema, {
    id: { value: newKiid() },
    position: V({ x, y }),
    size: V({ x: w, y: h }),
    borderStroke: { width: D(0) },
    locked: LockedState.LS_UNLOCKED,
    nameField: { name: 'Sheetname', visible: true, text: { text: name, position: V({ x, y: y - 200_000 }), attributes: { ...textAttrs(), verticalAlignment: 3 } } },
    filenameField: { name: 'Sheetfile', visible: true, text: { text: fileName, position: V({ x, y: y + h + 200_000 }), attributes: { ...textAttrs(), verticalAlignment: 1 } } },
  });
  return stored('KOT_SCH_SHEET', proto, { bbox: { x, y, w, h } });
}

/**
 * A symbol instance from a library definition (`OpenDocument(DOCTYPE_SYMBOL)` + `GetItems(KOT_LIB_SYMBOL)`).
 * `SCH_SYMBOL::Deserialize` rebuilds the LIB_SYMBOL from `definition` (children in symbol
 * coordinates), so the definition is embedded verbatim; instance fields get sheet coordinates.
 */
export function makeSymbolInstance(at: Pt, def: SchematicSymbolDefinition, reference: string, value: string, opts: { unit?: number; footprint?: string } = {}): StoredItem {
  const field = (name: string, text: string, src: { text?: { position?: { xNm: bigint | number; yNm: bigint | number }; attributes?: unknown } } | undefined, visible: boolean) => ({
    name,
    visible,
    text: {
      text,
      position: V({ x: at.x + Number(src?.text?.position?.xNm ?? 0), y: at.y + Number(src?.text?.position?.yNm ?? 0) }),
      attributes: (src?.text?.attributes as never) ?? textAttrs(),
    },
  });
  const definition = structuredCloneSafe(def);
  const proto = create(SchematicSymbolInstanceSchema, {
    id: { value: newKiid() },
    position: V(at),
    transform: { orientation: SchematicSymbolOrientation.SSO_0, mirrorX: false, mirrorY: false },
    locked: LockedState.LS_UNLOCKED,
    definition: definition as never,
    libId: def.id,
    referenceField: field('Reference', reference, def.referenceField, true),
    valueField: field('Value', value, def.valueField, true),
    footprintField: field('Footprint', opts.footprint ?? def.footprintField?.text?.text ?? '', def.footprintField, false),
    datasheetField: field('Datasheet', def.datasheetField?.text?.text ?? '~', def.datasheetField, false),
    descriptionField: field('Description', def.descriptionField?.text?.text ?? '', def.descriptionField, false),
    unit: { unit: opts.unit ?? 1 },
    showPinNames: true,
    showPinNumbers: true,
  });
  return stored('KOT_SCH_SYMBOL', proto, { bbox: { x: at.x - 2_540_000, y: at.y - 3_810_000, w: 5_080_000, h: 7_620_000 } });
}

/** Deep copy of a store item with a fresh id (and parent remap), shifted by (dx, dy). */
export function cloneForPaste(item: StoredItem, dx: number, dy: number, idMap: Map<string, string>): StoredItem {
  const proto = translateChild(structuredCloneSafe(item.proto) as Record<string, unknown>, dx, dy) as Record<string, any>;
  const id = idMap.get(item.id) ?? newKiid();
  idMap.set(item.id, id);
  if (proto.id && typeof proto.id === 'object') proto.id = { ...proto.id, value: id };
  else proto.id = { value: id };
  const parent = item.parent && idMap.has(item.parent) ? idMap.get(item.parent) : undefined;
  if (parent) proto.parent = { ...(proto.parent ?? {}), value: parent };
  else delete proto.parent;
  return { ...item, id, parent, proto, bbox: item.bbox ? { ...item.bbox, x: item.bbox.x + dx, y: item.bbox.y + dy } : undefined };
}

export function descFor(typeName: string): DescMessage | undefined {
  return kiapiRegistry.getMessage(typeName);
}
