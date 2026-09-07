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
import { EMPTY_BOX, boxFromPoints, boxOfPrimitives, boxUnion, boxIsEmpty, vAdd, vRotate, vScale, vSub } from '../core/model.js';
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
  stripTextBoxBorder,
  strokedPolyline,
  textBoxCorners,
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
import { type HAlign, type TextAttrs, type VAlign, flipHAlign, flipVAlign, halignFromEnum, textBlockExtents, textGlyphPrims, valignFromEnum } from './textMetrics.js';
import {
  type PinOrientation,
  type SymTransform,
  IDENTITY_TRANSFORM,
  pinDirection,
  pinDrawOrientation,
  pinOrientationFromEnum,
  symbolTransform,
  toSheet,
  transformCoordinate,
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
   * return the protobuf-es message (with `$typeName`), e.g. `unpackAny` from @fp-pcb/proto.
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
  /**
   * Pin-name offset (nm, inside the body) to assume when a symbol instance reports 0.
   * `SchematicSymbolInstance.pin_name_offset` is serialised from `SYMBOL::m_pinNameOffset` of the
   * SCH_SYMBOL, which KiCad never fills in from the library symbol (the painter and plotter use
   * the LIB_SYMBOL's, default 20 mil), so the message says 0 for every placed symbol. Unset =
   * honour the message (names outside).
   */
  assumePinNameOffset?: number;
  /**
   * `LIB_SYMBOL::SubReference` settings for multi-unit references (`U2` -> `U2A`): the first
   * unit id (default `A`; a digit counts units from that digit) and the separator (default none).
   */
  subpartFirstId?: string;
  subpartIdSeparator?: string;
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

export function defaultsOf(ctx: SchematicAdapterContext): SchematicDefaults {
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

/**
 * `EDA_TEXT::GetEffectiveTextPenWidth( aDefault )`: the stored thickness (× 1.6 when bold), else
 * the bold pen (size / 5), else `aDefault`, else size / 8; clamped to a quarter of the size.
 * The plotter passes the schematic's default line width; `GetTextBox` passes 0.
 */
export function effectivePenWidth(a: SchTextAttributesLike | undefined, size: Vec2, defaultPen: number): number {
  const bold = !!a?.bold;
  let thickness = dist(a?.strokeWidth);
  if (thickness <= 1) {
    thickness = defaultPen;
    if (bold) thickness = Math.round(size.x / 5);
    else if (thickness <= 1) thickness = Math.round(size.x / 8);
  } else if (bold) thickness = Math.round(thickness * 1.6); // BOLD_STROKE_MULTIPLIER
  return Math.min(thickness, Math.round(Math.min(size.x, size.y) * 0.25)); // ClampTextPenSize
}

export function readTextSize(a: SchTextAttributesLike | undefined, d: SchematicDefaults): Vec2 {
  const sx = nm(a?.size?.xNm);
  const sy = nm(a?.size?.yNm);
  return { x: sx || sy || d.textSize, y: sy || sx || d.textSize };
}

/** Text attributes the way the plotter draws them: pen width defaulted to the schematic line width. */
export function readTextAttrs(a: SchTextAttributesLike | undefined, d: SchematicDefaults): TextAttrs & { color?: ThemeColor } {
  const size = readTextSize(a, d);
  return {
    size,
    thickness: effectivePenWidth(a, size, d.lineWidth),
    angle: deg(a?.angle),
    halign: halignFromEnum(a?.horizontalAlignment, 'left'),
    valign: valignFromEnum(a?.verticalAlignment, 'bottom'),
    mirrored: !!a?.mirrored,
    bold: !!a?.bold,
    italic: !!a?.italic,
    lineSpacing: a?.lineSpacing || 1,
    color: colorOf(a?.color),
  };
}

/** `SCH_TEXT::GetSchematicTextOffset`: plain text is drawn 0.25 mm (2500 schematic IU) above its position ("fudge factor to match KiCad 6"). */
export const SCH_TEXT_OFFSET: Readonly<Vec2> = Object.freeze({ x: 0, y: -250_000 });

const lineStyleOf = (s: SchStrokeLike | undefined): string => enumName('StrokeLineStyle', s?.style);

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Conversion state for one store item: the adapter context, resolved defaults and the owning item id. */
export interface Ctx {
  ctx: SchematicAdapterContext;
  d: SchematicDefaults;
  owner: string;
}

export function makeCtx(ctx: SchematicAdapterContext, owner: string): Ctx {
  return { ctx, d: defaultsOf(ctx), owner };
}

function finish(id: string, layer: string, prims: Primitive[], c: Ctx, extra: Partial<RenderItem> = {}): RenderItem {
  return { id, layer, prims, bbox: boxOfPrimitives(prims), owner: c.owner, ref: id, ...extra };
}

/**
 * Text as server shapes (when supplied) or text-glyphs primitives at `pos`. `box` is the text
 * box a `textbox` request was made for: GetTextAsShapes appends its four edges as segments
 * whatever `border_enabled` says, and the border is drawn from the item's own stroke instead.
 */
function textPrims(textId: string, text: string, pos: Vec2, a: TextAttrs, c: Ctx, box?: TextBoxLike): Primitive[] {
  const shapes = c.ctx.textShapes?.(textId);
  const server = shapes?.length ? (box ? stripTextBoxBorder(shapes, textBoxCorners(box)) : shapes) : undefined;
  if (server?.length) return textShapesToPrims(server, { arcTolerance: c.ctx.arcTolerance });
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
  const prims = textPrims(id, t.text ?? '', vAdd(vec(t.position), SCH_TEXT_OFFSET), a, c);
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
  out.text = textPrims(textId, tb.text ?? '', pos, a, c, tb);
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
  /** added to the field position (global-label fields: `GetSchematicTextOffset`) */
  offset?: Vec2;
  /** `sheetfile` prefixes the value with `File: ` unless the name is shown */
  kind?: 'field' | 'sheetfile';
  pickable?: boolean;
  ref?: string;
}

/**
 * The string a field shows (`SCH_FIELD::GetShownText( aAllowExtraText = true )`): `Name: value`
 * when `show_name` is set, and `File: value` for a sheet's file field otherwise. Empty when
 * hidden / private / empty.
 */
export function fieldShownText(f: SchFieldLike | undefined, showHidden = false, kind: 'field' | 'sheetfile' = 'field'): string {
  if (!f?.text || f.isPrivate) return '';
  if (f.visible === false && !showHidden) return '';
  const text = f.text.text ?? '';
  if (!text) return '';
  if (f.showName && f.name) return `${f.name}: ${text}`;
  return kind === 'sheetfile' ? `File: ${text}` : text;
}

/**
 * Text variables a sheet resolves from its own fields (`SCH_SHEET::ResolveTextVar`: `${Sheetname}`,
 * `${Sheetfile}`, `${<user field>}`), the way its pins' `GetShownText` does. Other variables
 * (project, `${#}`, `${REF:...}`) stay as written: the API carries the raw text only.
 */
export function sheetTextVars(p: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  const add = (f: SchFieldLike | undefined, fallback: string): void => {
    if (f?.text?.text !== undefined) vars[f.name || fallback] = f.text.text;
  };
  add(p.nameField as SchFieldLike | undefined, 'Sheetname');
  add(p.filenameField as SchFieldLike | undefined, 'Sheetfile');
  for (const f of (p.userFields as SchFieldLike[] | undefined) ?? []) add(f, '');
  return vars;
}

export function expandTextVars(text: string, vars: Record<string, string> | undefined): string {
  if (!vars || !text.includes('${')) return text;
  return text.replace(/\$\{([^}]+)\}/g, (m, name: string) => vars[name] ?? m);
}

export interface FieldPlacement {
  /** anchor to draw the text at, sheet coordinates */
  pos: Vec2;
  /** `SCH_FIELD::GetDrawRotation`: horizontal <-> vertical swapped when the transform turns the axes */
  angle: number;
  halign: HAlign;
  valign: VAlign;
  /**
   * True when drawing `text` justified at `pos` reproduces KiCad exactly. KiCad plots symbol
   * fields centred on `GetBoundingBox().Centre()`; for a vertically centred, upright field that
   * centre can be written without knowing the text width (see below), otherwise the box must be
   * measured (`GetTextExtents`) and `measured()` used.
   */
  exact: boolean;
}

/**
 * Where eeschema draws a symbol field (`SCH_FIELD::Plot` / `SCH_PAINTER::draw( SCH_FIELD )`): the
 * text is centred on the centre of `SCH_FIELD::GetBoundingBox()` -- the field's own text box in
 * the untransformed frame, pushed through the symbol transform -- at `GetDrawRotation()`, so it
 * stays readable on mirrored and rotated symbols.
 *
 * For a vertically centred upright field the centre is `pos' + d · (±(W/2 + ρ))` with W the glyph
 * advance width, ρ = round(1.5 · boxPen) (`FONT::StringBoundaryLimits` inflates the advance box
 * by that much) and d the transformed reading direction; drawing the same string justified
 * left / right places its glyphs at `anchor + d' · (offsetX)` / `anchor − d' · (W + offsetX)`
 * with offsetX = trunc(plotPen / 1.52) (`FONT::getLinePositions`). Both contain W, and it
 * cancels: a justified draw at `pos' + d · δ` (δ = ρ − offsetX for a left-justified field,
 * −δ for right, 0 for centre), justification flipped when d' = −d, is pixel-identical to
 * KiCad's centred draw. Italic and top / bottom justified fields need the measured box.
 *
 * @param a       the stored attributes (plot pen width in `thickness`)
 * @param pos     stored field position (untransformed frame, absolute)
 * @param boxPen  `GetEffectiveTextPenWidth()` with default 0, the pen `GetTextBox` uses
 */
export function symbolFieldPlacement(a: TextAttrs, pos: Vec2, t: SymTransform, origin: Vec2, boxPen: number): FieldPlacement {
  const posT = toSheet(t, vSub(pos, origin), origin);
  const phi = ((a.angle % 360) + 360) % 360;
  const horizontal = Math.abs(phi % 180) < 1e-6;
  const angle = t.y1 !== 0 ? (horizontal ? 90 : 0) : phi;
  const d = transformCoordinate(t, vRotate({ x: 1, y: 0 }, phi));
  const dDraw = vRotate({ x: 1, y: 0 }, angle);
  const flip = d.x * dDraw.x + d.y * dDraw.y < 0;
  const rho = Math.round(1.5 * boxPen);
  const offsetX = Math.trunc(a.thickness / 1.52);
  const delta = a.halign === 'left' ? rho - offsetX : a.halign === 'right' ? offsetX - rho : 0;
  const exact = a.valign === 'center' && !a.italic && !a.mirrored;
  return { pos: vAdd(posT, vScale(d, delta)), angle, halign: flip ? flipHAlign(a.halign) : a.halign, valign: 'center', exact };
}

/**
 * The centred placement from a measured text box (`GetTextExtents` of the field at its stored
 * position and attributes = `EDA_TEXT::GetTextBox` rotated about the position): the box centre
 * through the symbol transform, drawn centred at `GetDrawRotation()`.
 */
export function symbolFieldPlacementFromBox(a: TextAttrs, pos: Vec2, t: SymTransform, origin: Vec2, box: Box): FieldPlacement {
  const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const posT = toSheet(t, vSub(pos, origin), origin);
  const phi = ((a.angle % 360) + 360) % 360;
  const horizontal = Math.abs(phi % 180) < 1e-6;
  const angle = t.y1 !== 0 ? (horizontal ? 90 : 0) : phi;
  return { pos: vAdd(posT, transformCoordinate(t, vSub(centre, pos))), angle, halign: 'center', valign: 'center', exact: true };
}

/** A SchematicField as text. Returns [] when hidden / empty. */
function fieldItems(f: SchFieldLike | undefined, c: Ctx, o: FieldOpts): RenderItem[] {
  const text = fieldShownText(f, !!c.ctx.showHiddenFields, o.kind);
  if (!text || !f?.text) return [];
  const layer = f.visible === false ? SCH_LAYERS.hidden : o.layer;
  const a = readTextAttrs(f.text.attributes, c.d);
  const absPos = vAdd(vec(f.text.position), o.offset ?? { x: 0, y: 0 });
  let prims: Primitive[];
  if (o.transform && o.origin && !hasServerShapes(o.id, c)) {
    const placed = symbolFieldPlacement(a, absPos, o.transform, o.origin, effectivePenWidth(f.text.attributes, a.size, 0));
    prims = textPrims(o.id, text, placed.pos, { ...a, angle: placed.angle, halign: placed.halign, valign: placed.valign }, c);
  } else {
    prims = textPrims(o.id, text, absPos, a, c);
  }
  if (!prims.length) return [];
  return [finish(o.id, layer, prims, c, { ref: o.ref ?? o.id, pickable: o.pickable, ...(a.color ? { color: a.color } : {}) })];
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface LabelBase {
  /** the label position (shape anchor) */
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

/** Label fields: `<label>:field:<name>`, plus the intersheet refs. Only global labels shift them (`SCH_FIELD::Plot`). */
export function labelFieldRefs(p: Record<string, unknown>, id: string): Array<{ key: string; field: SchFieldLike }> {
  const out: Array<{ key: string; field: SchFieldLike }> = [];
  ((p.fields as SchFieldLike[] | undefined) ?? []).forEach((f, i) => out.push({ key: `${id}:field:${f.name || i}`, field: f }));
  const isr = p.intersheetRefsField as SchFieldLike | undefined;
  if (isr) out.push({ key: `${id}:field:${isr.name || 'Intersheetrefs'}`, field: isr });
  return out;
}

function labelFields(p: Record<string, unknown>, id: string, c: Ctx, layer: string, offset?: Vec2): RenderItem[] {
  const out: RenderItem[] = [];
  for (const { key, field } of labelFieldRefs(p, id)) out.push(...fieldItems(field, c, { id: key, layer, ref: id, pickable: true, offset }));
  return out;
}

export type LabelKind = 'local' | 'global' | 'hier';

export interface LabelTextLayout extends LabelBase {
  /** text anchor: the label position plus `GetSchematicTextOffset` */
  anchor: Vec2;
  shape: LabelShape;
  /** the offset applied to a global label's fields as well (`SCH_FIELD::Plot`) */
  fieldOffset?: Vec2;
}

/** `SCH_LABEL_BASE::Plot`: the label text at `GetTextPos() + GetSchematicTextOffset()` with the spin style's angle / justification. */
export function labelTextLayout(kind: LabelKind, p: Record<string, unknown>, c: Ctx): LabelTextLayout {
  switch (kind) {
    case 'local': {
      const l = labelBase(p, c, 'bottom');
      return { ...l, anchor: vAdd(l.pos, localLabelTextOffset(l.a.size.y, l.penWidth, l.spin, c.d.textOffsetRatio)), shape: 'input' };
    }
    case 'global': {
      const l = labelBase(p, c, 'center');
      const shape = labelShapeFromEnum(p.shape as number | string, 'input');
      const off = globalLabelTextOffset(l.a.size.y, shape, l.spin);
      return { ...l, anchor: vAdd(l.pos, off), shape, fieldOffset: off };
    }
    case 'hier': {
      const l = labelBase(p, c, 'center');
      const shape = labelShapeFromEnum(p.shape as number | string, 'input');
      return { ...l, anchor: vAdd(l.pos, hierLabelTextOffset(l.a.size.y, l.a.size.x, l.spin, c.d.textOffsetRatio)), shape };
    }
  }
}

function convertLocalLabel(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const l = labelTextLayout('local', p, c);
  const prims = textPrims(id, l.text, l.anchor, l.a, c);
  const out: RenderItem[] = [];
  if (prims.length) out.push(finish(id, SCH_LAYERS.labelLocal, prims, c, { bbox: boxUnion(boxOfPrimitives(prims), boxFromPoints([l.pos])), ...(l.a.color ? { color: l.a.color } : {}) }));
  out.push(...labelFields(p, id, c, SCH_LAYERS.fields));
  return out;
}

function convertGlobalLabel(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const l = labelTextLayout('global', p, c);
  const textWidth = textBlockExtents(l.text, l.a).w;
  const outline = globalLabelShape(l.pos, l.a.size.y, textWidth, l.penWidth, l.shape, l.spin);
  const prims: Primitive[] = polyline(outline, l.penWidth);
  prims.push(...textPrims(id, l.text, l.anchor, l.a, c));
  const out: RenderItem[] = [finish(id, SCH_LAYERS.labelGlobal, prims, c, l.a.color ? { color: l.a.color } : {})];
  out.push(...labelFields(p, id, c, SCH_LAYERS.fields, l.fieldOffset));
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
  const l = labelTextLayout('hier', p, c);
  const outline = hierLabelShape(l.pos, l.a.size.y, l.shape, l.spin);
  const out = flagItems(id, SCH_LAYERS.labelHier, outline, l.anchor, l, c);
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

export interface SheetPinLayout extends LabelTextLayout {
  /** textShapes key / render item id: `<sheet>:pin:<pin kiid>` */
  key: string;
  pinId: string;
}

/**
 * A sheet pin is a hierarchical label (`SCH_SHEET_PIN` : `SCH_HIERLABEL`) whose spin style follows
 * the sheet side; `vars` (`sheetTextVars`) resolves `${field}` in its text as KiCad's shown text does.
 */
export function sheetPinLayout(pin: SchSheetPinLike, index: number, sheetId: string, c: Ctx, vars?: Record<string, string>): SheetPinLayout {
  const pinId = kiid(pin.id) || `${sheetId}:pin${index}`;
  const t = pin.text ?? {};
  const a = readTextAttrs(t.attributes, c.d);
  const spin = spinStyleFromEnum(pin.spinStyle) ?? sheetSideSpin(pin.side) ?? spinStyleFromText(a.angle, a.halign);
  const st = spinTextAttrs(spin);
  a.angle = st.angle;
  a.halign = st.halign;
  a.valign = 'center';
  const pos = pin.position ? vec(pin.position) : vec(t.position);
  const shape = labelShapeFromEnum(pin.shape, 'input');
  return { key: `${sheetId}:pin:${pinId}`, pinId, pos, text: expandTextVars(t.text ?? '', vars), a, spin, penWidth: a.thickness, anchor: vAdd(pos, hierLabelTextOffset(a.size.y, a.size.x, spin, c.d.textOffsetRatio)), shape };
}

function sheetPinItems(pin: SchSheetPinLike, index: number, sheetId: string, c: Ctx, vars?: Record<string, string>): RenderItem[] {
  const l = sheetPinLayout(pin, index, sheetId, c, vars);
  const outline = sheetPinShape(l.pos, l.a.size.y, l.shape, l.spin);
  return flagItems(l.key, SCH_LAYERS.sheetLabel, outline, l.anchor, l, c, { ref: l.pinId });
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
  out.push(...fieldItems(fileField, c, { id: `${id}:field:${fileField?.name || 'Sheetfile'}`, layer: SCH_LAYERS.sheetFilename, ref: id, pickable: true, kind: 'sheetfile' }));
  ((p.userFields as SchFieldLike[] | undefined) ?? []).forEach((f, i) => out.push(...fieldItems(f, c, { id: `${id}:field:${f.name || i}`, layer: SCH_LAYERS.sheetFields, ref: id, pickable: true })));
  const vars = sheetTextVars(p);
  ((p.pins as SchSheetPinLike[] | undefined) ?? []).forEach((pin, i) => out.push(...sheetPinItems(pin, i, id, c, vars)));
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

export interface PinGeom {
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

export interface PinTextLayout {
  text: string;
  pos: Vec2;
  size: number;
  thickness: number;
  angle: number;
  halign: HAlign;
  valign: VAlign;
}

export interface SchPinAlternateLike {
  name?: string;
  shape?: number | string;
  electricalType?: number | string;
}

/**
 * What a pin shows: `SCH_PIN::GetShownName` returns the active alternate's name (and the
 * alternate's shape / electrical type replace the pin's); a name of `~` is empty.
 */
export function pinShown(pin: SchPinLike & { alternates?: SchPinAlternateLike[]; activeAlternate?: string }): { name: string; number: string; shape: number | string | undefined; electricalType: number | string | undefined } {
  const alt = pin.activeAlternate ? (pin.alternates ?? []).find((a) => a.name === pin.activeAlternate) : undefined;
  const raw = alt?.name ?? pin.name ?? '';
  return { name: raw === '~' ? '' : raw, number: pin.number ?? '', shape: alt?.shape ?? pin.shape, electricalType: alt?.electricalType ?? pin.electricalType };
}

/**
 * `SCH_PIN::PlotPinTexts`: where the name and the number go, for the pin's draw orientation.
 * `inside` is the symbol's `pin_name_offset`; 0 puts the name outside above the pin (and the
 * number below it). Anchors sit `name_offset` = text offset + PIN_TEXT_MARGIN + pen width off the
 * pin line, bottom- / top-justified, so the same string laid out by the stroke font lands where
 * the plotter (and, for single-line text, `PIN_LAYOUT_CACHE`) puts it. `penWidth` is the
 * schematic's default pen (the plotter uses it unclamped). Stacked numbers (`[1,2,3]`) are
 * plotted single-line when they fit along the pin and as a braced column otherwise -- that
 * decision needs KiCad's font metrics, so they are laid out single-line here.
 */
export function pinTextLayouts(g: PinGeom, name: string, number: string, numSize: number, nameSize: number, penWidth: number, inside: number, d: SchematicDefaults): { number?: PinTextLayout; name?: PinTextLayout } {
  const drawName = !!name && nameSize > 0;
  const drawNum = !!number && numSize > 0;
  const out: { number?: PinTextLayout; name?: PinTextLayout } = {};
  if (!drawName && !drawNum) return out;
  const offset = Math.round(24 * d.textOffsetRatio) * MIL + SCH_DEFAULTS.pinTextMargin + penWidth; // name_offset == num_offset
  const x1 = g.root.x;
  const y1 = g.root.y;
  const mk = (text: string, pos: Vec2, size: number, angle: number, halign: HAlign, valign: VAlign): PinTextLayout => ({ text, pos, size, thickness: penWidth, angle, halign, valign });
  const horizontal = g.orient === 'left' || g.orient === 'right';
  const midX = Math.trunc((x1 + g.pos.x) / 2);
  const midY = Math.trunc((y1 + g.pos.y) / 2);
  if (inside > 0) {
    if (horizontal) {
      if (drawName) out.name = g.orient === 'right' ? mk(name, { x: x1 + inside, y: y1 }, nameSize, 0, 'left', 'center') : mk(name, { x: x1 - inside, y: y1 }, nameSize, 0, 'right', 'center');
      if (drawNum) out.number = mk(number, { x: midX, y: y1 - offset }, numSize, 0, 'center', 'bottom');
    } else {
      if (drawName) out.name = g.orient === 'down' ? mk(name, { x: x1, y: y1 + inside }, nameSize, 90, 'right', 'center') : mk(name, { x: x1, y: y1 - inside }, nameSize, 90, 'left', 'center');
      if (drawNum) out.number = mk(number, { x: x1 - offset, y: midY }, numSize, 90, 'center', 'bottom');
    }
  } else if (horizontal) {
    if (drawName) out.name = mk(name, { x: midX, y: y1 - offset }, nameSize, 0, 'center', 'bottom');
    if (drawNum) out.number = drawName ? mk(number, { x: midX, y: y1 + offset }, numSize, 0, 'center', 'top') : mk(number, { x: midX, y: y1 - offset }, numSize, 0, 'center', 'bottom');
  } else {
    if (drawName) out.name = mk(name, { x: x1 - offset, y: midY }, nameSize, 90, 'center', 'bottom');
    if (drawNum) out.number = drawName ? mk(number, { x: x1 + offset, y: midY }, numSize, 90, 'center', 'top') : mk(number, { x: x1 - offset, y: midY }, numSize, 90, 'center', 'bottom');
  }
  return out;
}

export interface SymbolInfo {
  id: string;
  pos: Vec2;
  t: SymTransform;
  showPinNames: boolean;
  showPinNumbers: boolean;
  pinNameOffset: number;
}

export interface PinLayout {
  pinKiid: string;
  geom: PinGeom;
  numSize: number;
  nameSize: number;
  shown: ReturnType<typeof pinShown>;
  texts: { number?: PinTextLayout; name?: PinTextLayout };
  hidden: boolean;
}

/** Geometry and text placement of one symbol pin (sheet coordinates). Undefined when hidden and hidden pins are not shown. */
export function pinLayout(pin: SchPinLike, index: number, s: SymbolInfo, c: Ctx): PinLayout | undefined {
  const hidden = pin.visible === false;
  if (hidden && !c.ctx.showHiddenPins) return undefined;
  const libOrient = pinOrientationFromEnum(pin.orientation);
  const orient = pinDrawOrientation(libOrient, s.t);
  const rawPos = vec(pin.position);
  const pos = c.ctx.symbolPinsAbsolute === false ? vAdd(s.pos, { x: s.t.x1 * rawPos.x + s.t.y1 * rawPos.y, y: s.t.x2 * rawPos.x + s.t.y2 * rawPos.y }) : rawPos;
  const length = dist(pin.length);
  const root = vAdd(pos, vScale(pinDirection(orient), length));
  const shown = pinShown(pin);
  const numSize = dist(pin.numberTextSize) || c.d.pinTextSize;
  const nameSize = dist(pin.nameTextSize) || c.d.pinTextSize;
  const geom: PinGeom = { pos, root, orient, length };
  const texts = pinTextLayouts(geom, s.showPinNames ? shown.name : '', s.showPinNumbers ? shown.number : '', numSize, nameSize, c.d.lineWidth, s.pinNameOffset, c.d);
  return { pinKiid: kiid(pin.id) || `${index}`, geom, numSize, nameSize, shown, texts, hidden };
}

function pinItems(pin: SchPinLike, index: number, s: SymbolInfo, c: Ctx): { items: RenderItem[]; bbox: Box } {
  const items: RenderItem[] = [];
  const l = pinLayout(pin, index, s, c);
  if (!l) return { items, bbox: EMPTY_BOX };
  const ref = `${s.id}:${l.shown.number}`;
  const baseId = `${s.id}@pin:${l.pinKiid}`;
  const layer = l.hidden ? SCH_LAYERS.hidden : SCH_LAYERS.pin;
  const textLayers = l.hidden ? { num: SCH_LAYERS.hidden, name: SCH_LAYERS.hidden } : { num: SCH_LAYERS.pinNumber, name: SCH_LAYERS.pinName };
  const width = c.d.lineWidth;
  const body = pinBodyPrims(l.geom, pinShapeName(l.shown.shape), isNoConnectPin(l.shown.electricalType), l.numSize, l.nameSize, width);
  const bbox = body.length ? boxOfPrimitives(body) : boxFromPoints([l.geom.pos, l.geom.root], width);
  items.push({ id: baseId, layer, prims: body, bbox, owner: c.owner, ref });
  const textItem = (layout: PinTextLayout | undefined, suffix: 'number' | 'name', lay: string): void => {
    if (!layout) return;
    const a: TextAttrs = { size: { x: layout.size, y: layout.size }, thickness: layout.thickness, angle: layout.angle, halign: layout.halign, valign: layout.valign };
    const prims = textPrims(`${s.id}:pin:${l.pinKiid}:${suffix}`, layout.text, layout.pos, a, c);
    if (prims.length) items.push(finish(`${baseId}:${suffix}`, lay, prims, c, { ref, pickable: false }));
  };
  textItem(l.texts.number, 'number', textLayers.num);
  textItem(l.texts.name, 'name', textLayers.name);
  return { items, bbox };
}

export interface SymbolParts {
  info: SymbolInfo;
  /** decoded, unit / body-style filtered children (pins included), with their child ids */
  children: Array<{ type: string; proto: Record<string, unknown>; cid: string }>;
  pins: SchPinLike[];
  /** instance fields with their textShapes keys and layers */
  fields: Array<{ key: string; field: SchFieldLike; layer: string }>;
}

/** The pieces of a SchematicSymbolInstance the renderer draws: transform, visible children, pins, instance fields. */
export function symbolParts(p: Record<string, unknown>, id: string, c: Ctx): SymbolParts {
  const pos = vec(p.position as Vector2Like);
  const tr = p.transform as { orientation?: number | string; mirrorX?: boolean; mirrorY?: boolean } | undefined;
  const t = tr ? symbolTransform(tr.orientation, !!tr.mirrorX, !!tr.mirrorY) : { ...IDENTITY_TRANSFORM };
  const unit = (p.unit as { unit?: number } | undefined)?.unit || 1;
  const bodyStyle = (p.bodyStyle as { style?: number } | undefined)?.style || 1;
  const def = (p.definition ?? {}) as Record<string, unknown>;
  const filtered = ((def.items as SchSymbolChildLike[] | undefined) ?? []).filter((ch) => {
    if (ch.isPrivate) return false;
    const u = ch.unit?.unit;
    const bs = ch.bodyStyle?.style;
    return (!u || u === unit) && (!bs || bs === bodyStyle);
  });
  const children = filtered
    .map((ch) => schematicItemTypeOf(ch.item ?? ch, c.ctx))
    .filter((x): x is { type: string; proto: Record<string, unknown> } => !!x)
    .map((d, i) => ({ ...d, cid: kiid(d.proto.id as KiidLike) || `${i}` }));
  const pins = children.filter((d) => d.type === 'KOT_SCH_PIN').map((d) => d.proto as SchPinLike);
  const info: SymbolInfo = {
    id,
    pos,
    t,
    showPinNames: (p.showPinNames as boolean | undefined) ?? true,
    showPinNumbers: (p.showPinNumbers as boolean | undefined) ?? true,
    pinNameOffset: dist(p.pinNameOffset as DistanceLike) || (c.ctx.assumePinNameOffset ?? 0),
  };
  const fields: SymbolParts['fields'] = [];
  const fieldLayer: Record<string, string> = { referenceField: SCH_LAYERS.reference, valueField: SCH_LAYERS.value, footprintField: SCH_LAYERS.fields, datasheetField: SCH_LAYERS.fields, descriptionField: SCH_LAYERS.fields };
  const unitCount = Number(def.unitCount ?? 1);
  for (const key of Object.keys(fieldLayer)) {
    let f = p[key] as SchFieldLike | undefined;
    if (!f) continue;
    // SCH_FIELD::GetShownText of the reference: GetRef( sheet, true ) appends the unit letter
    if (key === 'referenceField' && unitCount > 1 && f.text?.text) f = { ...f, text: { ...f.text, text: f.text.text + subReference(unit, c.ctx.subpartFirstId, c.ctx.subpartIdSeparator) } };
    fields.push({ key: `${id}:field:${f.name || key}`, field: f, layer: fieldLayer[key]! });
  }
  ((p.userFields as SchFieldLike[] | undefined) ?? []).forEach((f, i) => fields.push({ key: `${id}:field:${f.name || `user${i}`}`, field: f, layer: SCH_LAYERS.fields }));
  return { info, children, pins, fields };
}

/** `LIB_SYMBOL::SubReference`: `A`, `B`, ... `Z`, `AA`, ... (or digits from `firstId`), after the separator. */
export function subReference(unit: number, firstId = 'A', separator = ''): string {
  if (firstId >= '0' && firstId <= '9') return separator + String(unit);
  const base = firstId.charCodeAt(0);
  let suffix = '';
  let n = unit;
  do {
    const u = (n - 1) % 26;
    suffix = String.fromCharCode(base + u) + suffix;
    n = Math.floor((n - u) / 26); // integer division, as in KiCad
  } while (n > 0);
  return separator + suffix;
}

/**
 * `SCH_TEXT::Plot` for a library text inside a symbol (LAYER_DEVICE): the position goes through
 * the transform; the angle is swapped when the transform turns the axes, the horizontal
 * justification is flipped when the reading direction is reversed, and the vertical one when a
 * mirror would stack the lines the other way round.
 */
export function symbolTextPlacement(a: TextAttrs, pos: Vec2, t: SymTransform, origin: Vec2): { pos: Vec2; angle: number; halign: HAlign; valign: VAlign } {
  const origHoriz = Math.abs((((a.angle % 360) + 360) % 360) % 180) < 1e-6;
  const screenHoriz = (t.x1 !== 0) !== !origHoriz;
  const flipH = origHoriz ? (screenHoriz ? t.x1 < 0 : t.x2 > 0) : screenHoriz ? t.y1 > 0 : t.y2 < 0;
  const det = t.x1 * t.y2 - t.x2 * t.y1;
  const flipV = det < 0 && origHoriz === t.x1 > 0;
  return { pos: toSheet(t, pos, origin), angle: screenHoriz ? 0 : 90, halign: flipH ? flipHAlign(a.halign) : a.halign, valign: flipV ? flipVAlign(a.valign) : a.valign };
}

/** `SCH_TEXTBOX::Plot` inside a symbol: the box corners go through the transform and the angle is swapped when it turns the axes. */
export function symbolTextBoxProto(p: Record<string, unknown>, t: SymTransform, origin: Vec2): Record<string, unknown> {
  const tb = p.textbox as TextBoxLike | undefined;
  if (!tb) return p;
  const a = toSheet(t, vec(tb.topLeft), origin);
  const b = toSheet(t, vec(tb.bottomRight), origin);
  const angle = deg(tb.attributes?.angle);
  const horizontal = Math.abs((((angle % 360) + 360) % 360) % 180) < 1e-6;
  const attributes = t.y1 !== 0 ? { ...(tb.attributes ?? {}), angle: { valueDegrees: horizontal ? 90 : 0 } } : tb.attributes;
  return { ...p, textbox: { ...tb, topLeft: { xNm: Math.min(a.x, b.x), yNm: Math.min(a.y, b.y) }, bottomRight: { xNm: Math.max(a.x, b.x), yNm: Math.max(a.y, b.y) }, attributes } };
}

function convertSymbol(p: Record<string, unknown>, id: string, c: Ctx): RenderItem[] {
  const { info, children, pins, fields } = symbolParts(p, id, c);
  const { pos, t } = info;
  const out: RenderItem[] = [];
  const xf = (q: Primitive): Primitive => transformPrimitive(q, t, pos);
  let bodyBox = EMPTY_BOX;
  let pinsBox = EMPTY_BOX;
  for (const d of children) {
    const cid = d.cid;
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
        const placed = symbolTextPlacement(a, vec(txt.position), t, pos);
        const prims = textPrims(tid, txt.text ?? '', placed.pos, { ...a, angle: placed.angle, halign: placed.halign, valign: placed.valign }, c);
        if (!prims.length) break;
        const it = finish(tid, SCH_LAYERS.device, prims, c, { ref: id, pickable: false, ...(a.color ? { color: a.color } : {}) });
        bodyBox = boxUnion(bodyBox, it.bbox);
        out.push(it);
        break;
      }
      case 'KOT_SCH_TEXTBOX': {
        // the box is laid out in sheet coordinates (like the `textbox` request for it), so no primitive transform
        const items = convertTextBox(symbolTextBoxProto(d.proto, t, pos), `${id}:textbox:${cid}`, c, SCH_LAYERS.device, SCH_LAYERS.deviceBackground, undefined, { ref: id, pickable: false });
        for (const it of items) bodyBox = boxUnion(bodyBox, it.bbox);
        out.push(...items);
        break;
      }
      default:
        break; // pins below; library fields are replaced by the instance fields
    }
  }
  pins.forEach((pin, i) => {
    const r = pinItems(pin, i, info, c);
    out.push(...r.items);
    pinsBox = boxUnion(pinsBox, r.bbox);
  });
  // instance fields (reference / value / footprint / datasheet / description / user)
  for (const f of fields) out.push(...fieldItems(f.field, c, { id: f.key, layer: f.layer, transform: t, origin: pos, ref: id, pickable: true }));
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
  const info: SymbolInfo = { id: c.owner, pos: { x: 0, y: 0 }, t: { ...IDENTITY_TRANSFORM }, showPinNames: true, showPinNumbers: true, pinNameOffset: 0 };
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
