/**
 * Schematic adapter: kiapi.schematic.types messages (protobuf-es shapes: camelCase fields,
 * int64 as bigint | number | string, numeric enums or their names, oneofs as `{ case, value }`)
 * -> RenderItems on theme-key layers (`schematic.wire`, ...). Geometry follows
 * eeschema/sch_painter.cpp; label shapes come from labelShapes.ts, symbol orientation from
 * symbolTransform.ts and text placement from textMetrics.ts.
 *
 * Text: when the context supplies `textShapes(id)` (GetTextAsShapes) those glyph shapes are
 * drawn verbatim; otherwise `text-glyphs` primitives sized from KiCad's text size are emitted
 * for the schematic host's BitmapText builder (see textGlyphs.ts).
 */
import type { Box, Primitive, RenderItem, TextGlyphsPrimitive, Vec2 } from '../core/model.js';
import { EMPTY_BOX, boxFromPoints, boxOfPrimitives, boxUnion, boxIsEmpty, vAdd, vScale, vSub } from '../core/model.js';
import { circleToPolygon, hatchPolygon } from '../core/geometry.js';
import type { ThemeColor } from '../core/theme.js';
import type { StoredItemLike } from '../core/host.js';
import {
  type AngleLike,
  type DistanceLike,
  type GraphicShapeLike,
  type KiidLike,
  type LineEndingLike,
  type StrokeAttributesLike,
  type TextAttributesLike,
  type TextBoxLike,
  type TextLike,
  type TextShapesInput,
  type Vector2Like,
  bytesOf,
  dashPattern,
  deg,
  dist,
  enumName,
  graphicShapeToPrims,
  imageInfo,
  kiid,
  lineEnding,
  nm,
  strokedPolyline,
  textShapesToPrims,
  toBase64,
  vec,
} from '../board/boardAdapter.js';
import { MIL, SCH_DEFAULTS, SCH_LAYERS } from './schematicLayers.js';
import {
  type LabelShape,
  type SpinStyle,
  directiveLabelShape,
  globalLabelShape,
  globalLabelTextOffset,
  hierLabelShape,
  hierLabelTextOffset,
  labelShapeFromEnum,
  localLabelTextOffset,
  sheetPinShape,
  sheetSideSpin,
  spinStyleFromEnum,
  spinStyleFromText,
  spinTextAttrs,
} from './labelShapes.js';
import { type HAlign, type TextAttrs, type VAlign, flipHAlign, halignFromEnum, textBlockExtents, textGlyphPrims, valignFromEnum } from './textMetrics.js';
import {
  type PinOrientation,
  type SymTransform,
  IDENTITY_TRANSFORM,
  pinDirection,
  pinDrawOrientation,
  pinOrientationFromEnum,
  symbolTransform,
  transformPrimitive,
  transformTextGlyphs,
} from './symbolTransform.js';

// ---------------------------------------------------------------------------
// Input shapes (subset of kiapi.schematic.types, protobuf-es style)
// ---------------------------------------------------------------------------

export interface ColorLike {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}
export interface SchStrokeLike extends StrokeAttributesLike {
  color?: ColorLike;
}
export interface SchTextAttributesLike extends TextAttributesLike {
  bold?: boolean;
  italic?: boolean;
  color?: ColorLike;
  fontName?: string;
}
export interface SchTextLike extends TextLike {
  attributes?: SchTextAttributesLike;
}
export interface SchFieldLike {
  name?: string;
  text?: SchTextLike;
  visible?: boolean;
  showName?: boolean;
  isPrivate?: boolean;
}
export interface SchLineLike {
  id?: KiidLike;
  start?: Vector2Like;
  end?: Vector2Like;
  type?: number | string;
  stroke?: SchStrokeLike;
  startEnding?: LineEndingLike;
  endEnding?: LineEndingLike;
}
export interface SchPinLike {
  id?: KiidLike;
  name?: string;
  number?: string;
  position?: Vector2Like;
  length?: DistanceLike;
  orientation?: number | string;
  electricalType?: number | string;
  shape?: number | string;
  visible?: boolean;
  nameTextSize?: DistanceLike;
  numberTextSize?: DistanceLike;
}
export interface SchSymbolChildLike {
  item?: unknown;
  unit?: { unit?: number };
  bodyStyle?: { style?: number };
  isPrivate?: boolean;
}
export interface SchSheetPinLike {
  id?: KiidLike;
  position?: Vector2Like;
  text?: SchTextLike;
  spinStyle?: number | string;
  shape?: number | string;
  side?: number | string;
}

/** Either GraphicShape[] from GetTextAsShapes or plain glyph polygons (see board adapter). */
export type { TextShapesInput };

export interface SchematicAdapterContext {
  /**
   * Glyph geometry from `GetTextAsShapes`, keyed by the text's id: the item KIID for text /
   * labels / text boxes, `<symbol>:field:<name>` for symbol fields, `<symbol>:pin:<pinKIID>:name`
   * and `...:number` for pin texts, `<sheet>:field:<name>` and `<sheet>:pin:<pinKIID>` for
   * sheets, `<label>:field:<name>` for label fields. Shapes are in final sheet coordinates.
   */
  textShapes?: (textId: string) => TextShapesInput | undefined;
  /**
   * Decoder for `google.protobuf.Any` symbol children (`SchematicSymbolInstance.definition.items[].item`):
   * return the protobuf-es message (with `$typeName`), e.g. `unpackAny` from @kicad-web/proto.
   * Children that are already decoded messages or `{ type: 'KOT_SCH_PIN', proto }` wrappers
   * need no decoder.
   */
  decodeAny?: (any: unknown) => unknown;
  /** bbox of another store item (groups) */
  itemBBox?: (id: string) => Box | undefined;
  /**
   * Pin positions inside `definition.items` are already transformed to sheet coordinates
   * (true for `GetItems` output: SCH_SYMBOL pins serialise `GetPosition()`). Set false for
   * pins in library coordinates (symbols built from a library definition).
   */
  symbolPinsAbsolute?: boolean;
  /** draw hidden pins / fields on `schematic.hidden` (eeschema "show hidden ..." options) */
  showHiddenPins?: boolean;
  showHiddenFields?: boolean;
  /** draw the DNP cross and the excluded-from-simulation outline (default true) */
  showDnpMarkers?: boolean;
  /** how text without server shapes is drawn: BitmapText glyphs (default), a metrics box, or nothing */
  textFallback?: 'glyphs' | 'box' | 'none';
  /** nm per image pixel (KiCad: 25.4e6 / 300 ppi) */
  imagePixelNm?: number;
  /** arc approximation tolerance (nm) */
  arcTolerance?: number;
  /** schematic settings overrides (nm / ratios); defaults from eeschema/default_values.h */
  defaults?: Partial<SchematicDefaults>;
}

export interface SchematicDefaults {
  lineWidth: number;
  wireWidth: number;
  busWidth: number;
  junctionDiameter: number;
  noConnectSize: number;
  textSize: number;
  pinTextSize: number;
  textOffsetRatio: number;
  labelSizeRatio: number;
}

function defaultsOf(ctx: SchematicAdapterContext): SchematicDefaults {
  return {
    lineWidth: SCH_DEFAULTS.lineWidth,
    wireWidth: SCH_DEFAULTS.wireWidth,
    busWidth: SCH_DEFAULTS.busWidth,
    junctionDiameter: SCH_DEFAULTS.junctionDiameter,
    noConnectSize: SCH_DEFAULTS.noConnectSize,
    textSize: SCH_DEFAULTS.textSize,
    pinTextSize: SCH_DEFAULTS.pinTextSize,
    textOffsetRatio: SCH_DEFAULTS.textOffsetRatio,
    labelSizeRatio: SCH_DEFAULTS.labelSizeRatio,
    ...(ctx.defaults ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Value readers
// ---------------------------------------------------------------------------

/** kiapi Color (doubles 0..1) -> ThemeColor; undefined when absent or COLOR4D::UNSPECIFIED (all zero). */
export function colorOf(c: ColorLike | undefined | null): ThemeColor | undefined {
  if (!c) return undefined;
  const r = c.r ?? 0;
  const g = c.g ?? 0;
  const b = c.b ?? 0;
  const a = c.a ?? 0;
  if (r === 0 && g === 0 && b === 0 && a === 0) return undefined;
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a };
}

const KOT_BY_TYPENAME: Record<string, string> = {
  'kiapi.schematic.types.SchematicLine': 'KOT_SCH_LINE',
  'kiapi.schematic.types.Junction': 'KOT_SCH_JUNCTION',
  'kiapi.schematic.types.NoConnectMarker': 'KOT_SCH_NO_CONNECT',
  'kiapi.schematic.types.BusEntry': 'KOT_SCH_BUS_WIRE_ENTRY',
  'kiapi.schematic.types.SchematicText': 'KOT_SCH_TEXT',
  'kiapi.schematic.types.SchematicTextBox': 'KOT_SCH_TEXTBOX',
  'kiapi.schematic.types.SchematicGraphicShape': 'KOT_SCH_SHAPE',
  'kiapi.schematic.types.SchematicImage': 'KOT_SCH_BITMAP',
  'kiapi.schematic.types.LocalLabel': 'KOT_SCH_LABEL',
  'kiapi.schematic.types.GlobalLabel': 'KOT_SCH_GLOBAL_LABEL',
  'kiapi.schematic.types.HierarchicalLabel': 'KOT_SCH_HIER_LABEL',
  'kiapi.schematic.types.DirectiveLabel': 'KOT_SCH_DIRECTIVE_LABEL',
  'kiapi.schematic.types.Group': 'KOT_SCH_GROUP',
  'kiapi.schematic.types.SchematicRuleArea': 'KOT_SCH_RULE_AREA',
  'kiapi.schematic.types.SheetSymbol': 'KOT_SCH_SHEET',
  'kiapi.schematic.types.SheetPin': 'KOT_SCH_SHEET_PIN',
  'kiapi.schematic.types.SchematicSymbolInstance': 'KOT_SCH_SYMBOL',
  'kiapi.schematic.types.SchematicPin': 'KOT_SCH_PIN',
  'kiapi.schematic.types.SchematicField': 'KOT_SCH_FIELD',
  'kiapi.schematic.types.SchematicTable': 'KOT_SCH_TABLE',
};

/** KOT_SCH_* type of a message / wrapper / (decoded) Any. Undecoded Anys yield undefined. */
export function schematicItemTypeOf(x: unknown, ctx: SchematicAdapterContext = {}): { type: string; proto: Record<string, unknown> } | undefined {
  if (!x || typeof x !== 'object') return undefined;
  let o = x as Record<string, unknown>;
  if (o.$typeName === 'google.protobuf.Any') {
    const decoded = ctx.decodeAny?.(o);
    if (!decoded || typeof decoded !== 'object') return undefined;
    o = decoded as Record<string, unknown>;
  }
  if (typeof o.type === 'string' && o.type.startsWith('KOT_') && o.proto && typeof o.proto === 'object') {
    return { type: o.type, proto: o.proto as Record<string, unknown> };
  }
  if (o.proto && typeof o.proto === 'object' && (o.proto as Record<string, unknown>).$typeName) {
    return schematicItemTypeOf(o.proto, ctx); // client Item wrapper
  }
  const tn = o.$typeName;
  if (typeof tn === 'string') {
    const t = KOT_BY_TYPENAME[tn];
    return t ? { type: t, proto: o } : undefined;
  }
  // untyped plain objects: guess from the fields
  if ('number' in o && 'orientation' in o) return { type: 'KOT_SCH_PIN', proto: o };
  if ('textbox' in o) return { type: 'KOT_SCH_TEXTBOX', proto: o };
  if ('shape' in o && !('spinStyle' in o)) return { type: 'KOT_SCH_SHAPE', proto: o };
  if ('text' in o && typeof o.text === 'object') return { type: 'KOT_SCH_TEXT', proto: o };
  return undefined;
}

function readTextAttrs(a: SchTextAttributesLike | undefined, d: SchematicDefaults): TextAttrs & { color?: ThemeColor } {
  const sx = nm(a?.size?.xNm);
  const sy = nm(a?.size?.yNm);
  const size = { x: sx || sy || d.textSize, y: sy || sx || d.textSize };
  const bold = !!a?.bold;
  let thickness = dist(a?.strokeWidth);
  if (thickness <= 1) thickness = bold ? Math.round(size.x / 5) : d.lineWidth;
  thickness = Math.min(thickness, Math.round(Math.min(size.x, size.y) * 0.25)); // ClampTextPenSize
  return {
    size,
    thickness,
    angle: deg(a?.angle),
    halign: halignFromEnum(a?.horizontalAlignment, 'left'),
    valign: valignFromEnum(a?.verticalAlignment, 'bottom'),
    mirrored: !!a?.mirrored,
    bold,
    italic: !!a?.italic,
    lineSpacing: a?.lineSpacing || 1,
    color: colorOf(a?.color),
  };
}

const lineStyleOf = (s: SchStrokeLike | undefined): string => enumName('StrokeLineStyle', s?.style);

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

interface Ctx {
  ctx: SchematicAdapterContext;
  d: SchematicDefaults;
  owner: string;
}

function finish(id: string, layer: string, prims: Primitive[], c: Ctx, extra: Partial<RenderItem> = {}): RenderItem {
  return { id, layer, prims, bbox: boxOfPrimitives(prims), owner: c.owner, ref: id, ...extra };
}

/** Text as server shapes (when supplied) or text-glyphs primitives at `pos`. */
function textPrims(textId: string, text: string, pos: Vec2, a: TextAttrs, c: Ctx): Primitive[] {
  const shapes = c.ctx.textShapes?.(textId);
  if (shapes && shapes.length) return textShapesToPrims(shapes, { arcTolerance: c.ctx.arcTolerance });
  const mode = c.ctx.textFallback ?? 'glyphs';
  if (mode === 'none' || !text) return [];
  const glyphs = textGlyphPrims(text, pos, a);
  if (mode === 'box') return glyphs.map((g) => ({ kind: 'polygon', outline: g.outline, holes: [], fill: false, width: 0 }) as Primitive);
  return glyphs;
}

/** True when `textPrims` will use server shapes (which must not be transformed again). */
const hasServerShapes = (textId: string, c: Ctx): boolean => !!c.ctx.textShapes?.(textId)?.length;

function segs(pts: Vec2[], width: number, closed = false): Primitive[] {
  return strokedPolyline(pts, width, undefined, closed);
}

function polyline(pts: Vec2[], width: number, pattern?: number[]): Primitive[] {
  // an explicitly closed polyline (first point repeated) becomes one polygon outline
  if (pts.length >= 4 && pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.y === pts[pts.length - 1]!.y) {
    return strokedPolyline(pts.slice(0, -1), width, pattern, true);
  }
  return strokedPolyline(pts, width, pattern, false);
}

function rectPts(tl: Vec2, br: Vec2): Vec2[] {
  return [tl, { x: br.x, y: tl.y }, br, { x: tl.x, y: br.y }];
}

/**
 * A GraphicShape split the way SCH_PAINTER draws it: outline (+ same-colour fill for
 * FILLED_SHAPE) on the foreground layer, background fills / hatching on `bgLayer`.
 */
function shapePrims(shape: GraphicShapeLike | undefined, c: Ctx): { fg: Primitive[]; bg: Primitive[]; bgColor?: ThemeColor | string; fgColor?: ThemeColor } {
  if (!shape) return { fg: [], bg: [] };
  const stroke = shape.attributes?.stroke as SchStrokeLike | undefined;
  let width = dist(stroke?.width);
  const noStroke = width < 0;
  if (width === 0) width = c.d.lineWidth; // 0 = default width (SCH_SHAPE::GetEffectiveWidth)
  if (noStroke) width = 0;
  const style = lineStyleOf(stroke);
  const fillType = enumName('GraphicFillType', shape.attributes?.fill?.fillType);
  const fillColor = colorOf((shape.attributes?.fill as { color?: ColorLike } | undefined)?.color);
  const arcTol = c.ctx.arcTolerance;
  const outlineShape: GraphicShapeLike = { ...shape, attributes: { stroke: { width: { valueNm: width }, style }, fill: { fillType: 'GFT_UNFILLED' } } };
  const fillShape: GraphicShapeLike = { ...shape, attributes: { stroke: { width: { valueNm: 0 }, style: 'SLS_SOLID' }, fill: { fillType: 'GFT_FILLED' } } };
  const fg: Primitive[] = noStroke ? [] : graphicShapeToPrims(outlineShape, { arcTolerance: arcTol });
  const fills = graphicShapeToPrims(fillShape, { arcTolerance: arcTol }).filter((p) => (p.kind === 'polygon' || p.kind === 'circle') && p.fill);
  const bg: Primitive[] = [];
  let bgColor: ThemeColor | string | undefined;
  switch (fillType) {
    case 'GFT_FILLED':
      fg.unshift(...fills);
      break;
    case 'GFT_FILLED_WITH_COLOR':
      bg.push(...fills);
      bgColor = fillColor;
      break;
    case 'GFT_FILLED_WITH_BACKGROUND_BODY_COLOR':
      bg.push(...fills);
      break;
    case 'GFT_HATCH':
    case 'GFT_REVERSE_HATCH':
    case 'GFT_CROSS_HATCH': {
      const pitch = 30 * MIL;
      const hw = Math.max(1, Math.round(width / 2));
      const angles = fillType === 'GFT_HATCH' ? [45] : fillType === 'GFT_REVERSE_HATCH' ? [-45] : [45, -45];
      for (const f of fills) {
        const outline = f.kind === 'polygon' ? f.outline : f.kind === 'circle' ? circleToPolygon(f.c, f.r, 0, arcTol) : [];
        const holes = f.kind === 'polygon' ? f.holes : [];
        for (const ang of angles) for (const [a, b] of hatchPolygon(outline, holes, pitch, ang)) bg.push({ kind: 'segment', a, b, width: hw });
      }
      bgColor = 'fg';
      break;
    }
    default:
      break;
  }
  return { fg, bg, bgColor, fgColor: colorOf(stroke?.color) };
}

/** Emit the fg / bg items for a shape. `transform` maps library primitives to the sheet. */
function shapeItems(id: string, shape: GraphicShapeLike | undefined, fgLayer: string, bgLayer: string, c: Ctx, transform?: (p: Primitive) => Primitive, extra: Partial<RenderItem> = {}): RenderItem[] {
  const s = shapePrims(shape, c);
  const t = transform ?? ((p) => p);
  const out: RenderItem[] = [];
  if (s.bg.length) {
    const color = s.bgColor === 'fg' ? s.fgColor : s.bgColor;
    out.push(finish(`${id}@bg`, s.bgColor === 'fg' ? fgLayer : bgLayer, s.bg.map(t), c, { ...extra, ref: extra.ref ?? id, pickable: false, ...(color ? { color } : {}) }));
  }
  if (s.fg.length) out.push(finish(id, fgLayer, s.fg.map(t), c, { ...extra, ...(s.fgColor ? { color: s.fgColor } : {}) }));
  return out;
}

// ---------------------------------------------------------------------------
// Wires, junctions, no-connects, bus entries
// ---------------------------------------------------------------------------

function convertLine(p: SchLineLike, id: string, c: Ctx): RenderItem[] {
  const a = vec(p.start);
  const b = vec(p.end);
  const type = p.type;
  const isBus = type === 2 || type === 'SLT_BUS';
  const isWire = type === 1 || type === 'SLT_WIRE';
  const isGraphic = !isBus && !isWire;
  const width = dist(p.stroke?.width) || (isBus ? c.d.busWidth : isWire ? c.d.wireWidth : c.d.lineWidth);
  const pattern = dashPattern(lineStyleOf(p.stroke), width);
  const prims = strokedPolyline([a, b], width, pattern, false);
  if (isGraphic) prims.push(...lineEnding(a, b, p.startEnding, width), ...lineEnding(b, a, p.endEnding, width));
  if (!prims.length) return [];
  const color = colorOf(p.stroke?.color);
  return [finish(id, isBus ? SCH_LAYERS.bus : isWire ? SCH_LAYERS.wire : SCH_LAYERS.note, prims, c, color ? { color } : {})];
}

function convertJunction(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const r = (dist(p.diameter as DistanceLike) || c.d.junctionDiameter) / 2;
  if (r <= 1) return [];
  const color = colorOf(p.color as ColorLike);
  return [finish(id, SCH_LAYERS.junction, [{ kind: 'circle', c: pos, r, width: 0, fill: true }], c, color ? { color } : {})];
}

function convertNoConnect(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const delta = Math.max(dist(p.size as DistanceLike) || c.d.noConnectSize, c.d.lineWidth * 3) / 2;
  const w = c.d.lineWidth;
  return [
    finish(
      id,
      SCH_LAYERS.noConnect,
      [
        { kind: 'segment', a: { x: pos.x - delta, y: pos.y - delta }, b: { x: pos.x + delta, y: pos.y + delta }, width: w },
        { kind: 'segment', a: { x: pos.x - delta, y: pos.y + delta }, b: { x: pos.x + delta, y: pos.y - delta }, width: w },
      ],
      c,
    ),
  ];
}

function convertBusEntry(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const size = vec(p.size as Vector2Like);
  const end = vAdd(pos, size.x === 0 && size.y === 0 ? { x: SCH_DEFAULTS.busEntrySize, y: SCH_DEFAULTS.busEntrySize } : size);
  const isBus = p.type === 2 || p.type === 'BET_BUS_TO_BUS';
  const stroke = p.stroke as SchStrokeLike | undefined;
  const width = dist(stroke?.width) || (isBus ? c.d.busWidth : c.d.wireWidth);
  const prims = strokedPolyline([pos, end], width, dashPattern(lineStyleOf(stroke), width), false);
  const color = colorOf(stroke?.color);
  return [finish(id, isBus ? SCH_LAYERS.bus : SCH_LAYERS.wire, prims, c, color ? { color } : {})];
}

// ---------------------------------------------------------------------------
// Text, text boxes, shapes, images
// ---------------------------------------------------------------------------

function convertText(p: Record<string, unknown>, id: string, c: Ctx, layer = SCH_LAYERS.note): RenderItem[] {
  const t = p.text as SchTextLike | undefined;
  if (!t) return [];
  const a = readTextAttrs(t.attributes, c.d);
  const prims = textPrims(id, t.text ?? '', vec(t.position), a, c);
  if (!prims.length) return [];
  return [finish(id, layer, prims, c, a.color ? { color: a.color } : {})];
}

interface TextBoxOut {
  border: Primitive[];
  text: Primitive[];
  bg: Primitive[];
  bgColor?: ThemeColor;
  borderColor?: ThemeColor;
  textColor?: ThemeColor;
}

/** SCH_TEXTBOX: border, background fill and the text at SCH_TEXTBOX::GetDrawPos. */
function textBoxPrims(textId: string, p: Record<string, unknown>, c: Ctx): TextBoxOut {
  const tb = p.textbox as (TextBoxLike & { attributes?: SchTextAttributesLike; marginLeft?: DistanceLike; marginTop?: DistanceLike; marginRight?: DistanceLike; marginBottom?: DistanceLike }) | undefined;
  const out: TextBoxOut = { border: [], text: [], bg: [] };
  if (!tb) return out;
  const tl0 = vec(tb.topLeft);
  const br0 = vec(tb.bottomRight);
  const tl = { x: Math.min(tl0.x, br0.x), y: Math.min(tl0.y, br0.y) };
  const br = { x: Math.max(tl0.x, br0.x), y: Math.max(tl0.y, br0.y) };
  const a = readTextAttrs(tb.attributes, c.d);
  const m = (k: 'marginLeft' | 'marginTop' | 'marginRight' | 'marginBottom'): number => dist((p[k] as DistanceLike) ?? tb[k]);
  const ml = m('marginLeft');
  const mt = m('marginTop');
  const mr = m('marginRight');
  const mb = m('marginBottom');
  const vertical = Math.abs(((a.angle % 180) + 180) % 180 - 90) < 1e-6;
  const pos = { x: tl.x + ml, y: br.y - mb };
  if (vertical) {
    pos.y = a.halign === 'left' ? br.y - mb : a.halign === 'right' ? tl.y + mt : (tl.y + br.y) / 2;
    pos.x = a.valign === 'top' ? tl.x + ml : a.valign === 'bottom' ? br.x - mr : (tl.x + br.x) / 2;
  } else {
    pos.x = a.halign === 'left' ? tl.x + ml : a.halign === 'right' ? br.x - mr : (tl.x + br.x) / 2;
    pos.y = a.valign === 'top' ? tl.y + mt : a.valign === 'bottom' ? br.y - mb : (tl.y + br.y) / 2;
  }
  out.text = textPrims(textId, tb.text ?? '', pos, a, c);
  out.textColor = a.color;
  const ga = p.graphicAttributes as { stroke?: SchStrokeLike; fill?: { fillType?: number | string; color?: ColorLike } } | undefined;
  const rect = rectPts(tl, br);
  const borderEnabled = tb.borderEnabled ?? true;
  const strokeW = dist(ga?.stroke?.width);
  if (borderEnabled && strokeW >= 0) {
    const w = strokeW || c.d.lineWidth;
    out.border = strokedPolyline(rect, w, dashPattern(lineStyleOf(ga?.stroke), w), true);
    out.borderColor = colorOf(ga?.stroke?.color);
  }
  const fillType = enumName('GraphicFillType', ga?.fill?.fillType);
  if (fillType === 'GFT_FILLED_WITH_COLOR' || fillType === 'GFT_FILLED_WITH_BACKGROUND_BODY_COLOR' || fillType === 'GFT_FILLED') {
    out.bg = [{ kind: 'polygon', outline: rect, holes: [], fill: true, width: 0 }];
    if (fillType === 'GFT_FILLED_WITH_COLOR') out.bgColor = colorOf(ga?.fill?.color);
  }
  return out;
}

function convertTextBox(p: Record<string, unknown>, id: string, c: Ctx, fgLayer = SCH_LAYERS.note, bgLayer = SCH_LAYERS.noteBackground, transform?: (q: Primitive) => Primitive, extra: Partial<RenderItem> = {}): RenderItem[] {
  const tb = textBoxPrims(id, p, c);
  const t = transform ?? ((q) => q);
  const out: RenderItem[] = [];
  if (tb.bg.length) out.push(finish(`${id}@bg`, bgLayer, tb.bg.map(t), c, { ...extra, ref: extra.ref ?? id, pickable: false, ...(tb.bgColor ? { color: tb.bgColor } : {}) }));
  if (tb.border.length) out.push(finish(`${id}@border`, fgLayer, tb.border.map(t), c, { ...extra, ref: extra.ref ?? id, ...(tb.borderColor ? { color: tb.borderColor } : {}) }));
  if (tb.text.length) out.push(finish(id, fgLayer, tb.text.map(t), c, { ...extra, ...(tb.textColor ? { color: tb.textColor } : {}) }));
  return out;
}

function convertShape(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  return shapeItems(id, p.shape as GraphicShapeLike, SCH_LAYERS.note, SCH_LAYERS.noteBackground, c);
}

function convertRuleArea(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  return shapeItems(id, p.shape as GraphicShapeLike, SCH_LAYERS.ruleArea, SCH_LAYERS.noteBackground, c);
}

function convertImage(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const scale = (p.imageScale as { value?: number } | undefined)?.value || 1;
  const pxNm = c.ctx.imagePixelNm ?? 25.4e6 / 300;
  const bytes = bytesOf(p.imageData);
  const info = bytes ? imageInfo(bytes) : undefined;
  if (!bytes || !info) {
    const s = 5_000_000;
    return [finish(id, SCH_LAYERS.note, [{ kind: 'polygon', outline: rectPts({ x: pos.x - s / 2, y: pos.y - s / 2 }, { x: pos.x + s / 2, y: pos.y + s / 2 }), holes: [], fill: false, width: 0 }], c)];
  }
  const w = info.w * pxNm * scale;
  const h = info.h * pxNm * scale;
  return [finish(id, SCH_LAYERS.bitmaps, [{ kind: 'image', c: pos, w, h, dataUrl: `data:${info.mime};base64,${toBase64(bytes)}` }], c)];
}

function convertGroup(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  let bbox = EMPTY_BOX;
  for (const m of (p.items as KiidLike[]) ?? []) {
    const b = c.ctx.itemBBox?.(kiid(m));
    if (b) bbox = boxUnion(bbox, b);
  }
  if (boxIsEmpty(bbox)) return [];
  return [{ id, layer: SCH_LAYERS.auxItems, prims: [], bbox, owner: c.owner, ref: id }];
}

function convertTable(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const cells = (p.cells as Array<{ textBox?: Record<string, unknown> }>) ?? [];
  const out: RenderItem[] = [];
  let bbox = EMPTY_BOX;
  cells.forEach((cell, i) => {
    const tb = cell.textBox;
    if (!tb) return;
    const cid = kiid(tb.id as KiidLike) || `${id}:cell${i}`;
    const items = convertTextBox(tb, cid, c, SCH_LAYERS.note, SCH_LAYERS.noteBackground, undefined, { ref: id });
    for (const it of items) bbox = boxUnion(bbox, it.bbox);
    out.push(...items);
  });
  if (boxIsEmpty(bbox)) return out;
  const borderW = dist((p.borderStroke as StrokeAttributesLike | undefined)?.width) || c.d.lineWidth;
  out.push(finish(id, SCH_LAYERS.note, [{ kind: 'polygon', outline: rectPts({ x: bbox.x, y: bbox.y }, { x: bbox.x + bbox.w, y: bbox.y + bbox.h }), holes: [], fill: false, width: borderW }], c));
  return out;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface FieldOpts {
  /** id of the produced item and textShapes key */
  id: string;
  layer: string;
  /** library -> sheet transform for symbol fields (position relative to `origin`) */
  transform?: SymTransform;
  origin?: Vec2;
  pickable?: boolean;
  ref?: string;
}

/** A SchematicField as text. Returns [] when hidden / empty. */
function fieldItems(f: SchFieldLike | undefined, c: Ctx, o: FieldOpts): RenderItem[] {
  if (!f?.text) return [];
  if (f.isPrivate) return [];
  let layer = o.layer;
  if (f.visible === false) {
    if (!c.ctx.showHiddenFields) return [];
    layer = SCH_LAYERS.hidden;
  }
  let text = f.text.text ?? '';
  if (!text) return [];
  if (f.showName && f.name) text = `${f.name}: ${text}`;
  const a = readTextAttrs(f.text.attributes, c.d);
  const absPos = vec(f.text.position);
  let prims: Primitive[];
  if (o.transform && o.origin && !hasServerShapes(o.id, c)) {
    const local = vSub(absPos, o.origin);
    const t = o.transform;
    const origin = o.origin;
    prims = textPrims(o.id, text, local, a, c).map((p) => transformPrimitive(p, t, origin));
  } else {
    prims = textPrims(o.id, text, absPos, a, c);
  }
  if (!prims.length) return [];
  return [finish(o.id, layer, prims, c, { ref: o.ref ?? o.id, pickable: o.pickable, ...(a.color ? { color: a.color } : {}) })];
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

interface LabelBase {
  pos: Vec2;
  text: string;
  a: TextAttrs & { color?: ThemeColor };
  spin: SpinStyle;
  penWidth: number;
}

function labelBase(p: Record<string, unknown>, c: Ctx, valign: VAlign): LabelBase {
  const t = (p.text ?? {}) as SchTextLike;
  const a = readTextAttrs(t.attributes, c.d);
  const spin = spinStyleFromEnum(p.spinStyle as number | string) ?? spinStyleFromText(a.angle, a.halign);
  const st = spinTextAttrs(spin);
  a.angle = st.angle;
  a.halign = st.halign;
  a.valign = valign;
  const pos = p.position ? vec(p.position as Vector2Like) : vec(t.position);
  return { pos, text: t.text ?? '', a, spin, penWidth: a.thickness };
}

function labelFields(p: Record<string, unknown>, id: string, c: Ctx, layer: string): RenderItem[] {
  const out: RenderItem[] = [];
  const fields = (p.fields as SchFieldLike[] | undefined) ?? [];
  fields.forEach((f, i) => out.push(...fieldItems(f, c, { id: `${id}:field:${f.name || i}`, layer, ref: id, pickable: true })));
  const isr = p.intersheetRefsField as SchFieldLike | undefined;
  if (isr) out.push(...fieldItems(isr, c, { id: `${id}:field:${isr.name || 'Intersheetrefs'}`, layer, ref: id, pickable: true }));
  return out;
}

function convertLocalLabel(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const l = labelBase(p, c, 'bottom');
  const off = localLabelTextOffset(l.a.size.y, l.penWidth, l.spin, c.d.textOffsetRatio);
  const prims = textPrims(id, l.text, vAdd(l.pos, off), l.a, c);
  const out: RenderItem[] = [];
  if (prims.length) out.push(finish(id, SCH_LAYERS.labelLocal, prims, c, { bbox: boxUnion(boxOfPrimitives(prims), boxFromPoints([l.pos])), ...(l.a.color ? { color: l.a.color } : {}) }));
  out.push(...labelFields(p, id, c, SCH_LAYERS.fields));
  return out;
}

function convertGlobalLabel(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const l = labelBase(p, c, 'center');
  const shape = labelShapeFromEnum(p.shape as number | string, 'input');
  const textWidth = textBlockExtents(l.text, l.a).w;
  const outline = globalLabelShape(l.pos, l.a.size.y, textWidth, l.penWidth, shape, l.spin);
  const prims: Primitive[] = polyline(outline, l.penWidth);
  prims.push(...textPrims(id, l.text, vAdd(l.pos, globalLabelTextOffset(l.a.size.y, shape, l.spin)), l.a, c));
  const out: RenderItem[] = [finish(id, SCH_LAYERS.labelGlobal, prims, c, l.a.color ? { color: l.a.color } : {})];
  out.push(...labelFields(p, id, c, SCH_LAYERS.fields));
  return out;
}

/** Hierarchical label / sheet pin body: background-filled flag plus stroked outline and text. */
function flagItems(id: string, layer: string, outline: Vec2[], textAt: Vec2, l: LabelBase, c: Ctx, extra: Partial<RenderItem> = {}): RenderItem[] {
  const closed = outline.slice(0, -1);
  const out: RenderItem[] = [];
  if (closed.length >= 3) {
    out.push(finish(`${id}@fill`, layer, [{ kind: 'polygon', outline: closed, holes: [], fill: true, width: 0 }], c, { ...extra, ref: extra.ref ?? id, pickable: false, color: 'schematic.background' }));
  }
  const prims: Primitive[] = polyline(outline, l.penWidth);
  prims.push(...textPrims(id, l.text, textAt, l.a, c));
  out.push(finish(id, layer, prims, c, { ...extra, ...(l.a.color ? { color: l.a.color } : {}) }));
  return out;
}

function convertHierLabel(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const l = labelBase(p, c, 'center');
  const shape = labelShapeFromEnum(p.shape as number | string, 'input');
  const outline = hierLabelShape(l.pos, l.a.size.y, shape, l.spin);
  const out = flagItems(id, SCH_LAYERS.labelHier, outline, vAdd(l.pos, hierLabelTextOffset(l.a.size.y, l.a.size.x, l.spin, c.d.textOffsetRatio)), l, c);
  out.push(...labelFields(p, id, c, SCH_LAYERS.fields));
  return out;
}

function convertDirectiveLabel(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const l = labelBase(p, c, 'center');
  const shape = labelShapeFromEnum(p.shape as number | string, 'circle');
  const pinLength = dist(p.pinLength as DistanceLike) || SCH_DEFAULTS.directivePinLength;
  const symbolSize = dist(p.symbolSize as DistanceLike) || SCH_DEFAULTS.directiveSymbolSize;
  const s = directiveLabelShape(l.pos, shape, l.spin, pinLength, symbolSize);
  const prims: Primitive[] = polyline(s.line, l.penWidth);
  if (s.circle) prims.push({ kind: 'circle', c: s.circle.c, r: s.circle.r, width: l.penWidth, fill: s.circle.fill });
  const out: RenderItem[] = [];
  if (prims.length) out.push(finish(id, SCH_LAYERS.netclassFlag, prims, c, l.a.color ? { color: l.a.color } : {}));
  out.push(...labelFields(p, id, c, SCH_LAYERS.netclassFlag));
  return out;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function sheetPinItems(pin: SchSheetPinLike, index: number, sheetId: string, c: Ctx): RenderItem[] {
  const pinId = kiid(pin.id) || `${sheetId}:pin${index}`;
  const t = pin.text ?? {};
  const a = readTextAttrs(t.attributes, c.d);
  const spin = spinStyleFromEnum(pin.spinStyle) ?? sheetSideSpin(pin.side) ?? spinStyleFromText(a.angle, a.halign);
  const st = spinTextAttrs(spin);
  a.angle = st.angle;
  a.halign = st.halign;
  a.valign = 'center';
  const pos = pin.position ? vec(pin.position) : vec(t.position);
  const l: LabelBase = { pos, text: t.text ?? '', a, spin, penWidth: a.thickness };
  const shape = labelShapeFromEnum(pin.shape, 'input');
  const outline = sheetPinShape(pos, a.size.y, shape, spin);
  return flagItems(`${sheetId}:pin:${pinId}`, SCH_LAYERS.sheetLabel, outline, vAdd(pos, hierLabelTextOffset(a.size.y, a.size.x, spin, c.d.textOffsetRatio)), l, c, { ref: pinId });
}

function dnpCross(body: Box, withPins: Box, c: Ctx, id: string, ref: string): RenderItem[] {
  if (boxIsEmpty(body)) body = withPins;
  if (boxIsEmpty(body)) return [];
  const pins = boxIsEmpty(withPins) ? body : boxUnion(body, withPins);
  let mx = Math.max(body.x - pins.x, pins.x + pins.w - (body.x + body.w), 0);
  let my = Math.max(body.y - pins.y, pins.y + pins.h - (body.y + body.h), 0);
  const nx = Math.max(mx * 0.6, my * 0.3);
  const ny = Math.max(my * 0.6, mx * 0.3);
  mx = Math.round(nx);
  my = Math.round(ny);
  const x0 = body.x - mx;
  const y0 = body.y - my;
  const x1 = body.x + body.w + mx;
  const y1 = body.y + body.h + my;
  const w = SCH_DEFAULTS.dnpStroke;
  return [
    finish(
      `${id}@dnp`,
      SCH_LAYERS.dnpMarker,
      [
        { kind: 'segment', a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, width: w },
        { kind: 'segment', a: { x: x1, y: y0 }, b: { x: x0, y: y1 }, width: w },
      ],
      c,
      { ref, pickable: false },
    ),
  ];
}

function convertSheet(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const size = vec(p.size as Vector2Like);
  const br = vAdd(pos, size);
  const rect = rectPts(pos, br);
  const out: RenderItem[] = [];
  const fill = p.fill as { fillType?: number | string; color?: ColorLike } | undefined;
  const fillType = enumName('GraphicFillType', fill?.fillType);
  const bgColor = fillType === 'GFT_FILLED_WITH_COLOR' ? colorOf(fill?.color) : undefined;
  out.push(finish(`${id}@bg`, SCH_LAYERS.sheetBackground, [{ kind: 'polygon', outline: rect, holes: [], fill: true, width: 0 }], c, { ref: id, pickable: false, ...(bgColor ? { color: bgColor } : {}) }));
  const stroke = p.borderStroke as SchStrokeLike | undefined;
  const w = dist(stroke?.width) || c.d.lineWidth;
  const borderColor = colorOf(stroke?.color);
  out.push(finish(`${id}@border`, SCH_LAYERS.sheet, [{ kind: 'polygon', outline: rect, holes: [], fill: false, width: w }], c, { ref: id, pickable: false, ...(borderColor ? { color: borderColor } : {}) }));
  const nameField = p.nameField as SchFieldLike | undefined;
  const fileField = p.filenameField as SchFieldLike | undefined;
  out.push(...fieldItems(nameField, c, { id: `${id}:field:${nameField?.name || 'Sheetname'}`, layer: SCH_LAYERS.sheetName, ref: id, pickable: true }));
  out.push(...fieldItems(fileField, c, { id: `${id}:field:${fileField?.name || 'Sheetfile'}`, layer: SCH_LAYERS.sheetFilename, ref: id, pickable: true }));
  ((p.userFields as SchFieldLike[] | undefined) ?? []).forEach((f, i) => out.push(...fieldItems(f, c, { id: `${id}:field:${f.name || i}`, layer: SCH_LAYERS.sheetFields, ref: id, pickable: true })));
  ((p.pins as SchSheetPinLike[] | undefined) ?? []).forEach((pin, i) => out.push(...sheetPinItems(pin, i, id, c)));
  const body = boxFromPoints(rect);
  if (p.dnp && (c.ctx.showDnpMarkers ?? true)) {
    let withPins = body;
    for (const it of out) if (it.id.includes(':pin:')) withPins = boxUnion(withPins, it.bbox);
    out.push(...dnpCross(body, withPins, c, id, id));
  }
  // sheet body: picked by its rectangle, after the pins / fields
  out.push({ id, layer: SCH_LAYERS.sheet, prims: [], bbox: body, owner: c.owner, ref: id });
  return out;
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

const PIN_SHAPE_NAMES = ['SPS_UNKNOWN', 'SPS_LINE', 'SPS_INVERTED', 'SPS_CLOCK', 'SPS_INVERTED_CLOCK', 'SPS_INPUT_LOW', 'SPS_CLOCK_LOW', 'SPS_OUTPUT_LOW', 'SPS_FALLING_EDGE_CLOCK', 'SPS_NONLOGIC'];
const pinShapeName = (v: number | string | undefined): string => (typeof v === 'number' ? (PIN_SHAPE_NAMES[v] ?? 'SPS_LINE') : (v ?? 'SPS_LINE'));
const isNoConnectPin = (v: number | string | undefined): boolean => v === 12 || v === 'EPT_NO_CONNECT';

interface PinGeom {
  /** connection point (sheet coordinates) */
  pos: Vec2;
  /** where the pin meets the body */
  root: Vec2;
  orient: PinOrientation;
  length: number;
}

/** SCH_PAINTER::draw(SCH_PIN*): pin line and electrical-type decorations. */
function pinBodyPrims(g: PinGeom, shape: string, noConnect: boolean, numSize: number, nameSize: number, width: number): Primitive[] {
  const p0 = g.root;
  const pos = g.pos;
  const dir = { x: Math.sign(pos.x - p0.x), y: Math.sign(pos.y - p0.y) };
  const radius = Math.round(numSize / 2); // externalPinDecoSize
  const diam = radius * 2;
  const clock = Math.round((nameSize || numSize) / 2); // internalPinDecoSize
  const seg = (a: Vec2, b: Vec2): Primitive => ({ kind: 'segment', a, b, width });
  const tri = (a: Vec2, b: Vec2, cc: Vec2): Primitive[] => [seg(a, b), seg(b, cc)];
  const at = (v: Vec2, k: number): Vec2 => vAdd(p0, vScale(v, k));
  const out: Primitive[] = [];
  if (g.length === 0 && !noConnect && shape === 'SPS_LINE') return out;
  if (noConnect) {
    const r = SCH_DEFAULTS.pinTargetRadius;
    out.push(seg(p0, pos), seg({ x: pos.x - r, y: pos.y - r }, { x: pos.x + r, y: pos.y + r }), seg({ x: pos.x + r, y: pos.y - r }, { x: pos.x - r, y: pos.y + r }));
    return out;
  }
  switch (shape) {
    case 'SPS_INVERTED':
      out.push({ kind: 'circle', c: at(dir, radius), r: radius, width, fill: false }, seg(at(dir, diam), pos));
      break;
    case 'SPS_INVERTED_CLOCK':
      out.push(...tri(at({ x: dir.y, y: -dir.x }, clock), at(dir, -clock), at({ x: -dir.y, y: dir.x }, clock)));
      out.push({ kind: 'circle', c: at(dir, radius), r: radius, width, fill: false }, seg(at(dir, diam), pos));
      break;
    case 'SPS_CLOCK_LOW':
    case 'SPS_FALLING_EDGE_CLOCK':
      out.push(...tri(at({ x: dir.y, y: -dir.x }, clock), at(dir, -clock), at({ x: -dir.y, y: dir.x }, clock)));
      if (!dir.y) out.push(...tri(at({ x: dir.x, y: 0 }, diam), at({ x: dir.x, y: -1 }, diam), p0));
      else out.push(...tri(at({ x: 0, y: dir.y }, diam), at({ x: -1, y: dir.y }, diam), p0));
      out.push(seg(p0, pos));
      break;
    case 'SPS_CLOCK':
      out.push(seg(p0, pos));
      if (!dir.y) out.push(...tri(at({ x: 0, y: 1 }, clock), at({ x: -dir.x, y: 0 }, clock), at({ x: 0, y: -1 }, clock)));
      else out.push(...tri(at({ x: 1, y: 0 }, clock), at({ x: 0, y: -dir.y }, clock), at({ x: -1, y: 0 }, clock)));
      break;
    case 'SPS_INPUT_LOW':
      out.push(seg(p0, pos));
      if (!dir.y) out.push(...tri(at({ x: dir.x, y: 0 }, diam), at({ x: dir.x, y: -1 }, diam), p0));
      else out.push(...tri(at({ x: 0, y: dir.y }, diam), at({ x: -1, y: dir.y }, diam), p0));
      break;
    case 'SPS_OUTPUT_LOW':
      out.push(seg(p0, pos));
      if (!dir.y) out.push(seg({ x: p0.x, y: p0.y - diam }, at({ x: dir.x, y: 0 }, diam)));
      else out.push(seg({ x: p0.x - diam, y: p0.y }, at({ x: 0, y: dir.y }, diam)));
      break;
    case 'SPS_NONLOGIC':
      out.push(seg(p0, pos));
      out.push(seg(at({ x: dir.x + dir.y, y: dir.y - dir.x }, -radius), at({ x: dir.x + dir.y, y: dir.y - dir.x }, radius)));
      out.push(seg(at({ x: dir.x - dir.y, y: dir.x + dir.y }, -radius), at({ x: dir.x - dir.y, y: dir.x + dir.y }, radius)));
      break;
    default:
      out.push(seg(p0, pos));
  }
  return out;
}

interface PinTextLayout {
  text: string;
  pos: Vec2;
  size: number;
  thickness: number;
  angle: number;
  halign: HAlign;
  valign: VAlign;
}

/** PIN_LAYOUT_CACHE::GetPinNumberInfo. */
function pinNumberLayout(g: PinGeom, number: string, numSize: number, thickness: number, nameOutside: boolean, c: Ctx): PinTextLayout | undefined {
  if (!number) return undefined;
  const textOffset = Math.round(24 * c.d.textOffsetRatio) * MIL;
  const lines = number.split('\n').length;
  const perpHeight = lines > 1 ? lines * Math.round(numSize * 1.3) : numSize;
  const perp = Math.round(perpHeight / 2) + textOffset + SCH_DEFAULTS.pinTextMargin + thickness;
  const half = Math.round(g.length / 2);
  const vertical = g.orient === 'up' || g.orient === 'down';
  if (vertical) {
    return {
      text: number,
      pos: { x: nameOutside ? g.pos.x + perp : g.pos.x - perp, y: g.orient === 'down' ? g.pos.y + half : g.pos.y - half },
      size: numSize,
      thickness,
      angle: 90,
      halign: 'center',
      valign: 'center',
    };
  }
  return {
    text: number,
    pos: { x: g.orient === 'left' ? g.pos.x - half : g.pos.x + half, y: nameOutside ? g.pos.y + perp : g.pos.y - perp },
    size: numSize,
    thickness,
    angle: 0,
    halign: 'center',
    valign: 'center',
  };
}

/** PIN_LAYOUT_CACHE::GetPinNameInfo (+ transformTextForPin for names inside the body). */
function pinNameLayout(g: PinGeom, name: string, nameSize: number, thickness: number, nameOffset: number, maxHalfHeight: number, c: Ctx): PinTextLayout | undefined {
  if (!name) return undefined;
  const textOffset = Math.round(24 * c.d.textOffsetRatio) * MIL;
  if (nameOffset > 0) {
    const local = { x: g.length + nameOffset, y: 0 };
    let pos: Vec2 = local;
    let angle = 0;
    let halign: HAlign = 'left';
    switch (g.orient) {
      case 'left':
        pos = { x: -local.x, y: -local.y };
        halign = flipHAlign(halign);
        break;
      case 'up':
        pos = { x: local.y, y: -local.x };
        angle = 90;
        break;
      case 'down':
        pos = { x: -local.y, y: local.x };
        angle = 90;
        halign = flipHAlign(halign);
        break;
      default:
        break;
    }
    return { text: name, pos: vAdd(pos, g.pos), size: nameSize, thickness, angle, halign, valign: 'center' };
  }
  const clearance = textOffset + SCH_DEFAULTS.pinTextMargin;
  const half = Math.round(g.length / 2);
  const vertical = g.orient === 'up' || g.orient === 'down';
  if (vertical) {
    const perp = clearance + Math.round(nameSize / 2) + thickness;
    return { text: name, pos: { x: g.pos.x - perp, y: g.orient === 'down' ? g.pos.y + half : g.pos.y - half }, size: nameSize, thickness, angle: 90, halign: 'center', valign: 'center' };
  }
  return {
    text: name,
    pos: { x: g.orient === 'left' ? g.pos.x - half : g.pos.x + half, y: g.pos.y - (maxHalfHeight + clearance + thickness) },
    size: nameSize,
    thickness,
    angle: 0,
    halign: 'center',
    valign: 'center',
  };
}

interface SymbolInfo {
  id: string;
  pos: Vec2;
  t: SymTransform;
  showPinNames: boolean;
  showPinNumbers: boolean;
  pinNameOffset: number;
  maxNameHalfHeight: number;
}

function pinItems(pin: SchPinLike, index: number, s: SymbolInfo, c: Ctx): { items: RenderItem[]; bbox: Box } {
  const pinKiid = kiid(pin.id) || `${index}`;
  const number = pin.number ?? '';
  const ref = `${s.id}:${number}`;
  const baseId = `${s.id}@pin:${pinKiid}`;
  const items: RenderItem[] = [];
  let layer = SCH_LAYERS.pin;
  let textLayers = { num: SCH_LAYERS.pinNumber, name: SCH_LAYERS.pinName };
  if (pin.visible === false) {
    if (!c.ctx.showHiddenPins) return { items, bbox: EMPTY_BOX };
    layer = SCH_LAYERS.hidden;
    textLayers = { num: SCH_LAYERS.hidden, name: SCH_LAYERS.hidden };
  }
  const libOrient = pinOrientationFromEnum(pin.orientation);
  const orient = pinDrawOrientation(libOrient, s.t);
  const rawPos = vec(pin.position);
  const pos = c.ctx.symbolPinsAbsolute === false ? vAdd(s.pos, { x: s.t.x1 * rawPos.x + s.t.y1 * rawPos.y, y: s.t.x2 * rawPos.x + s.t.y2 * rawPos.y }) : rawPos;
  const length = dist(pin.length);
  const root = vAdd(pos, vScale(pinDirection(orient), length));
  const g: PinGeom = { pos, root, orient, length };
  const numSize = dist(pin.numberTextSize) || c.d.pinTextSize;
  const nameSize = dist(pin.nameTextSize) || c.d.pinTextSize;
  const width = c.d.lineWidth;
  const body = pinBodyPrims(g, pinShapeName(pin.shape), isNoConnectPin(pin.electricalType), numSize, nameSize, width);
  const bbox = body.length ? boxOfPrimitives(body) : boxFromPoints([pos, root], width);
  items.push({ id: baseId, layer, prims: body, bbox, owner: c.owner, ref });
  const name = pin.name && pin.name !== '~' ? pin.name : '';
  const showName = s.showPinNames && !!name;
  const showNumber = s.showPinNumbers && !!number;
  const thickness = Math.min(width, Math.round(Math.min(numSize, nameSize) * 0.25));
  const textItem = (layout: PinTextLayout | undefined, suffix: 'number' | 'name', l: string): void => {
    if (!layout) return;
    const a: TextAttrs = { size: { x: layout.size, y: layout.size }, thickness: layout.thickness, angle: layout.angle, halign: layout.halign, valign: layout.valign };
    const prims = textPrims(`${s.id}:pin:${pinKiid}:${suffix}`, layout.text, layout.pos, a, c);
    if (prims.length) items.push(finish(`${baseId}:${suffix}`, l, prims, c, { ref, pickable: false }));
  };
  if (showNumber) textItem(pinNumberLayout(g, number, numSize, thickness, showName && s.pinNameOffset === 0, c), 'number', textLayers.num);
  if (showName) textItem(pinNameLayout(g, name, nameSize, thickness, s.pinNameOffset, s.maxNameHalfHeight, c), 'name', textLayers.name);
  return { items, bbox };
}

function convertSymbol(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const pos = vec(p.position as Vector2Like);
  const tr = p.transform as { orientation?: number | string; mirrorX?: boolean; mirrorY?: boolean } | undefined;
  const t = tr ? symbolTransform(tr.orientation, !!tr.mirrorX, !!tr.mirrorY) : { ...IDENTITY_TRANSFORM };
  const unit = (p.unit as { unit?: number } | undefined)?.unit || 1;
  const bodyStyle = (p.bodyStyle as { style?: number } | undefined)?.style || 1;
  const def = (p.definition ?? {}) as Record<string, unknown>;
  const children = ((def.items as SchSymbolChildLike[] | undefined) ?? []).filter((ch) => {
    if (ch.isPrivate) return false;
    const u = ch.unit?.unit;
    const bs = ch.bodyStyle?.style;
    return (!u || u === unit) && (!bs || bs === bodyStyle);
  });
  const decoded = children.map((ch) => schematicItemTypeOf(ch.item ?? ch, c.ctx)).filter((x): x is { type: string; proto: Record<string, unknown> } => !!x);
  const pins = decoded.filter((d) => d.type === 'KOT_SCH_PIN').map((d) => d.proto as SchPinLike);
  let maxNameHalfHeight = 0;
  for (const pin of pins) if (pin.name && pin.name !== '~') maxNameHalfHeight = Math.max(maxNameHalfHeight, Math.round((dist(pin.nameTextSize) || c.d.pinTextSize) / 2));
  const info: SymbolInfo = {
    id,
    pos,
    t,
    showPinNames: (p.showPinNames as boolean | undefined) ?? true,
    showPinNumbers: (p.showPinNumbers as boolean | undefined) ?? true,
    pinNameOffset: dist(p.pinNameOffset as DistanceLike),
    maxNameHalfHeight,
  };
  const out: RenderItem[] = [];
  const xf = (q: Primitive): Primitive => transformPrimitive(q, t, pos);
  let bodyBox = EMPTY_BOX;
  let pinsBox = EMPTY_BOX;
  decoded.forEach((d, i) => {
    const cid = kiid(d.proto.id as KiidLike) || `${i}`;
    switch (d.type) {
      case 'KOT_SCH_SHAPE': {
        const items = shapeItems(`${id}:shape:${cid}`, d.proto.shape as GraphicShapeLike, SCH_LAYERS.device, SCH_LAYERS.deviceBackground, c, xf, { ref: id, pickable: false });
        for (const it of items) bodyBox = boxUnion(bodyBox, it.bbox);
        out.push(...items);
        break;
      }
      case 'KOT_SCH_TEXT': {
        const txt = d.proto.text as SchTextLike | undefined;
        if (!txt) break;
        const a = readTextAttrs(txt.attributes, c.d);
        const tid = `${id}:text:${cid}`;
        const prims = hasServerShapes(tid, c) ? textPrims(tid, txt.text ?? '', vec(txt.position), a, c) : textPrims(tid, txt.text ?? '', vec(txt.position), a, c).map(xf);
        if (!prims.length) break;
        const it = finish(tid, SCH_LAYERS.device, prims, c, { ref: id, pickable: false, ...(a.color ? { color: a.color } : {}) });
        bodyBox = boxUnion(bodyBox, it.bbox);
        out.push(it);
        break;
      }
      case 'KOT_SCH_TEXTBOX': {
        const items = convertTextBox(d.proto, `${id}:textbox:${cid}`, c, SCH_LAYERS.device, SCH_LAYERS.deviceBackground, xf, { ref: id, pickable: false });
        for (const it of items) bodyBox = boxUnion(bodyBox, it.bbox);
        out.push(...items);
        break;
      }
      default:
        break; // pins below; library fields are replaced by the instance fields
    }
  });
  pins.forEach((pin, i) => {
    const r = pinItems(pin, i, info, c);
    out.push(...r.items);
    pinsBox = boxUnion(pinsBox, r.bbox);
  });
  // instance fields (reference / value / footprint / datasheet / description / user)
  const fieldLayer: Record<string, string> = { referenceField: SCH_LAYERS.reference, valueField: SCH_LAYERS.value, footprintField: SCH_LAYERS.fields, datasheetField: SCH_LAYERS.fields, descriptionField: SCH_LAYERS.fields };
  for (const key of Object.keys(fieldLayer)) {
    const f = p[key] as SchFieldLike | undefined;
    if (!f) continue;
    out.push(...fieldItems(f, c, { id: `${id}:field:${f.name || key}`, layer: fieldLayer[key]!, transform: t, origin: pos, ref: id, pickable: true }));
  }
  ((p.userFields as SchFieldLike[] | undefined) ?? []).forEach((f, i) => out.push(...fieldItems(f, c, { id: `${id}:field:${f.name || `user${i}`}`, layer: SCH_LAYERS.fields, transform: t, origin: pos, ref: id, pickable: true })));
  // DNP cross (SCH_PAINTER::draw(SCH_SYMBOL))
  const attrs = p.attributes as { doNotPopulate?: boolean; excludeFromSimulation?: boolean } | undefined;
  if (attrs?.doNotPopulate && (c.ctx.showDnpMarkers ?? true)) out.push(...dnpCross(bodyBox, boxUnion(bodyBox, pinsBox), c, id, id));
  // symbol body: bbox-only pick target after its children
  let bbox = boxUnion(bodyBox, pinsBox);
  if (boxIsEmpty(bbox)) bbox = boxFromPoints([pos], 1_000_000);
  out.push({ id, layer: SCH_LAYERS.device, prims: [], bbox, owner: c.owner, ref: id });
  return out;
}

/** A standalone SchematicPin item (identity transform, position as given). */
function convertStandalonePin(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const info: SymbolInfo = { id: c.owner, pos: { x: 0, y: 0 }, t: { ...IDENTITY_TRANSFORM }, showPinNames: true, showPinNumbers: true, pinNameOffset: 0, maxNameHalfHeight: Math.round((dist((p as SchPinLike).nameTextSize) || c.d.pinTextSize) / 2) };
  const r = pinItems({ ...(p as SchPinLike), id: { value: id } }, 0, info, c);
  return r.items;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function convert(type: string, proto: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  switch (type) {
    case 'KOT_SCH_LINE':
      return convertLine(proto as SchLineLike, id, c);
    case 'KOT_SCH_JUNCTION':
      return convertJunction(proto, id, c);
    case 'KOT_SCH_NO_CONNECT':
      return convertNoConnect(proto, id, c);
    case 'KOT_SCH_BUS_WIRE_ENTRY':
    case 'KOT_SCH_BUS_BUS_ENTRY':
      return convertBusEntry(proto, id, c);
    case 'KOT_SCH_TEXT':
      return convertText(proto, id, c);
    case 'KOT_SCH_TEXTBOX':
      return convertTextBox(proto, id, c);
    case 'KOT_SCH_SHAPE':
      return convertShape(proto, id, c);
    case 'KOT_SCH_RULE_AREA':
      return convertRuleArea(proto, id, c);
    case 'KOT_SCH_BITMAP':
      return convertImage(proto, id, c);
    case 'KOT_SCH_LABEL':
      return convertLocalLabel(proto, id, c);
    case 'KOT_SCH_GLOBAL_LABEL':
      return convertGlobalLabel(proto, id, c);
    case 'KOT_SCH_HIER_LABEL':
      return convertHierLabel(proto, id, c);
    case 'KOT_SCH_DIRECTIVE_LABEL':
      return convertDirectiveLabel(proto, id, c);
    case 'KOT_SCH_GROUP':
      return convertGroup(proto, id, c);
    case 'KOT_SCH_SHEET':
      return convertSheet(proto, id, c);
    case 'KOT_SCH_SHEET_PIN':
      return sheetPinItems({ ...(proto as SchSheetPinLike), id: { value: id } }, 0, c.owner, c);
    case 'KOT_SCH_SYMBOL':
      return convertSymbol(proto, id, c);
    case 'KOT_SCH_PIN':
      return convertStandalonePin(proto, id, c);
    case 'KOT_SCH_FIELD':
      return fieldItems(proto as SchFieldLike, c, { id, layer: SCH_LAYERS.fields });
    case 'KOT_SCH_TABLE':
      return convertTable(proto, id, c);
    default:
      return []; // markers, table cells, unknown
  }
}

/**
 * Convert one store item (or a plain `{ id, type, proto }`) into render items. `item.type`
 * is the KOT_SCH_* name; when absent it is derived from `proto.$typeName`.
 */
export function schematicItemToRenderItems(item: StoredItemLike, ctx: SchematicAdapterContext = {}): RenderItem[] {
  const proto = (item.proto ?? {}) as Record<string, unknown>;
  const type = item.type || schematicItemTypeOf(proto, ctx)?.type || '';
  const id = item.id || kiid(proto.id as KiidLike);
  return convert(type, proto, id, { ctx, d: defaultsOf(ctx), owner: id });
}

/** The pin number part of a pin pick ref (`<symbol kiid>:<pin number>`), or undefined. */
export function pinRefParts(ref: string): { symbol: string; pin: string } | undefined {
  const i = ref.indexOf(':');
  if (i < 0) return undefined;
  return { symbol: ref.slice(0, i), pin: ref.slice(i + 1) };
}

export type { TextGlyphsPrimitive };
export { transformTextGlyphs };
