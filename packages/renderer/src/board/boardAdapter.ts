/**
 * Board adapter: kiapi board items (protobuf-es message shapes: camelCase fields, int64 as
 * bigint, numeric enums, oneofs as `{ case, value }`) -> RenderItems.
 *
 * The adapter is deliberately tolerant: nm fields may be number | bigint | string, enums
 * may be numbers or their names, oneofs may be `{case,value}` or flat fields. Nested
 * footprint items may be decoded messages (`$typeName`), `{ type: 'KOT_PCB_PAD', proto }`
 * wrappers, or undecoded `Any`s (skipped).
 */
import type { Box, Primitive, RenderItem, Vec2 } from '../core/model.js';
import { EMPTY_BOX, boxFromPoints, boxOfPrimitives, boxUnion, vAdd, vDist, vRotate, vSub } from '../core/model.js';
import {
  arcToPolyline,
  bezierToPolyline,
  chamferedRectPolygon,
  circleToPolygon,
  dashPolyline,
  ellipseToPolygon,
  hatchPolygon,
  ovalPolygon,
  rectPolygon,
  roundRectPolygon,
  transformPoly,
  trapezoidPolygon,
} from '../core/geometry.js';
import type { StoredItemLike } from '../core/host.js';
import { textGlyphPrims } from '../schematic/textMetrics.js';
import { PSEUDO_LAYERS, boardLayerName, copperLayerList, flipLayer, isBackLayer, isCopperLayer, isFrontLayer } from './boardLayers.js';

// ---------------------------------------------------------------------------
// Input shapes (subset of kiapi.common.types / kiapi.board.types, protobuf-es style)
// ---------------------------------------------------------------------------

export type Nm = number | bigint | string | undefined | null;
export interface Vector2Like {
  xNm?: Nm;
  yNm?: Nm;
}
export interface DistanceLike {
  valueNm?: Nm;
}
export interface AngleLike {
  valueDegrees?: number;
}
export interface KiidLike {
  value?: string;
}
export interface NetLike {
  code?: { value?: number };
  name?: string;
}
export interface ArcLike {
  start?: Vector2Like;
  mid?: Vector2Like;
  end?: Vector2Like;
}
export interface PolyLineNodeLike {
  geometry?: { case: 'point'; value: Vector2Like } | { case: 'arc'; value: ArcLike } | { case?: undefined };
  point?: Vector2Like;
  arc?: ArcLike;
}
export interface PolyLineLike {
  nodes?: PolyLineNodeLike[];
  closed?: boolean;
}
export interface PolygonWithHolesLike {
  outline?: PolyLineLike;
  holes?: PolyLineLike[];
}
export interface PolySetLike {
  polygons?: PolygonWithHolesLike[];
}
export interface StrokeAttributesLike {
  width?: DistanceLike;
  style?: number | string;
}
export interface GraphicAttributesLike {
  stroke?: StrokeAttributesLike;
  fill?: { fillType?: number | string };
}
export interface LineEndingLike {
  style?: number | string;
  length?: DistanceLike;
  width?: DistanceLike;
}
export interface GraphicShapeLike {
  attributes?: GraphicAttributesLike;
  geometry?: { case: string; value: unknown } | { case?: undefined };
  segment?: { start?: Vector2Like; end?: Vector2Like };
  rectangle?: { topLeft?: Vector2Like; bottomRight?: Vector2Like; cornerRadius?: DistanceLike };
  arc?: ArcLike;
  circle?: { center?: Vector2Like; radiusPoint?: Vector2Like };
  polygon?: PolySetLike;
  bezier?: { start?: Vector2Like; control1?: Vector2Like; control2?: Vector2Like; end?: Vector2Like };
  ellipse?: { center?: Vector2Like; majorRadius?: DistanceLike; minorRadius?: DistanceLike; rotation?: AngleLike };
  ellipseArc?: { center?: Vector2Like; majorRadius?: DistanceLike; minorRadius?: DistanceLike; rotation?: AngleLike; startAngle?: AngleLike; endAngle?: AngleLike };
  startEnding?: LineEndingLike;
  endEnding?: LineEndingLike;
}
export interface TextAttributesLike {
  horizontalAlignment?: number | string;
  verticalAlignment?: number | string;
  angle?: AngleLike;
  lineSpacing?: number;
  strokeWidth?: DistanceLike;
  visible?: boolean;
  mirrored?: boolean;
  size?: Vector2Like;
}
export interface TextLike {
  position?: Vector2Like;
  attributes?: TextAttributesLike;
  text?: string;
}
export interface TextBoxLike {
  topLeft?: Vector2Like;
  bottomRight?: Vector2Like;
  attributes?: TextAttributesLike;
  text?: string;
  borderEnabled?: boolean;
}
export interface BoardTextLike {
  id?: KiidLike;
  text?: TextLike;
  layer?: number | string;
  knockout?: boolean;
}
export interface FieldLike {
  name?: string;
  text?: BoardTextLike;
  visible?: boolean;
}

/** Either a protobuf-es GraphicShape list (from GetTextAsShapes CompoundShape.shapes) or plain polygons. */
export type TextShapesInput = GraphicShapeLike[] | Vec2[][];
/** Either protobuf-es PolygonWithHoles list (GetPadShapeAsPolygon) or plain polygons. */
export type PadPolygonsInput = PolygonWithHolesLike[] | Vec2[][];

export interface BoardAdapterContext {
  /** copper layers of the board, front to back; default 2-layer */
  copperLayers?: readonly string[];
  /** pad outline from GetPadShapeAsPolygon for (pad KIID, layer); fallback draws the padstack shapes */
  padPolygons?: (padId: string, layer: string) => PadPolygonsInput | undefined;
  /** glyph geometry from GetTextAsShapes keyed by the text/field/dimension/textbox KIID */
  textShapes?: (textId: string) => TextShapesInput | undefined;
  /** bbox of another store item (for groups) */
  itemBBox?: (id: string) => Box | undefined;
  /**
   * Footprint child items already carry absolute board coordinates (true for data from the
   * KiCad API). Set false for library footprints whose children are relative to the anchor.
   */
  footprintChildrenAbsolute?: boolean;
  /** nm per reference-image pixel (KiCad: 25.4e6 / 300 ppi) */
  imagePixelNm?: number;
  /** arc approximation tolerance (nm) for polygon arcs */
  arcTolerance?: number;
  /**
   * Pad number / net name labels as `text-glyphs` primitives on the `board.pad_numbers`,
   * `board.pad_net_names`, `board.track_net_names` and `board.via_net_names` layers
   * (pcb_painter.cpp sizing). Off by default; `BoardCanvasHost.setLabelOptions` sets it and
   * gates the layers by zoom.
   */
  labels?: BoardLabelOptions;
}

export interface BoardLabelOptions {
  /** pad numbers inside pads */
  padNumbers?: boolean;
  /** net names inside pads and vias and along tracks */
  netNames?: boolean;
}

// ---------------------------------------------------------------------------
// Value readers
// ---------------------------------------------------------------------------

export function nm(v: Nm): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const vec = (v?: Vector2Like | null): Vec2 => ({ x: nm(v?.xNm), y: nm(v?.yNm) });
export const dist = (d?: DistanceLike | null): number => nm(d?.valueNm);
export const deg = (a?: AngleLike | null): number => a?.valueDegrees ?? 0;
export const kiid = (k?: KiidLike | string | null): string => (typeof k === 'string' ? k : (k?.value ?? ''));

const ENUMS = {
  PadStackShape: ['PSS_UNKNOWN', 'PSS_CIRCLE', 'PSS_RECTANGLE', 'PSS_OVAL', 'PSS_TRAPEZOID', 'PSS_ROUNDRECT', 'PSS_CHAMFEREDRECT', 'PSS_CUSTOM'],
  PadStackType: ['PST_UNKNOWN', 'PST_NORMAL', 'PST_FRONT_INNER_BACK', 'PST_CUSTOM'],
  PadType: ['PT_UNKNOWN', 'PT_PTH', 'PT_SMD', 'PT_EDGE_CONNECTOR', 'PT_NPTH'],
  DrillShape: ['DS_UNKNOWN', 'DS_CIRCLE', 'DS_OBLONG', 'DS_UNDEFINED'],
  ZoneType: ['ZT_UNKNOWN', 'ZT_COPPER', 'ZT_GRAPHICAL', 'ZT_RULE_AREA', 'ZT_TEARDROP'],
  ZoneBorderStyle: ['ZBS_UNKNOWN', 'ZBS_SOLID', 'ZBS_DIAGONAL_FULL', 'ZBS_DIAGONAL_EDGE', 'ZBS_INVISIBLE'],
  GraphicFillType: ['GFT_UNKNOWN', 'GFT_UNFILLED', 'GFT_FILLED', 'GFT_FILLED_WITH_COLOR', 'GFT_FILLED_WITH_BACKGROUND_BODY_COLOR', 'GFT_HATCH', 'GFT_REVERSE_HATCH', 'GFT_CROSS_HATCH'],
  StrokeLineStyle: ['SLS_UNKNOWN', 'SLS_DEFAULT', 'SLS_SOLID', 'SLS_DASH', 'SLS_DOT', 'SLS_DASHDOT', 'SLS_DASHDOTDOT'],
  LineEndingStyle: ['LES_UNKNOWN', 'LES_NONE', 'LES_ARROW', 'LES_CIRCLE', 'LES_SQUARE', 'LES_ARROW_OPEN'],
  HorizontalAlignment: ['HA_UNKNOWN', 'HA_LEFT', 'HA_CENTER', 'HA_RIGHT', 'HA_INDETERMINATE'],
  VerticalAlignment: ['VA_UNKNOWN', 'VA_TOP', 'VA_CENTER', 'VA_BOTTOM', 'VA_INDETERMINATE'],
  AxisAlignment: ['AA_UNKNOWN', 'AA_X_AXIS', 'AA_Y_AXIS'],
  TableStrokeMode: ['TSM_UNKNOWN', 'TSM_DISABLED', 'TSM_ENABLED'],
  DimensionArrowDirection: ['DAD_UNKNOWN', 'DAD_INWARD', 'DAD_OUTWARD'],
  DimensionTextBorderStyle: ['DTBS_UNKNOWN', 'DTBS_NONE', 'DTBS_RECTANGLE', 'DTBS_CIRCLE', 'DTBS_ROUNDRECT'],
  ViaType: ['VT_UNKNOWN', 'VT_THROUGH', 'VT_BLIND_BURIED', 'VT_MICRO', 'VT_BLIND', 'VT_BURIED'],
} as const;

type EnumName = keyof typeof ENUMS;

/** Enum value (number or name) -> name. */
export function enumName(kind: EnumName, v: number | string | undefined | null): string {
  const table = ENUMS[kind] as readonly string[];
  if (typeof v === 'number') return table[v] ?? table[0]!;
  if (typeof v === 'string') return v;
  return table[0]!;
}

/** Read a oneof in either protobuf-es `{case,value}` form or flat-field form. */
export function oneof<T = unknown>(msg: Record<string, unknown> | undefined, field: string, cases: readonly string[]): { case: string; value: T } | undefined {
  if (!msg) return undefined;
  const o = msg[field] as { case?: string; value?: unknown } | undefined;
  if (o && typeof o === 'object' && typeof o.case === 'string') return { case: o.case, value: o.value as T };
  for (const c of cases) {
    const v = msg[c];
    if (v !== undefined && v !== null) return { case: c, value: v as T };
  }
  return undefined;
}

const KOT_BY_TYPENAME: Record<string, string> = {
  'kiapi.board.types.Track': 'KOT_PCB_TRACE',
  'kiapi.board.types.Arc': 'KOT_PCB_ARC',
  'kiapi.board.types.Via': 'KOT_PCB_VIA',
  'kiapi.board.types.Pad': 'KOT_PCB_PAD',
  'kiapi.board.types.BoardGraphicShape': 'KOT_PCB_SHAPE',
  'kiapi.board.types.BoardText': 'KOT_PCB_TEXT',
  'kiapi.board.types.BoardTextBox': 'KOT_PCB_TEXTBOX',
  'kiapi.board.types.Field': 'KOT_PCB_FIELD',
  'kiapi.board.types.Zone': 'KOT_PCB_ZONE',
  'kiapi.board.types.FootprintInstance': 'KOT_PCB_FOOTPRINT',
  'kiapi.board.types.Dimension': 'KOT_PCB_DIMENSION',
  'kiapi.board.types.ReferenceImage': 'KOT_PCB_REFERENCE_IMAGE',
  'kiapi.board.types.Group': 'KOT_PCB_GROUP',
  'kiapi.board.types.Barcode': 'KOT_PCB_BARCODE',
  'kiapi.board.types.ReferencePoint': 'KOT_PCB_POINT',
  'kiapi.board.types.GridItem': 'KOT_PCB_GRIDITEM',
  'kiapi.board.types.Table': 'KOT_PCB_TABLE',
};

/** KOT_* type of a nested footprint item (decoded message, wrapper, or Any). */
export function itemTypeOf(x: unknown): { type: string; proto: Record<string, unknown> } | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.type === 'string' && o.type.startsWith('KOT_') && o.proto && typeof o.proto === 'object') {
    return { type: o.type, proto: o.proto as Record<string, unknown> };
  }
  const tn = o.$typeName;
  if (typeof tn === 'string') {
    if (tn === 'google.protobuf.Any') {
      const url = o.typeUrl as string | undefined;
      // undecoded Any: cannot render; the client must decode footprint children
      return url ? undefined : undefined;
    }
    const t = KOT_BY_TYPENAME[tn];
    return t ? { type: t, proto: o } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Geometry converters
// ---------------------------------------------------------------------------

export function polyLineToPoints(pl: PolyLineLike | undefined, arcTol = 5000): Vec2[] {
  const pts: Vec2[] = [];
  if (!pl?.nodes) return pts;
  for (const node of pl.nodes) {
    const g = oneof<Vector2Like | ArcLike>(node as Record<string, unknown>, 'geometry', ['point', 'arc']);
    if (!g) continue;
    if (g.case === 'point') pts.push(vec(g.value as Vector2Like));
    else {
      const a = g.value as ArcLike;
      const arc = arcToPolyline(vec(a.start), vec(a.mid), vec(a.end), arcTol);
      if (pts.length && vDist(pts[pts.length - 1]!, arc[0]!) < 1) arc.shift();
      pts.push(...arc);
    }
  }
  // drop a duplicated closing point
  if (pts.length > 2 && vDist(pts[0]!, pts[pts.length - 1]!) < 1) pts.pop();
  return pts;
}

export function polygonWithHoles(p: PolygonWithHolesLike | undefined, arcTol = 5000): { outline: Vec2[]; holes: Vec2[][] } {
  return { outline: polyLineToPoints(p?.outline, arcTol), holes: (p?.holes ?? []).map((h) => polyLineToPoints(h, arcTol)).filter((h) => h.length >= 3) };
}

export function polySetToPrims(ps: PolySetLike | undefined, fill: boolean, width: number, arcTol = 5000, mesh = false): Primitive[] {
  const out: Primitive[] = [];
  for (const p of ps?.polygons ?? []) {
    const { outline, holes } = polygonWithHoles(p, arcTol);
    if (outline.length < 2) continue;
    out.push({ kind: 'polygon', outline, holes, fill, width, mesh });
  }
  return out;
}

const isPolyList = (x: PadPolygonsInput | TextShapesInput): x is Vec2[][] => Array.isArray(x) && (x.length === 0 || Array.isArray(x[0]));

/** Dash pattern (nm) for a KiCad line style, using the default 12/3 dash/gap ratios. */
export function dashPattern(style: string, width: number): number[] | undefined {
  const w = Math.max(width, 100_000); // KiCad uses a minimum for hairlines
  switch (style) {
    case 'SLS_DASH':
      return [12 * w, 3 * w];
    case 'SLS_DOT':
      return [w, 3 * w];
    case 'SLS_DASHDOT':
      return [12 * w, 3 * w, w, 3 * w];
    case 'SLS_DASHDOTDOT':
      return [12 * w, 3 * w, w, 3 * w, w, 3 * w];
    default:
      return undefined;
  }
}

export function strokedPolyline(pts: Vec2[], width: number, pattern: number[] | undefined, closed: boolean): Primitive[] {
  if (pts.length < 2) return [];
  const line = closed ? [...pts, pts[0]!] : pts;
  if (!pattern) {
    if (closed) return [{ kind: 'polygon', outline: pts, holes: [], fill: false, width }];
    const out: Primitive[] = [];
    for (let i = 0; i + 1 < line.length; i++) out.push({ kind: 'segment', a: line[i]!, b: line[i + 1]!, width });
    return out;
  }
  return dashPolyline(line, pattern).map(([a, b]) => ({ kind: 'segment', a, b, width }) as Primitive);
}

export function lineEnding(at: Vec2, from: Vec2, ending: LineEndingLike | undefined, width: number): Primitive[] {
  const style = enumName('LineEndingStyle', ending?.style);
  if (style === 'LES_NONE' || style === 'LES_UNKNOWN') return [];
  const len = dist(ending?.length) || Math.max(6 * width, 500_000);
  const w = dist(ending?.width) || width;
  const d = vSub(at, from);
  const l = vDist(at, from) || 1;
  const dir = { x: d.x / l, y: d.y / l };
  switch (style) {
    case 'LES_ARROW':
    case 'LES_ARROW_OPEN': {
      const base = vSub(at, { x: dir.x * len, y: dir.y * len });
      const n = { x: -dir.y * len * 0.35, y: dir.x * len * 0.35 };
      const p1 = vAdd(base, n);
      const p2 = vSub(base, n);
      if (style === 'LES_ARROW') return [{ kind: 'polygon', outline: [at, p1, p2], holes: [], fill: true, width: 0 }];
      return [
        { kind: 'segment', a: at, b: p1, width: w },
        { kind: 'segment', a: at, b: p2, width: w },
      ];
    }
    case 'LES_CIRCLE':
      return [{ kind: 'circle', c: at, r: len / 2, width: 0, fill: true }];
    case 'LES_SQUARE': {
      const h = len / 2;
      const ang = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
      return [{ kind: 'polygon', outline: transformPoly(rectPolygon(2 * h, 2 * h), -ang, at), holes: [], fill: true, width: 0 }];
    }
  }
  return [];
}

/** GraphicShape (kiapi.common.types) -> primitives. */
export function graphicShapeToPrims(shape: GraphicShapeLike | undefined, ctx: BoardAdapterContext = {}): Primitive[] {
  if (!shape) return [];
  const arcTol = ctx.arcTolerance ?? 5000;
  const width = dist(shape.attributes?.stroke?.width);
  const style = enumName('StrokeLineStyle', shape.attributes?.stroke?.style);
  const pattern = dashPattern(style, width);
  const fillType = enumName('GraphicFillType', shape.attributes?.fill?.fillType);
  const filled = fillType !== 'GFT_UNFILLED' && fillType !== 'GFT_UNKNOWN';
  const g = oneof<Record<string, unknown>>(shape as Record<string, unknown>, 'geometry', ['segment', 'rectangle', 'arc', 'circle', 'polygon', 'bezier', 'ellipse', 'ellipseArc']);
  if (!g) return [];
  const out: Primitive[] = [];
  switch (g.case) {
    case 'segment': {
      const s = g.value as NonNullable<GraphicShapeLike['segment']>;
      const a = vec(s.start);
      const b = vec(s.end);
      out.push(...strokedPolyline([a, b], width, pattern, false));
      out.push(...lineEnding(a, b, shape.startEnding, width), ...lineEnding(b, a, shape.endEnding, width));
      break;
    }
    case 'rectangle': {
      const r = g.value as NonNullable<GraphicShapeLike['rectangle']>;
      const tl = vec(r.topLeft);
      const br = vec(r.bottomRight);
      const w = Math.abs(br.x - tl.x);
      const h = Math.abs(br.y - tl.y);
      const c = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
      const radius = dist(r.cornerRadius);
      const poly = transformPoly(radius > 0 ? roundRectPolygon(w, h, radius) : rectPolygon(w, h), 0, c);
      if (filled) out.push({ kind: 'polygon', outline: poly, holes: [], fill: true, width: pattern ? 0 : width });
      if (!filled || width > 0) out.push(...strokedPolyline(poly, width, pattern, true));
      break;
    }
    case 'arc': {
      const a = g.value as ArcLike;
      const start = vec(a.start);
      const mid = vec(a.mid);
      const end = vec(a.end);
      if (pattern) out.push(...strokedPolyline(arcToPolyline(start, mid, end, arcTol), width, pattern, false));
      else out.push({ kind: 'arc', start, mid, end, width });
      break;
    }
    case 'circle': {
      const c = g.value as NonNullable<GraphicShapeLike['circle']>;
      const center = vec(c.center);
      const r = vDist(center, vec(c.radiusPoint));
      if (pattern) {
        if (filled) out.push({ kind: 'circle', c: center, r, width: 0, fill: true });
        out.push(...strokedPolyline(circleToPolygon(center, r, 0, arcTol), width, pattern, true));
      } else out.push({ kind: 'circle', c: center, r, width, fill: filled });
      break;
    }
    case 'polygon': {
      const ps = g.value as PolySetLike;
      if (pattern) {
        for (const p of ps.polygons ?? []) {
          const { outline, holes } = polygonWithHoles(p, arcTol);
          if (filled) out.push({ kind: 'polygon', outline, holes, fill: true, width: 0 });
          out.push(...strokedPolyline(outline, width, pattern, true));
          for (const h of holes) out.push(...strokedPolyline(h, width, pattern, true));
        }
      } else out.push(...polySetToPrims(ps, filled, width, arcTol));
      break;
    }
    case 'bezier': {
      const b = g.value as NonNullable<GraphicShapeLike['bezier']>;
      const p0 = vec(b.start);
      const p1 = vec(b.control1);
      const p2 = vec(b.control2);
      const p3 = vec(b.end);
      if (pattern) out.push(...strokedPolyline(bezierToPolyline(p0, p1, p2, p3), width, pattern, false));
      else out.push({ kind: 'bezier', p0, p1, p2, p3, width });
      break;
    }
    case 'ellipse': {
      const e = g.value as NonNullable<GraphicShapeLike['ellipse']>;
      const poly = ellipseToPolygon(vec(e.center), dist(e.majorRadius), dist(e.minorRadius), deg(e.rotation));
      if (filled) out.push({ kind: 'polygon', outline: poly, holes: [], fill: true, width: pattern ? 0 : width });
      if (!filled || width > 0) out.push(...strokedPolyline(poly, width, pattern, true));
      break;
    }
    case 'ellipseArc': {
      const e = g.value as NonNullable<GraphicShapeLike['ellipseArc']>;
      const poly = ellipseToPolygon(vec(e.center), dist(e.majorRadius), dist(e.minorRadius), deg(e.rotation), deg(e.startAngle), deg(e.endAngle));
      out.push(...strokedPolyline(poly, width, pattern, false));
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pads
// ---------------------------------------------------------------------------

interface PadStackLayerLike {
  layer?: number | string;
  shape?: number | string;
  size?: Vector2Like;
  cornerRoundingRatio?: number;
  chamferRatio?: number;
  chamferedCorners?: { topLeft?: boolean; topRight?: boolean; bottomLeft?: boolean; bottomRight?: boolean };
  customShapes?: Array<{ shape?: GraphicShapeLike; layer?: number | string }>;
  customAnchorShape?: number | string;
  trapezoidDelta?: Vector2Like;
  offset?: Vector2Like;
}
interface DrillLike {
  startLayer?: number | string;
  endLayer?: number | string;
  diameter?: Vector2Like;
  shape?: number | string;
}
interface PadStackLike {
  type?: number | string;
  layers?: Array<number | string>;
  drill?: DrillLike;
  copperLayers?: PadStackLayerLike[];
  angle?: AngleLike;
}

/** The PadStackLayer entry that applies to `layer` (PST_NORMAL: first entry for all layers). */
function padStackEntryFor(ps: PadStackLike, layer: string, copper: readonly string[]): PadStackLayerLike | undefined {
  const entries = ps.copperLayers ?? [];
  if (!entries.length) return undefined;
  const type = enumName('PadStackType', ps.type);
  const byLayer = (l: string) => entries.find((e) => boardLayerName(e.layer) === l);
  if (type === 'PST_CUSTOM') return byLayer(layer) ?? entries[0];
  if (type === 'PST_FRONT_INNER_BACK') {
    if (layer === 'BL_F_Cu' || isFrontLayer(layer)) return byLayer('BL_F_Cu') ?? entries[0];
    if (layer === 'BL_B_Cu' || isBackLayer(layer)) return byLayer('BL_B_Cu') ?? entries[entries.length - 1];
    return byLayer('BL_In1_Cu') ?? entries[Math.min(1, entries.length - 1)];
  }
  // PST_NORMAL / unknown: the F_Cu entry describes every layer
  return byLayer('BL_F_Cu') ?? byLayer(layer) ?? entries[0] ?? (copper.length ? entries[0] : undefined);
}

const padShapeCache = new Map<string, Vec2[]>();

/** Local (unrotated, centred) polygon for a padstack layer entry. Cached by shape parameters. */
export function padStackLayerPolygon(e: PadStackLayerLike, ctx: BoardAdapterContext = {}): Vec2[] {
  const shape = enumName('PadStackShape', e.shape);
  const size = vec(e.size);
  const key = `${shape}|${size.x}|${size.y}|${e.cornerRoundingRatio ?? 0}|${e.chamferRatio ?? 0}|${JSON.stringify(e.chamferedCorners ?? {})}|${nm(e.trapezoidDelta?.xNm)}|${nm(e.trapezoidDelta?.yNm)}`;
  if (shape !== 'PSS_CUSTOM') {
    const cached = padShapeCache.get(key);
    if (cached) return cached;
  }
  let poly: Vec2[];
  switch (shape) {
    case 'PSS_CIRCLE':
      poly = circleToPolygon({ x: 0, y: 0 }, size.x / 2, 0, ctx.arcTolerance ?? 2000);
      break;
    case 'PSS_OVAL':
      poly = ovalPolygon(size.x, size.y);
      break;
    case 'PSS_TRAPEZOID':
      poly = trapezoidPolygon(size.x, size.y, vec(e.trapezoidDelta));
      break;
    case 'PSS_ROUNDRECT':
      poly = roundRectPolygon(size.x, size.y, (e.cornerRoundingRatio ?? 0) * Math.min(size.x, size.y));
      break;
    case 'PSS_CHAMFEREDRECT': {
      const m = Math.min(size.x, size.y);
      poly = chamferedRectPolygon(size.x, size.y, (e.chamferRatio ?? 0) * m, e.chamferedCorners ?? {}, (e.cornerRoundingRatio ?? 0) * m);
      break;
    }
    case 'PSS_CUSTOM': {
      // anchor shape + custom primitives (relative to the pad position, unrotated)
      const anchor = enumName('PadStackShape', e.customAnchorShape);
      const base = anchor === 'PSS_RECTANGLE' ? rectPolygon(size.x, size.y) : circleToPolygon({ x: 0, y: 0 }, size.x / 2, 0, ctx.arcTolerance ?? 2000);
      // custom shapes are drawn separately by padPrims(); the anchor stands in for picking
      poly = base;
      break;
    }
    case 'PSS_RECTANGLE':
    default:
      poly = rectPolygon(size.x, size.y);
  }
  if (shape !== 'PSS_CUSTOM') padShapeCache.set(key, poly);
  return poly;
}

function hashPoints(pts: Vec2[], origin: Vec2): string {
  let h = 2166136261;
  for (const p of pts) {
    h = Math.imul(h ^ Math.round(p.x - origin.x), 16777619);
    h = Math.imul(h ^ Math.round(p.y - origin.y), 16777619);
  }
  return (h >>> 0).toString(36) + ':' + pts.length;
}

function padPrims(pad: Record<string, unknown>, ps: PadStackLike, layer: string, pos: Vec2, angle: number, ctx: BoardAdapterContext): { prims: Primitive[]; key: string } | undefined {
  const padId = kiid(pad.id as KiidLike);
  const copper = ctx.copperLayers ?? copperLayerList(2);
  const external = ctx.padPolygons?.(padId, layer);
  if (external && external.length) {
    const prims: Primitive[] = [];
    let key = 'ext';
    if (isPolyList(external)) {
      for (const poly of external) if (poly.length >= 3) prims.push({ kind: 'polygon', outline: poly, holes: [], fill: true, width: 0 });
      key += hashPoints(external.flat(), pos);
    } else {
      for (const p of external) {
        const { outline, holes } = polygonWithHoles(p, ctx.arcTolerance);
        if (outline.length >= 3) prims.push({ kind: 'polygon', outline, holes, fill: true, width: 0 });
        key += hashPoints(outline, pos);
        for (const h of holes) key += hashPoints(h, pos);
      }
    }
    return { prims, key };
  }
  // technical layers reuse the copper shape of the same side
  const copperLayer = isCopperLayer(layer) ? layer : isBackLayer(layer) ? 'BL_B_Cu' : 'BL_F_Cu';
  const entry = padStackEntryFor(ps, copperLayer, copper);
  if (!entry) return undefined;
  const shape = enumName('PadStackShape', entry.shape);
  const offset = vec(entry.offset);
  const local = padStackLayerPolygon(entry, ctx);
  const prims: Primitive[] = [];
  const world = transformPoly(local, angle, pos).map((p) => vAdd(p, vRotate(offset, angle)));
  prims.push({ kind: 'polygon', outline: world, holes: [], fill: true, width: 0 });
  let key = `${shape}|${nm(entry.size?.xNm)}|${nm(entry.size?.yNm)}|${entry.cornerRoundingRatio ?? 0}|${entry.chamferRatio ?? 0}|${JSON.stringify(entry.chamferedCorners ?? {})}|${offset.x}|${offset.y}|${nm(entry.trapezoidDelta?.xNm)}|${nm(entry.trapezoidDelta?.yNm)}|${angle}`;
  if (shape === 'PSS_CUSTOM') {
    for (const cs of entry.customShapes ?? []) {
      const sp = graphicShapeToPrims(cs.shape, ctx).map((pr) => transformPrim(pr, angle, pos, false));
      prims.push(...sp);
    }
    key += '|' + JSON.stringify(entry.customShapes ?? []);
  }
  return { prims, key };
}

function drillPrims(drill: DrillLike | undefined, pos: Vec2, angle: number): Primitive[] {
  if (!drill) return [];
  const d = vec(drill.diameter);
  if (d.x <= 0 && d.y <= 0) return [];
  const shape = enumName('DrillShape', drill.shape);
  if (shape === 'DS_OBLONG' && d.x !== d.y) {
    return [{ kind: 'polygon', outline: transformPoly(ovalPolygon(d.x, d.y || d.x), angle, pos), holes: [], fill: true, width: 0 }];
  }
  return [{ kind: 'circle', c: pos, r: (d.x || d.y) / 2, width: 0, fill: true }];
}

/** Rotate (about origin) then translate a primitive; optionally mirror Y first (back-side footprints). */
export function transformPrim(p: Primitive, angle: number, offset: Vec2, mirrorY: boolean): Primitive {
  const t = (v: Vec2): Vec2 => {
    const m = mirrorY ? { x: v.x, y: -v.y } : v;
    const r = vRotate(m, angle);
    return { x: r.x + offset.x, y: r.y + offset.y };
  };
  switch (p.kind) {
    case 'segment':
      return { ...p, a: t(p.a), b: t(p.b) };
    case 'arc':
      return { ...p, start: t(p.start), mid: t(p.mid), end: t(p.end) };
    case 'circle':
      return { ...p, c: t(p.c) };
    case 'polygon':
      return { ...p, outline: p.outline.map(t), holes: p.holes.map((h) => h.map(t)) };
    case 'bezier':
      return { ...p, p0: t(p.p0), p1: t(p.p1), p2: t(p.p2), p3: t(p.p3) };
    case 'text-shapes':
      return { ...p, polys: p.polys.map((poly) => poly.map(t)) };
    case 'image':
      return { ...p, c: t(p.c) };
    case 'text-glyphs':
      // rotation only moves the anchor / outline here; the schematic adapter has the
      // justification-aware version (transformTextGlyphs)
      return { ...p, pos: t(p.pos), outline: p.outline.map(t), angle: mirrorY ? -p.angle + angle : p.angle + angle, mirrored: mirrorY ? !p.mirrored : p.mirrored };
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Approximate text bbox outline (KiCad stroke font metrics) when no shapes are available. */
export function textFallbackPolygon(t: TextLike): Vec2[] {
  const pos = vec(t.position);
  const attr = t.attributes ?? {};
  const size = vec(attr.size);
  const h = size.y || 1_000_000;
  const w = size.x || h;
  const lines = (t.text ?? '').split('\n');
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  const stroke = dist(attr.strokeWidth) || h * 0.15;
  const textW = maxLen * w * 0.85 + stroke;
  const lineH = h * (attr.lineSpacing || 1) * 1.3;
  const textH = (lines.length - 1) * lineH + h + stroke;
  const ha = enumName('HorizontalAlignment', attr.horizontalAlignment);
  const va = enumName('VerticalAlignment', attr.verticalAlignment);
  const x0 = ha === 'HA_LEFT' ? 0 : ha === 'HA_RIGHT' ? -textW : -textW / 2;
  const y0 = va === 'VA_TOP' ? 0 : va === 'VA_BOTTOM' ? -textH : -textH / 2;
  const local: Vec2[] = [
    { x: x0, y: y0 },
    { x: x0 + textW, y: y0 },
    { x: x0 + textW, y: y0 + textH },
    { x: x0, y: y0 + textH },
  ];
  return transformPoly(local, deg(attr.angle), pos, !!attr.mirrored);
}

export function textShapesToPrims(shapes: TextShapesInput, ctx: BoardAdapterContext): Primitive[] {
  if (isPolyList(shapes)) return [{ kind: 'text-shapes', polys: shapes }];
  const out: Primitive[] = [];
  for (const s of shapes) out.push(...graphicShapeToPrims(s, ctx));
  return out;
}

// ---------------------------------------------------------------------------
// Pad number / net name labels (PCB_PAINTER::draw(PAD) / renderNetNameForSegment / draw(PCB_VIA))
// ---------------------------------------------------------------------------

/** PCB_RENDER_SETTINGS::MAX_FONT_SIZE */
const MAX_LABEL_FONT_NM = 10_000_000;
/** Xscale_for_stroked_font */
const LABEL_X_SCALE = 0.9;

const charCount = (s: string): number => Math.max(1, [...s].length);

function labelPrim(text: string, pos: Vec2, size: Vec2, thickness: number, angle: number, bold: boolean): Primitive | undefined {
  if (!text || size.y <= 0) return undefined;
  return textGlyphPrims(text, pos, { size, thickness, angle, halign: 'center', valign: 'center', bold })[0];
}

/**
 * Pad number (upper half) and net name (lower half) inside a pad, sized from the pad's
 * axis-aligned bounding box the way pcbnew does; the text turns 90° for tall pads.
 */
export function padLabelPrims(padNumber: string, netname: string, box: Box, round: boolean, opts: BoardLabelOptions): { number?: Primitive; net?: Primitive } {
  const number = opts.padNumbers ? padNumber : '';
  const net = opts.netNames ? netname : '';
  if ((!number && !net) || boxIsEmptyBox(box)) return {};
  const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  let padsize = { x: box.w, y: box.h };
  let size = padsize.y;
  let angle = 0;
  if (padsize.x < padsize.y * 0.95) {
    angle = 90;
    size = padsize.x;
    padsize = { x: padsize.y, y: padsize.x };
  }
  size = Math.min(size, MAX_LABEL_FONT_NM);
  let yNet = 0;
  let yNum = 0;
  if (number && net) {
    size = size / 2.5;
    yNet = size / 1.4;
    yNum = size / 1.7;
  }
  // local (0, y) offsets rotate with the text
  const at = (y: number): Vec2 => vAdd(centre, vRotate({ x: 0, y }, angle));
  const out: { number?: Primitive; net?: Primitive } = {};
  if (net) {
    let tsize = (1.5 * padsize.x) / Math.max(charCount(net) + 1, 5);
    tsize = Math.min(tsize, size) * 0.85;
    if (round) tsize *= 0.9;
    out.net = labelPrim(net, at(Math.min(tsize * 1.4, yNet)), { x: tsize * LABEL_X_SCALE, y: tsize }, (tsize * LABEL_X_SCALE) / 6, angle, true);
  }
  if (number) {
    let tsize = (1.5 * padsize.x) / Math.max(charCount(number), 3);
    tsize = Math.min(tsize, size) * 0.85;
    out.number = labelPrim(number, at(-yNum), { x: tsize * LABEL_X_SCALE, y: tsize }, (tsize * LABEL_X_SCALE) / 6, angle, true);
  }
  return out;
}

const boxIsEmptyBox = (b: Box): boolean => !(b.w > 0 && b.h > 0);

/** Net name along a track segment (one name at the midpoint; pcbnew repeats it on very long tracks). */
export function trackLabelPrim(netname: string, a: Vec2, b: Vec2, width: number): Primitive | undefined {
  if (!netname || width <= 0) return undefined;
  const len = vDist(a, b);
  if (len < width * charCount(netname)) return undefined;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let angle = 0;
  if (dy === 0) angle = 0;
  else if (dx === 0) angle = 90;
  else {
    angle = (-Math.atan2(dy, dx) * 180) / Math.PI; // -EDA_ANGLE(segV)
    while (angle > 90) angle -= 180; // Normalize90
    while (angle <= -90) angle += 180;
  }
  const textSize = width;
  return labelPrim(netname, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { x: textSize * 0.55, y: textSize * 0.55 }, textSize / 12, angle, false);
}

/** Net name inside a via (layer ids are not drawn). */
export function viaLabelPrim(netname: string, pos: Vec2, diameter: number): Primitive | undefined {
  if (!netname || diameter <= 0) return undefined;
  const size = Math.min(diameter, MAX_LABEL_FONT_NM);
  let tsize = (1.5 * size) / Math.max(charCount(netname), 3);
  tsize = Math.min(tsize, size) * 0.75;
  return labelPrim(netname, pos, { x: tsize, y: tsize }, tsize / 6, 0, false);
}

function textPrims(textId: string, t: TextLike | undefined, ctx: BoardAdapterContext, knockout = false): { prims: Primitive[]; cacheKey?: string } {
  if (!t) return { prims: [] };
  const shapes = ctx.textShapes?.(textId);
  if (shapes && shapes.length) return { prims: textShapesToPrims(shapes, ctx) };
  const poly = textFallbackPolygon(t);
  const attr = t.attributes ?? {};
  const cacheKey = `text|${t.text ?? ''}|${nm(attr.size?.xNm)}|${nm(attr.size?.yNm)}|${deg(attr.angle)}|${attr.horizontalAlignment}|${attr.verticalAlignment}|${!!attr.mirrored}|${knockout}`;
  return { prims: [{ kind: 'polygon', outline: poly, holes: [], fill: knockout, width: 0 }], cacheKey };
}

/**
 * The four corners of a text box in drawing order. The box itself stays axis-aligned and the
 * rotation lives in the text angle, so the corners turn about the box centre -- the layout
 * `PCB_TEXTBOX` / `PCB_TABLECELL` use when they draw (and `layOutTextBox` in KiCad's
 * `api_handler_common.cpp`, which places the GetTextAsShapes glyphs against these corners).
 */
export function textBoxCorners(tb: TextBoxLike): Vec2[] {
  const a = vec(tb.topLeft);
  const b = vec(tb.bottomRight);
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const pts: Vec2[] = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  const angle = deg(tb.attributes?.angle);
  if (!angle) return pts;
  const c = { x: (left + right) / 2, y: (top + bottom) / 2 };
  return pts.map((p) => vRotate(p, angle, c));
}

/**
 * GetTextAsShapes appends the box border to a `textbox` request as four segments along the
 * rotated corners, whatever `border_enabled` says and without the border's line style. Drop
 * them and let the caller draw the border itself from `border_stroke`.
 */
export function stripTextBoxBorder(shapes: TextShapesInput, corners: Vec2[]): TextShapesInput {
  if (isPolyList(shapes) || shapes.length < corners.length) return shapes;
  const tail = shapes.slice(shapes.length - corners.length) as GraphicShapeLike[];
  const near = (u: Vec2, v: Vec2) => Math.abs(u.x - v.x) <= 1000 && Math.abs(u.y - v.y) <= 1000;
  const isEdge = (s: GraphicShapeLike, i: number) => {
    const g = oneof<Record<string, unknown>>(s as Record<string, unknown>, 'geometry', ['segment']);
    const seg = (g?.case === 'segment' ? g.value : s.segment) as NonNullable<GraphicShapeLike['segment']> | undefined;
    if (!seg) return false;
    const p = vec(seg.start);
    const q = vec(seg.end);
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    return (near(p, a) && near(q, b)) || (near(p, b) && near(q, a));
  };
  if (!tail.every(isEdge)) return shapes;
  return shapes.slice(0, shapes.length - corners.length) as GraphicShapeLike[];
}

/**
 * A text box: its border (from `BoardTextBox.border_stroke`) and its text. `drawBorder` is
 * false for table cells, which plot their text only -- `PCB_TABLE` draws every line
 * (`BRDITEMS_PLOTTER::Plot`, case `PCB_TABLE_T`), and a cell's own `border_enabled` is true.
 */
function textBoxPrims(id: string, tb: TextBoxLike | undefined, ctx: BoardAdapterContext, borderStroke?: StrokeAttributesLike, drawBorder = true): Primitive[] {
  if (!tb) return [];
  const corners = textBoxCorners(tb);
  const shapes = ctx.textShapes?.(id);
  const glyphs = shapes?.length ? stripTextBoxBorder(shapes, corners) : undefined;
  const prims: Primitive[] = [];
  if (drawBorder && tb.borderEnabled) {
    const width = dist(borderStroke?.width) || dist(tb.attributes?.strokeWidth);
    prims.push(...strokedPolyline(corners, width, dashPattern(enumName('StrokeLineStyle', borderStroke?.style), width), true));
  } else if (drawBorder && !glyphs?.length) {
    // No server glyphs: the box outline stands in for the text so the item still reads
    prims.push({ kind: 'polygon', outline: corners, holes: [], fill: false, width: 0 });
  }
  if (glyphs?.length) prims.push(...textShapesToPrims(glyphs, ctx));
  return prims;
}

// ---------------------------------------------------------------------------
// Item converters
// ---------------------------------------------------------------------------

interface ConvertOpts {
  owner: string;
  /** transform applied to relative footprint children */
  xf?: { angle: number; offset: Vec2; mirrorY: boolean; flipLayers: boolean };
}

function finish(id: string, layer: string, prims: Primitive[], o: ConvertOpts, extra: Partial<RenderItem> = {}): RenderItem {
  let ps = prims;
  let l = layer;
  if (o.xf) {
    ps = prims.map((p) => transformPrim(p, o.xf!.angle, o.xf!.offset, o.xf!.mirrorY));
    if (o.xf.flipLayers) l = flipLayer(layer);
    if (extra.anchor) {
      const a = o.xf.mirrorY ? { x: extra.anchor.x, y: -extra.anchor.y } : extra.anchor;
      extra = { ...extra, anchor: vAdd(vRotate(a, o.xf.angle), o.xf.offset) };
    }
    if (extra.cacheKey) extra = { ...extra, cacheKey: `${extra.cacheKey}|xf${o.xf.angle}|${o.xf.mirrorY}` };
  }
  return { id, layer: l, prims: ps, bbox: boxOfPrimitives(ps), owner: o.owner, ref: id, ...extra };
}

function netName(n: NetLike | undefined): string | undefined {
  const name = n?.name;
  return name ? name : undefined;
}

function convertTrack(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext = {}): RenderItem[] {
  const a = vec(p.start as Vector2Like);
  const b = vec(p.end as Vector2Like);
  const width = dist(p.width as DistanceLike);
  const net = netName(p.net as NetLike);
  const out = [finish(id, boardLayerName(p.layer as number), [{ kind: 'segment', a, b, width }], o, { net })];
  if (net && ctx.labels?.netNames) {
    const label = trackLabelPrim(net, a, b, width);
    if (label) out.push(finish(`${id}@label:net`, PSEUDO_LAYERS.trackNetNames, [label], o, { net, ref: id, pickable: false }));
  }
  return out;
}

function convertArc(p: Record<string, unknown>, id: string, o: ConvertOpts): RenderItem[] {
  const prim: Primitive = { kind: 'arc', start: vec(p.start as Vector2Like), mid: vec(p.mid as Vector2Like), end: vec(p.end as Vector2Like), width: dist(p.width as DistanceLike) };
  return [finish(id, boardLayerName(p.layer as number), [prim], o, { net: netName(p.net as NetLike) })];
}

function viaLayers(ps: PadStackLike, copper: readonly string[]): string[] {
  const listed = (ps.layers ?? []).map(boardLayerName).filter(isCopperLayer);
  if (listed.length) return listed.filter((l) => copper.includes(l) || !copper.length);
  const start = boardLayerName(ps.drill?.startLayer);
  const end = boardLayerName(ps.drill?.endLayer);
  const i0 = copper.indexOf(start);
  const i1 = copper.indexOf(end);
  if (i0 >= 0 && i1 >= 0) return copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1);
  return [...copper];
}

function convertVia(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const ps = (p.padStack ?? {}) as PadStackLike;
  const pos = vec(p.position as Vector2Like);
  const copper = ctx.copperLayers ?? copperLayerList(2);
  const net = netName(p.net as NetLike);
  const out: RenderItem[] = [];
  for (const layer of viaLayers(ps, copper)) {
    const entry = padStackEntryFor(ps, layer, copper);
    const size = vec(entry?.size);
    const r = (size.x || size.y) / 2;
    if (r <= 0) continue;
    const shape = enumName('PadStackShape', entry?.shape);
    const prims: Primitive[] =
      shape === 'PSS_CIRCLE' || shape === 'PSS_UNKNOWN' || !entry
        ? [{ kind: 'circle', c: pos, r, width: 0, fill: true }]
        : [{ kind: 'polygon', outline: transformPoly(padStackLayerPolygon(entry, ctx), deg(ps.angle), pos), holes: [], fill: true, width: 0 }];
    out.push(finish(`${id}@${layer}`, layer, prims, o, { net, ref: id, cacheKey: `via|${shape}|${size.x}|${size.y}|${deg(ps.angle)}`, anchor: pos }));
  }
  const hole = drillPrims(ps.drill, pos, deg(ps.angle));
  if (hole.length) out.push(finish(`${id}@hole`, PSEUDO_LAYERS.viaHole, hole, o, { ref: id, pickable: false, cacheKey: `viahole|${nm(ps.drill?.diameter?.xNm)}|${nm(ps.drill?.diameter?.yNm)}`, anchor: pos }));
  if (net && ctx.labels?.netNames && out.length) {
    const size = vec(padStackEntryFor(ps, viaLayers(ps, copper)[0] ?? 'BL_F_Cu', copper)?.size);
    const label = viaLabelPrim(net, pos, size.x || size.y);
    if (label) out.push(finish(`${id}@label:net`, PSEUDO_LAYERS.viaNetNames, [label], o, { net, ref: id, pickable: false }));
  }
  return out;
}

function convertPad(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const ps = (p.padStack ?? {}) as PadStackLike;
  const pos = vec(p.position as Vector2Like);
  const angle = deg(ps.angle);
  const net = netName(p.net as NetLike);
  const type = enumName('PadType', p.type as number);
  const copper = ctx.copperLayers ?? copperLayerList(2);
  let layers = (ps.layers ?? []).map(boardLayerName).filter((l) => l !== 'BL_UNKNOWN');
  if (!layers.length) layers = type === 'PT_SMD' ? ['BL_F_Cu', 'BL_F_Mask', 'BL_F_Paste'] : [...copper, 'BL_F_Mask', 'BL_B_Mask'];
  // expand "all copper" for through-hole pads when the padstack lists only F/B
  if (type === 'PT_PTH' || type === 'PT_NPTH') {
    for (const c of copper) if (!layers.includes(c) && (layers.includes('BL_F_Cu') || layers.includes('BL_B_Cu'))) layers.push(c);
  }
  const out: RenderItem[] = [];
  let labelBox: Box | undefined;
  let labelRound = false;
  for (const layer of layers) {
    const r = padPrims(p, ps, layer, pos, angle, ctx);
    if (!r || !r.prims.length) continue;
    out.push(finish(`${id}@${layer}`, layer, r.prims, o, { net, ref: id, cacheKey: `pad|${layer}|${r.key}`, anchor: pos }));
    if (!labelBox && isCopperLayer(layer)) {
      labelBox = boxOfPrimitives(r.prims);
      const shape = enumName('PadStackShape', padStackEntryFor(ps, layer, copper)?.shape);
      labelRound = shape === 'PSS_CIRCLE' || shape === 'PSS_OVAL';
    }
  }
  const hole = drillPrims(ps.drill, pos, angle);
  if (hole.length) {
    const layer = type === 'PT_NPTH' ? PSEUDO_LAYERS.nonPlatedHole : PSEUDO_LAYERS.padPlatedHole;
    out.push(finish(`${id}@hole`, layer, hole, o, { ref: id, pickable: false, cacheKey: `hole|${nm(ps.drill?.diameter?.xNm)}|${nm(ps.drill?.diameter?.yNm)}|${angle}`, anchor: pos }));
  }
  if (ctx.labels && labelBox) {
    const labels = padLabelPrims(String(p.number ?? ''), net ?? '', labelBox, labelRound, ctx.labels);
    if (labels.number) out.push(finish(`${id}@label:number`, PSEUDO_LAYERS.padNumbers, [labels.number], o, { net, ref: id, pickable: false, color: PSEUDO_LAYERS.padNetNames }));
    if (labels.net) out.push(finish(`${id}@label:net`, PSEUDO_LAYERS.padNetNames, [labels.net], o, { net, ref: id, pickable: false }));
  }
  return out;
}

function convertShape(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const prims = graphicShapeToPrims(p.shape as GraphicShapeLike, ctx);
  if (!prims.length) return [];
  return [finish(id, boardLayerName(p.layer as number), prims, o, { net: netName(p.net as NetLike) })];
}

function convertText(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext, textId = id): RenderItem[] {
  const t = p.text as TextLike | undefined;
  if (!t || t.attributes?.visible === false) return [];
  const { prims, cacheKey } = textPrims(textId, t, ctx, !!p.knockout);
  if (!prims.length) return [];
  return [finish(id, boardLayerName(p.layer as number), prims, o, cacheKey ? { cacheKey, anchor: vec(t.position) } : {})];
}

function convertTextBox(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const prims = textBoxPrims(id, p.textbox as TextBoxLike, ctx, p.borderStroke as StrokeAttributesLike | undefined);
  if (!prims.length) return [];
  return [finish(id, boardLayerName(p.layer as number), prims, o)];
}

function convertField(p: Record<string, unknown>, fallbackId: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const f = p as FieldLike;
  if (f.visible === false || !f.text) return [];
  const bt = f.text as unknown as Record<string, unknown>;
  const id = kiid(f.text.id) || `${fallbackId}:${f.name ?? 'field'}`;
  return convertText(bt, id, o, ctx);
}

function convertZone(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const type = enumName('ZoneType', p.type as number);
  const layers = ((p.layers as Array<number | string>) ?? []).map(boardLayerName);
  const settings = oneof<Record<string, unknown>>(p, 'settings', ['copperSettings', 'ruleAreaSettings']);
  const net = settings?.case === 'copperSettings' ? netName((settings.value as { net?: NetLike }).net) : undefined;
  const arcTol = ctx.arcTolerance ?? 5000;
  const outline = polySetToPrims(p.outline as PolySetLike, false, 0, arcTol);
  const border = (p.border ?? {}) as { style?: number | string; pitch?: DistanceLike };
  const pitch = dist(border.pitch) || 500_000;
  const out: RenderItem[] = [];
  const filled = p.filledPolygons as Array<{ layer?: number | string; shapes?: PolySetLike }> | undefined;
  const filledLayers = new Set<string>();
  for (const fp of filled ?? []) {
    const layer = boardLayerName(fp.layer);
    const prims = polySetToPrims(fp.shapes, true, 0, arcTol, true);
    if (!prims.length) continue;
    filledLayers.add(layer);
    out.push(finish(`${id}@${layer}`, layer, prims, o, { net, ref: id }));
  }
  for (const layer of layers) {
    const prims: Primitive[] = [...outline];
    if (type === 'ZT_RULE_AREA') {
      for (const poly of outline) {
        if (poly.kind !== 'polygon') continue;
        for (const [a, b] of hatchPolygon(poly.outline, poly.holes, pitch * 4, 45)) prims.push({ kind: 'segment', a, b, width: 0 });
      }
    }
    if (!prims.length) continue;
    const suffix = filledLayers.has(layer) ? `@${layer}:outline` : `@${layer}`;
    out.push(finish(`${id}${suffix}`, layer, prims, o, { net, ref: id }));
  }
  return out;
}

function convertFootprint(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const angle = deg(p.orientation as AngleLike);
  const layer = boardLayerName(p.layer as number);
  const back = layer === 'BL_B_Cu' || isBackLayer(layer);
  const absolute = ctx.footprintChildrenAbsolute ?? true;
  const def = (p.definition ?? {}) as Record<string, unknown>;
  const childOpts: ConvertOpts = absolute ? { owner: id } : { owner: id, xf: { angle, offset: pos, mirrorY: back, flipLayers: back } };
  const out: RenderItem[] = [];
  for (const raw of (def.items as unknown[]) ?? []) {
    const child = itemTypeOf(raw);
    if (!child) continue;
    const cid = kiid(child.proto.id as KiidLike) || `${id}:${out.length}`;
    out.push(...convert(child.type, child.proto, cid, childOpts, ctx));
  }
  for (const key of ['referenceField', 'valueField', 'datasheetField', 'descriptionField'] as const) {
    const f = (p[key] ?? def[key]) as Record<string, unknown> | undefined;
    if (f) out.push(...convertField(f, `${id}:${key}`, childOpts, ctx));
  }
  // anchor marker
  const s = 250_000;
  out.push(
    finish(
      `${id}@anchor`,
      PSEUDO_LAYERS.anchor,
      [
        { kind: 'segment', a: { x: pos.x - s, y: pos.y }, b: { x: pos.x + s, y: pos.y }, width: 0 },
        { kind: 'segment', a: { x: pos.x, y: pos.y - s }, b: { x: pos.x, y: pos.y + s }, width: 0 },
      ],
      { owner: id },
      { ref: id, pickable: false },
    ),
  );
  // footprint body: no geometry, picked by bbox (after its own children, which are smaller)
  let bbox = EMPTY_BOX;
  for (const it of out) if (it.pickable !== false) bbox = boxUnion(bbox, it.bbox);
  if (bbox === EMPTY_BOX) bbox = boxFromPoints([pos], s);
  out.push({ id, layer, prims: [], bbox, owner: id });
  return out;
}

const ARROW_ANGLE = 27.5;

function arrow(tip: Vec2, dir: Vec2, len: number, width: number): Primitive[] {
  const l = vDist(dir, { x: 0, y: 0 }) || 1;
  const d = { x: (dir.x / l) * len, y: (dir.y / l) * len };
  return [
    { kind: 'segment', a: tip, b: vAdd(tip, vRotate(d, ARROW_ANGLE)), width },
    { kind: 'segment', a: tip, b: vAdd(tip, vRotate(d, -ARROW_ANGLE)), width },
  ];
}

function convertDimension(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const width = dist(p.lineThickness as DistanceLike) || 150_000;
  const arrowLen = dist(p.arrowLength as DistanceLike) || 1_270_000;
  const extOffset = dist(p.extensionOffset as DistanceLike);
  const outward = enumName('DimensionArrowDirection', p.arrowDirection as number) === 'DAD_OUTWARD';
  const style = oneof<Record<string, unknown>>(p, 'dimensionStyle', ['aligned', 'orthogonal', 'radial', 'leader', 'center']);
  const prims: Primitive[] = [];
  const seg = (a: Vec2, b: Vec2): Primitive => ({ kind: 'segment', a, b, width });
  if (style) {
    const v = style.value as Record<string, unknown>;
    switch (style.case) {
      case 'aligned':
      case 'orthogonal': {
        const start = vec(v.start as Vector2Like);
        const end = vec(v.end as Vector2Like);
        const height = dist(v.height as DistanceLike);
        const extH = dist(v.extensionHeight as DistanceLike);
        let a: Vec2;
        let b: Vec2;
        let n: Vec2; // unit normal from the measured points towards the crossbar
        if (style.case === 'orthogonal') {
          const xAxis = enumName('AxisAlignment', v.alignment as number) !== 'AA_Y_AXIS';
          n = xAxis ? { x: 0, y: Math.sign(height) || 1 } : { x: Math.sign(height) || 1, y: 0 };
          a = xAxis ? { x: start.x, y: start.y + height } : { x: start.x + height, y: start.y };
          b = xAxis ? { x: end.x, y: start.y + height } : { x: start.x + height, y: end.y };
        } else {
          const d = vSub(end, start);
          const l = vDist(start, end) || 1;
          n = { x: -d.y / l, y: d.x / l }; // PCB_DIM_ALIGNED::updateGeometry: extension = (-d.y, d.x) for h > 0
          a = vAdd(start, { x: n.x * height, y: n.y * height });
          b = vAdd(end, { x: n.x * height, y: n.y * height });
          n = { x: n.x * Math.sign(height || 1), y: n.y * Math.sign(height || 1) };
        }
        prims.push(seg(a, b));
        // extension lines
        const e0 = vAdd(start, { x: n.x * extOffset, y: n.y * extOffset });
        const e1 = vAdd(end, { x: n.x * extOffset, y: n.y * extOffset });
        prims.push(seg(e0, vAdd(a, { x: n.x * extH, y: n.y * extH })), seg(e1, vAdd(b, { x: n.x * extH, y: n.y * extH })));
        const dir = vSub(b, a);
        prims.push(...arrow(a, outward ? { x: -dir.x, y: -dir.y } : dir, arrowLen, width));
        prims.push(...arrow(b, outward ? dir : { x: -dir.x, y: -dir.y }, arrowLen, width));
        break;
      }
      case 'radial': {
        const c = vec(v.center as Vector2Like);
        const rp = vec(v.radiusPoint as Vector2Like);
        const leader = dist(v.leaderLength as DistanceLike);
        const d = vSub(rp, c);
        const l = vDist(rp, c) || 1;
        const endPt = vAdd(rp, { x: (d.x / l) * leader, y: (d.y / l) * leader });
        prims.push(seg(rp, endPt), ...arrow(rp, outward ? d : { x: -d.x, y: -d.y }, arrowLen, width));
        const s = arrowLen / 2;
        prims.push(seg({ x: c.x - s, y: c.y }, { x: c.x + s, y: c.y }), seg({ x: c.x, y: c.y - s }, { x: c.x, y: c.y + s }));
        break;
      }
      case 'leader': {
        const start = vec(v.start as Vector2Like);
        const end = vec(v.end as Vector2Like);
        prims.push(seg(start, end), ...arrow(start, vSub(end, start), arrowLen, width));
        const border = enumName('DimensionTextBorderStyle', v.borderStyle as number);
        const t = p.text as TextLike | undefined;
        if (t && border !== 'DTBS_NONE' && border !== 'DTBS_UNKNOWN') {
          const poly = textFallbackPolygon(t);
          if (border === 'DTBS_CIRCLE') {
            const b = boxFromPoints(poly);
            prims.push({ kind: 'circle', c: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, r: Math.hypot(b.w, b.h) / 2, width, fill: false });
          } else prims.push({ kind: 'polygon', outline: poly, holes: [], fill: false, width });
        }
        break;
      }
      case 'center': {
        const c = vec(v.center as Vector2Like);
        const e = vec(v.end as Vector2Like);
        const d = vSub(e, c);
        prims.push(seg(vSub(c, d), vAdd(c, d)), seg(vSub(c, { x: -d.y, y: d.x }), vAdd(c, { x: -d.y, y: d.x })));
        break;
      }
    }
  }
  const t = p.text as TextLike | undefined;
  if (t && style?.case !== 'center') prims.push(...textPrims(id, t, ctx).prims);
  if (!prims.length) return [];
  return [finish(id, boardLayerName(p.layer as number), prims, o)];
}

export function bytesOf(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string' && typeof atob === 'function') {
    try {
      const bin = atob(v);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Image dimensions and mime from PNG / JPEG / GIF headers. */
export function imageInfo(bytes: Uint8Array): { w: number; h: number; mime: string } | undefined {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20), mime: 'image/png' };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7), mime: 'image/jpeg' };
      }
      i += 2 + dv.getUint16(i + 2);
    }
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: bytes[6]! | (bytes[7]! << 8), h: bytes[8]! | (bytes[9]! << 8), mime: 'image/gif' };
  }
  return undefined;
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function convertImage(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const scale = (p.imageScale as { value?: number } | undefined)?.value || 1;
  const pxNm = ctx.imagePixelNm ?? 25.4e6 / 300;
  const bytes = bytesOf(p.imageData);
  const info = bytes ? imageInfo(bytes) : undefined;
  const layer = boardLayerName(p.layer as number);
  if (!bytes || !info) {
    const s = 5_000_000;
    return [finish(id, layer, [{ kind: 'polygon', outline: transformPoly(rectPolygon(s, s), 0, pos), holes: [], fill: false, width: 0 }], o)];
  }
  const w = info.w * pxNm * scale;
  const h = info.h * pxNm * scale;
  const dataUrl = `data:${info.mime};base64,${toBase64(bytes)}`;
  return [finish(id, layer, [{ kind: 'image', c: pos, w, h, dataUrl }], o)];
}

function convertGroup(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  let bbox = EMPTY_BOX;
  for (const m of (p.items as KiidLike[]) ?? []) {
    const b = ctx.itemBBox?.(kiid(m));
    if (b) bbox = boxUnion(bbox, b);
  }
  if (bbox === EMPTY_BOX) return [];
  return [{ id, layer: PSEUDO_LAYERS.auxItems, prims: [], bbox, owner: o.owner }];
}

function convertBarcode(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext = {}): RenderItem[] {
  // Since 11.0 the server packs the encoded symbol -- the dark modules, the human-readable text
  // and the knockout margin -- as filled polygons in board coordinates, already sized and
  // rotated: the same geometry BRDITEMS_PLOTTER::PlotBarCode draws (PCB_BARCODE::Serialize).
  const encoded = polySetToPrims(p.shapes as PolySetLike | undefined, true, 0, ctx.arcTolerance ?? 5000);
  if (encoded.length) return [finish(id, boardLayerName(p.layer as number), encoded, o)];
  // Older servers send only the payload and the box: draw the frame and a placeholder pattern.
  const pos = vec(p.position as Vector2Like);
  const w = dist(p.width as DistanceLike) || 10_000_000;
  const h = dist(p.height as DistanceLike) || 10_000_000;
  const angle = deg(p.orientation as AngleLike);
  const prims: Primitive[] = [{ kind: 'polygon', outline: transformPoly(rectPolygon(w, h), angle, pos), holes: [], fill: false, width: 0 }];
  // a few placeholder bars so the item reads as a barcode
  const bars = 9;
  for (let i = 0; i < bars; i++) {
    const x = -w / 2 + ((i + 0.5) * w) / bars;
    const bw = (w / bars) * (i % 3 === 0 ? 0.6 : 0.3);
    prims.push({ kind: 'polygon', outline: transformPoly(rectPolygon(bw, h * 0.8).map((q) => ({ x: q.x + x, y: q.y })), angle, pos), holes: [], fill: true, width: 0 });
  }
  return [finish(id, boardLayerName(p.layer as number), prims, o)];
}

function convertPoint(p: Record<string, unknown>, id: string, o: ConvertOpts): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const s = (dist(p.size as DistanceLike) || 500_000) / 2;
  return [
    finish(
      id,
      PSEUDO_LAYERS.points,
      [
        { kind: 'segment', a: { x: pos.x - s, y: pos.y }, b: { x: pos.x + s, y: pos.y }, width: 0 },
        { kind: 'segment', a: { x: pos.x, y: pos.y - s }, b: { x: pos.x, y: pos.y + s }, width: 0 },
        { kind: 'circle', c: pos, r: s / 2, width: 0, fill: false },
      ],
      o,
    ),
  ];
}

function convertGridItem(p: Record<string, unknown>, id: string, o: ConvertOpts): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const angle = deg(p.orientation as AngleLike);
  const g = oneof<Record<string, unknown>>(p, 'geometry', ['cartesian', 'polar']);
  const prims: Primitive[] = [];
  if (g?.case === 'cartesian') {
    const ext = vec(g.value.extent as Vector2Like);
    const sp = vec(g.value.spacing as Vector2Like);
    prims.push({ kind: 'polygon', outline: transformPoly(rectPolygon(ext.x, ext.y), angle, pos), holes: [], fill: false, width: 0 });
    const nx = sp.x > 0 ? Math.min(200, Math.floor(ext.x / sp.x)) : 0;
    const ny = sp.y > 0 ? Math.min(200, Math.floor(ext.y / sp.y)) : 0;
    for (let i = 1; i < nx; i++) {
      const x = -ext.x / 2 + i * sp.x;
      const [a, b] = transformPoly([{ x, y: -ext.y / 2 }, { x, y: ext.y / 2 }], angle, pos) as [Vec2, Vec2];
      prims.push({ kind: 'segment', a, b, width: 0 });
    }
    for (let j = 1; j < ny; j++) {
      const y = -ext.y / 2 + j * sp.y;
      const [a, b] = transformPoly([{ x: -ext.x / 2, y }, { x: ext.x / 2, y }], angle, pos) as [Vec2, Vec2];
      prims.push({ kind: 'segment', a, b, width: 0 });
    }
  } else if (g?.case === 'polar') {
    const rExt = dist(g.value.radiusExtent as DistanceLike);
    const rSp = dist(g.value.radiusSpacing as DistanceLike);
    const phiExt = deg(g.value.phiExtent as AngleLike) || 360;
    const phiSp = deg(g.value.phiSpacing as AngleLike);
    const nr = rSp > 0 ? Math.min(100, Math.floor(rExt / rSp)) : 0;
    for (let i = 1; i <= nr; i++) prims.push({ kind: 'circle', c: pos, r: i * rSp, width: 0, fill: false });
    const na = phiSp > 0 ? Math.min(360, Math.floor(phiExt / phiSp)) : 0;
    for (let i = 0; i <= na; i++) {
      const a = angle + i * phiSp;
      prims.push({ kind: 'segment', a: pos, b: vAdd(pos, vRotate({ x: rExt, y: 0 }, a)), width: 0 });
    }
  }
  if (!prims.length) return [];
  return [finish(id, PSEUDO_LAYERS.gridItems, prims, o)];
}

type TableCellLike = { textBox?: Record<string, unknown>; columnSpan?: number; rowSpan?: number };

const strokeEnabled = (m: number | string | undefined): boolean => enumName('TableStrokeMode', m) === 'TSM_ENABLED';

function strokeSeg(a: Vec2, b: Vec2, s: StrokeAttributesLike | undefined): Primitive[] {
  const width = dist(s?.width);
  return strokedPolyline([a, b], width, dashPattern(enumName('StrokeLineStyle', s?.style), width), false);
}

/** `PCB_TABLE::DrawBorders`: header / column / row separators, then the outer frame. */
function tableBorderPrims(p: Record<string, unknown>, cells: TableCellLike[], corners: (Vec2[] | undefined)[]): Primitive[] {
  const cols = Math.max(1, Number(p.columnCount) || 0);
  const rows = Math.floor(cells.length / cols);
  if (rows < 1) return [];
  const border = p.borderStroke as StrokeAttributesLike | undefined;
  const seps = p.separatorsStroke as StrokeAttributesLike | undefined;
  const header = strokeEnabled(p.headerSeparator as number | string | undefined);
  const at = (row: number, col: number) => corners[row * cols + col];
  const span = (c: TableCellLike | undefined, k: 'columnSpan' | 'rowSpan') => Number(c?.[k] ?? 1);
  const out: Primitive[] = [];
  const rowStroke = (row: number, on: boolean) => (row === 0 && header ? border : on ? seps : undefined);
  for (let col = 0; col < cols - 1; col++) {
    for (let row = 0; row < rows; row++) {
      const s = rowStroke(row, strokeEnabled(p.columnSeparators as number | string | undefined));
      const cell = cells[row * cols + col];
      const cs = span(cell, 'columnSpan');
      if (!s || cs === 0 || col + cs === cols) continue;
      const c = at(row, col);
      if (c) out.push(...strokeSeg(c[1]!, c[2]!, s));
    }
  }
  for (let row = 0; row < rows - 1; row++) {
    const s = rowStroke(row, strokeEnabled(p.rowSeparators as number | string | undefined));
    if (!s) continue;
    for (let col = 0; col < cols; col++) {
      const cell = cells[row * cols + col];
      const rs = span(cell, 'rowSpan');
      if (rs === 0 || row + rs === rows) continue;
      const c = at(row, col);
      if (c) out.push(...strokeSeg(c[2]!, c[3]!, s));
    }
  }
  const tl = at(0, 0);
  const tr = at(0, cols - 1);
  const bl = at(rows - 1, 0);
  const br = at(rows - 1, cols - 1);
  if (strokeEnabled(p.externalBorder as number | string | undefined) && tl && tr && bl && br) {
    out.push(...strokeSeg(tl[0]!, tr[1]!, border), ...strokeSeg(tr[1]!, br[2]!, border), ...strokeSeg(br[2]!, bl[3]!, border), ...strokeSeg(bl[3]!, tl[0]!, border));
  }
  return out;
}

function convertTable(p: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  const layer = boardLayerName(p.layer as number);
  const cells = (p.cells as TableCellLike[]) ?? [];
  const prims: Primitive[] = [];
  const corners: (Vec2[] | undefined)[] = [];
  cells.forEach((cell, i) => {
    const tb = cell.textBox;
    if (!tb) {
      corners.push(undefined);
      return;
    }
    const box = tb.textbox as TextBoxLike | undefined;
    corners.push(box ? textBoxCorners(box) : undefined);
    const cid = kiid(tb.id as KiidLike) || `${id}:cell${i}`;
    prims.push(...textBoxPrims(cid, box, ctx, undefined, false));
  });
  prims.push(...tableBorderPrims(p, cells, corners));
  if (!prims.length) return [];
  return [finish(id, layer, prims, o)];
}

function convert(type: string, proto: Record<string, unknown>, id: string, o: ConvertOpts, ctx: BoardAdapterContext): RenderItem[] {
  switch (type) {
    case 'KOT_PCB_TRACE':
      return convertTrack(proto, id, o, ctx);
    case 'KOT_PCB_ARC':
      return convertArc(proto, id, o);
    case 'KOT_PCB_VIA':
      return convertVia(proto, id, o, ctx);
    case 'KOT_PCB_PAD':
      return convertPad(proto, id, o, ctx);
    case 'KOT_PCB_SHAPE':
      return convertShape(proto, id, o, ctx);
    case 'KOT_PCB_TEXT':
      return convertText(proto, id, o, ctx);
    case 'KOT_PCB_TEXTBOX':
      return convertTextBox(proto, id, o, ctx);
    case 'KOT_PCB_FIELD':
      return convertField(proto, id, o, ctx);
    case 'KOT_PCB_ZONE':
      return convertZone(proto, id, o, ctx);
    case 'KOT_PCB_FOOTPRINT':
      return convertFootprint(proto, id, o, ctx);
    case 'KOT_PCB_DIMENSION':
      return convertDimension(proto, id, o, ctx);
    case 'KOT_PCB_REFERENCE_IMAGE':
      return convertImage(proto, id, o, ctx);
    case 'KOT_PCB_GROUP':
      return convertGroup(proto, id, o, ctx);
    case 'KOT_PCB_BARCODE':
      return convertBarcode(proto, id, o, ctx);
    case 'KOT_PCB_POINT':
      return convertPoint(proto, id, o);
    case 'KOT_PCB_GRIDITEM':
      return convertGridItem(proto, id, o);
    case 'KOT_PCB_TABLE':
      return convertTable(proto, id, o, ctx);
    default:
      return []; // KOT_PCB_MARKER, GENERATOR, CONSTRAINT, TABLECELL, 3D models, unknown
  }
}

/**
 * Convert one store item (or a plain `{ id, type, proto }`) into render items.
 * `item.type` is the KOT_* name; when absent it is derived from `proto.$typeName`.
 */
export function boardItemToRenderItems(item: StoredItemLike, ctx: BoardAdapterContext = {}): RenderItem[] {
  const proto = (item.proto ?? {}) as Record<string, unknown>;
  const type = item.type || itemTypeOf(proto)?.type || '';
  const id = item.id || kiid(proto.id as KiidLike);
  return convert(type, proto, id, { owner: id }, ctx);
}

/** KIID of a render item / pick result id (strips the `@layer` / `@hole` suffixes). */
export function renderIdToKiid(id: string): string {
  const i = id.indexOf('@');
  return i < 0 ? id : id.slice(0, i);
}
