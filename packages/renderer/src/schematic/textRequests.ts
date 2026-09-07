/**
 * `GetTextAsShapes` requests for every text the schematic plotter draws, keyed the way the
 * schematic adapter looks them up (`SchematicAdapterContext.textShapes`): pin names and
 * numbers, symbol fields and library texts / text boxes, sheet names / files / user fields and
 * sheet pins, every label kind and its fields, plain text, text boxes and table cells.
 *
 * Each request is the `Text` (or `TextBox`) eeschema hands its plotter -- position, angle,
 * justification and pen width after `SCH_PIN::PlotPinTexts`, `SCH_FIELD::Plot`,
 * `SCH_LABEL_BASE::Plot`, `SCH_TEXT::Plot` and the symbol transform -- so the glyphs come back
 * in final sheet coordinates and the adapter draws them verbatim. The placement code is the
 * adapter's own (the same functions size its BitmapText fallback), so the harness measures
 * what the app draws.
 *
 * Symbol fields are the one case that needs a second round trip: KiCad centres them on the
 * centre of `SCH_FIELD::GetBoundingBox()`. For a vertically centred upright field that centre
 * is reproduced without the text width (`symbolFieldPlacement`); otherwise the request carries
 * `measure` (a `GetTextExtents` request) and `place(box)` builds the final `text` from the
 * measured box (`resolveTextRequests`).
 */
import type { Box, Vec2 } from '../core/model.js';
import { vAdd } from '../core/model.js';
import type { StoredItemLike } from '../core/host.js';
import { type DistanceLike, type KiidLike, type TextBoxLike, dist, kiid, vec } from '../board/boardAdapter.js';
import type { HAlign, TextAttrs, VAlign } from './textMetrics.js';
import {
  type Ctx,
  type SchFieldLike,
  type SchPinLike,
  type SchSheetPinLike,
  type SchTextAttributesLike,
  type SchTextLike,
  type SchematicAdapterContext,
  SCH_TEXT_OFFSET,
  expandTextVars,
  fieldShownText,
  labelFieldRefs,
  labelTextLayout,
  makeCtx,
  pinLayout,
  readTextAttrs,
  readTextSize,
  schematicItemTypeOf,
  sheetPinLayout,
  sheetTextVars,
  symbolFieldPlacement,
  symbolFieldPlacementFromBox,
  symbolParts,
  symbolTextBoxProto,
  symbolTextPlacement,
} from './schematicAdapter.js';

// ---------------------------------------------------------------------------
// Request messages (protobuf-es init shapes of kiapi.common.types.Text / TextBox)
// ---------------------------------------------------------------------------

export interface RequestVector2 {
  xNm: bigint;
  yNm: bigint;
}

export interface RequestTextAttributes {
  horizontalAlignment: number;
  verticalAlignment: number;
  angle: { valueDegrees: number };
  lineSpacing: number;
  strokeWidth: { valueNm: bigint };
  italic: boolean;
  bold: boolean;
  mirrored: boolean;
  size: RequestVector2;
  fontName?: string;
}

/** `kiapi.common.types.Text` as `create(TextSchema, ...)` takes it. */
export interface RequestText {
  position: RequestVector2;
  text: string;
  attributes: RequestTextAttributes;
}

export interface SchTextRequest {
  /** adapter `textShapes` key (README "Render item ids") */
  key: string;
  /** content hash of everything that determines the reply, for caches */
  hash: string;
  /** exactly one of `text` / `textbox` once resolved */
  text?: RequestText;
  /** a text box / table cell laid out at its box by the server (`layOutTextBox`) */
  textbox?: Record<string, unknown>;
  /** `GetTextExtents` request whose box `place` turns into `text` (symbol fields that need the measured box) */
  measure?: RequestText;
  place?: (box: Box) => RequestText;
}

const HA: Record<HAlign, number> = { left: 1, center: 2, right: 3 };
const VA: Record<VAlign, number> = { top: 1, center: 2, bottom: 3 };
const big = (v: number): bigint => BigInt(Math.round(v));

/**
 * The pen width to put on the wire so the server's `GetEffectiveTextPenWidth()` (default 0)
 * lands on the plotter's `GetEffectiveTextPenWidth( default line width )`: a stored width goes
 * through unchanged (the server applies the bold multiplier itself), a bold text with no width
 * is left at 0 so the server picks the bold pen, anything else gets the resolved width.
 */
export function wirePenWidth(stored: SchTextAttributesLike | undefined, resolved: number): number {
  const s = dist(stored?.strokeWidth);
  if (s > 1) return s;
  return stored?.bold ? 0 : resolved;
}

function textMessage(text: string, pos: Vec2, a: TextAttrs, stored: SchTextAttributesLike | undefined, penWidth = wirePenWidth(stored, a.thickness)): RequestText {
  return {
    position: { xNm: big(pos.x), yNm: big(pos.y) },
    text,
    attributes: {
      horizontalAlignment: HA[a.halign],
      verticalAlignment: VA[a.valign],
      angle: { valueDegrees: a.angle },
      lineSpacing: a.lineSpacing || 1,
      strokeWidth: { valueNm: big(penWidth) },
      italic: !!a.italic,
      bold: !!a.bold,
      mirrored: !!a.mirrored,
      size: { xNm: big(a.size.x), yNm: big(a.size.y) },
      ...(stored?.fontName ? { fontName: stored.fontName } : {}),
    },
  };
}

function hashOf(...parts: unknown[]): string {
  return JSON.stringify(parts, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function textRequest(key: string, msg: RequestText): SchTextRequest {
  return { key, hash: hashOf('text', msg), text: msg };
}

/**
 * A `textbox` request: the box as stored, with the plotter's pen width filled in. Built as a
 * plain init object (no `$typeName`) so `create(TextBoxSchema, ...)` converts every nested
 * value; a protobuf message spread around plain children would be sent as-is and fail.
 */
type Margins = { marginLeft?: DistanceLike; marginTop?: DistanceLike; marginRight?: DistanceLike; marginBottom?: DistanceLike };

/**
 * `outer` is the item that owns the box (SchematicTextBox, a table cell, a symbol text box):
 * the schematic API keeps the margins there, while `layOutTextBox` reads them from the
 * `TextBox` message, so they are copied in (the adapter's `textBoxPrims` reads both too).
 */
function textBoxRequest(key: string, tb: TextBoxLike & { attributes?: SchTextAttributesLike } & Margins, c: Ctx, outer: Margins = {}): SchTextRequest | undefined {
  if (!tb.text) return undefined;
  const margin = (k: keyof Margins): number => dist(outer[k] ?? tb[k]);
  const size = readTextSize(tb.attributes, c.d);
  const a = readTextAttrs(tb.attributes, c.d);
  const st = tb.attributes;
  const v2 = (v: Vec2): RequestVector2 => ({ xNm: big(v.x), yNm: big(v.y) });
  const attributes: RequestTextAttributes = {
    horizontalAlignment: HA[a.halign],
    verticalAlignment: VA[a.valign],
    angle: { valueDegrees: a.angle },
    lineSpacing: a.lineSpacing || 1,
    strokeWidth: { valueNm: big(wirePenWidth(st, a.thickness)) },
    italic: !!a.italic,
    bold: !!a.bold,
    mirrored: !!a.mirrored,
    size: v2(size),
    ...(st?.fontName ? { fontName: st.fontName } : {}),
  };
  const textbox = {
    topLeft: v2(vec(tb.topLeft)),
    bottomRight: v2(vec(tb.bottomRight)),
    attributes,
    text: tb.text,
    borderEnabled: tb.borderEnabled ?? true,
    marginLeft: { valueNm: big(margin('marginLeft')) },
    marginTop: { valueNm: big(margin('marginTop')) },
    marginRight: { valueNm: big(margin('marginRight')) },
    marginBottom: { valueNm: big(margin('marginBottom')) },
  };
  return { key, hash: hashOf('textbox', textbox), textbox };
}

// ---------------------------------------------------------------------------
// Per-item builders
// ---------------------------------------------------------------------------

/** A field drawn as stored (labels, sheets, standalone fields), optionally shifted. */
function plainFieldRequest(key: string, f: SchFieldLike | undefined, c: Ctx, offset?: Vec2, kind: 'field' | 'sheetfile' = 'field'): SchTextRequest | undefined {
  const text = fieldShownText(f, !!c.ctx.showHiddenFields, kind);
  if (!text || !f?.text) return undefined;
  const a = readTextAttrs(f.text.attributes, c.d);
  return textRequest(key, textMessage(text, vAdd(vec(f.text.position), offset ?? { x: 0, y: 0 }), a, f.text.attributes));
}

/**
 * A symbol field: exact closed form when it is vertically centred and upright, otherwise a
 * measured placement (`GetTextExtents` of the field at its stored position / attributes, the
 * box centre through the symbol transform, drawn centred at the draw rotation).
 */
export function symbolFieldRequest(key: string, f: SchFieldLike | undefined, t: Parameters<typeof symbolFieldPlacement>[2], origin: Vec2, c: Ctx): SchTextRequest | undefined {
  const text = fieldShownText(f, !!c.ctx.showHiddenFields);
  if (!text || !f?.text) return undefined;
  const stored = f.text.attributes;
  const a = readTextAttrs(stored, c.d);
  const pos = vec(f.text.position);
  const boxPen = (() => {
    // GetTextBox's pen: GetEffectiveTextPenWidth() with default 0
    const s = dist(stored?.strokeWidth);
    let w = s > 1 ? (stored?.bold ? Math.round(s * 1.6) : s) : stored?.bold ? Math.round(a.size.x / 5) : Math.round(a.size.x / 8);
    w = Math.min(w, Math.round(Math.min(a.size.x, a.size.y) * 0.25));
    return w;
  })();
  const placed = symbolFieldPlacement(a, pos, t, origin, boxPen);
  if (placed.exact) {
    return textRequest(key, textMessage(text, placed.pos, { ...a, angle: placed.angle, halign: placed.halign, valign: placed.valign }, stored));
  }
  const measure = textMessage(text, pos, a, stored, dist(stored?.strokeWidth));
  const place = (box: Box): RequestText => {
    const m = symbolFieldPlacementFromBox(a, pos, t, origin, box);
    return textMessage(text, m.pos, { ...a, angle: m.angle, halign: m.halign, valign: m.valign }, stored);
  };
  return { key, hash: hashOf('measured', measure, t, origin), measure, place };
}

function symbolRequests(p: Record<string, unknown>, id: string, c: Ctx): SchTextRequest[] {
  const out: SchTextRequest[] = [];
  const { info, children, pins, fields } = symbolParts(p, id, c);
  pins.forEach((pin, i) => {
    const l = pinLayout(pin, i, info, c);
    if (!l) return;
    for (const which of ['number', 'name'] as const) {
      const lay = l.texts[which];
      if (!lay) continue;
      const a: TextAttrs = { size: { x: lay.size, y: lay.size }, thickness: lay.thickness, angle: lay.angle, halign: lay.halign, valign: lay.valign, lineSpacing: 1 };
      out.push(textRequest(`${id}:pin:${l.pinKiid}:${which}`, textMessage(lay.text, lay.pos, a, undefined, lay.thickness)));
    }
  });
  for (const f of fields) {
    const r = symbolFieldRequest(f.key, f.field, info.t, info.pos, c);
    if (r) out.push(r);
  }
  for (const d of children) {
    if (d.type === 'KOT_SCH_TEXT') {
      const txt = d.proto.text as SchTextLike | undefined;
      if (!txt?.text) continue;
      const a = readTextAttrs(txt.attributes, c.d);
      const placed = symbolTextPlacement(a, vec(txt.position), info.t, info.pos);
      out.push(textRequest(`${id}:text:${d.cid}`, textMessage(txt.text, placed.pos, { ...a, angle: placed.angle, halign: placed.halign, valign: placed.valign }, txt.attributes)));
    } else if (d.type === 'KOT_SCH_TEXTBOX') {
      const tb = symbolTextBoxProto(d.proto, info.t, info.pos).textbox as (TextBoxLike & { attributes?: SchTextAttributesLike }) | undefined;
      const r = tb ? textBoxRequest(`${id}:textbox:${d.cid}`, tb, c, d.proto as Margins) : undefined;
      if (r) out.push(r);
    }
  }
  return out;
}

function sheetRequests(p: Record<string, unknown>, id: string, c: Ctx): SchTextRequest[] {
  const out: SchTextRequest[] = [];
  const nameField = p.nameField as SchFieldLike | undefined;
  const fileField = p.filenameField as SchFieldLike | undefined;
  const push = (r: SchTextRequest | undefined): void => {
    if (r) out.push(r);
  };
  push(plainFieldRequest(`${id}:field:${nameField?.name || 'Sheetname'}`, nameField, c));
  push(plainFieldRequest(`${id}:field:${fileField?.name || 'Sheetfile'}`, fileField, c, undefined, 'sheetfile'));
  ((p.userFields as SchFieldLike[] | undefined) ?? []).forEach((f, i) => push(plainFieldRequest(`${id}:field:${f.name || i}`, f, c)));
  const vars = sheetTextVars(p);
  ((p.pins as SchSheetPinLike[] | undefined) ?? []).forEach((pin, i) => push(sheetPinRequest(pin, i, id, c, vars)));
  return out;
}

function sheetPinRequest(pin: SchSheetPinLike, index: number, sheetId: string, c: Ctx, vars?: Record<string, string>): SchTextRequest | undefined {
  const l = sheetPinLayout(pin, index, sheetId, c, vars);
  if (!l.text) return undefined;
  return textRequest(l.key, textMessage(l.text, l.anchor, l.a, pin.text?.attributes));
}

function labelRequests(kind: 'local' | 'global' | 'hier' | 'directive', p: Record<string, unknown>, id: string, c: Ctx): SchTextRequest[] {
  const out: SchTextRequest[] = [];
  let fieldOffset: Vec2 | undefined;
  if (kind !== 'directive') {
    const l = labelTextLayout(kind, p, c);
    if (l.text) out.push(textRequest(id, textMessage(l.text, l.anchor, l.a, (p.text as SchTextLike | undefined)?.attributes)));
    fieldOffset = l.fieldOffset;
  }
  for (const { key, field } of labelFieldRefs(p, id)) {
    const r = plainFieldRequest(key, field, c, fieldOffset);
    if (r) out.push(r);
  }
  return out;
}

/**
 * The `GetTextAsShapes` (and, for some symbol fields, `GetTextExtents`) requests for one store
 * item. Hidden pins / fields are included only when the context shows them, as the adapter draws
 * them. Empty strings produce no request.
 */
export function schematicTextRequests(item: StoredItemLike, ctx: SchematicAdapterContext = {}): SchTextRequest[] {
  const p = (item.proto ?? {}) as Record<string, unknown>;
  const type = item.type || schematicItemTypeOf(p, ctx)?.type || '';
  const id = item.id || kiid(p.id as KiidLike);
  const c = makeCtx(ctx, id);
  const out: SchTextRequest[] = [];
  const push = (r: SchTextRequest | undefined): void => {
    if (r) out.push(r);
  };
  switch (type) {
    case 'KOT_SCH_TEXT': {
      const t = p.text as SchTextLike | undefined;
      if (t?.text) push(textRequest(id, textMessage(t.text, vAdd(vec(t.position), SCH_TEXT_OFFSET), readTextAttrs(t.attributes, c.d), t.attributes)));
      break;
    }
    case 'KOT_SCH_TEXTBOX': {
      const tb = p.textbox as (TextBoxLike & { attributes?: SchTextAttributesLike }) | undefined;
      if (tb) push(textBoxRequest(id, tb, c, p as Margins));
      break;
    }
    case 'KOT_SCH_TABLE':
      for (const cell of (p.cells as Array<{ textBox?: Record<string, unknown> }> | undefined) ?? []) {
        const tb = cell.textBox?.textbox as (TextBoxLike & { attributes?: SchTextAttributesLike }) | undefined;
        const cid = kiid(cell.textBox?.id as KiidLike);
        if (tb && cid) push(textBoxRequest(cid, tb, c, cell.textBox as Margins));
      }
      break;
    case 'KOT_SCH_LABEL':
      out.push(...labelRequests('local', p, id, c));
      break;
    case 'KOT_SCH_GLOBAL_LABEL':
      out.push(...labelRequests('global', p, id, c));
      break;
    case 'KOT_SCH_HIER_LABEL':
      out.push(...labelRequests('hier', p, id, c));
      break;
    case 'KOT_SCH_DIRECTIVE_LABEL':
      out.push(...labelRequests('directive', p, id, c));
      break;
    case 'KOT_SCH_SHEET':
      out.push(...sheetRequests(p, id, c));
      break;
    case 'KOT_SCH_SHEET_PIN':
      push(sheetPinRequest({ ...(p as SchSheetPinLike), id: { value: id } }, 0, id, c));
      break;
    case 'KOT_SCH_SYMBOL':
      out.push(...symbolRequests(p, id, c));
      break;
    case 'KOT_SCH_PIN': {
      // standalone pin: identity transform, as convertStandalonePin draws it
      const info = { id, pos: { x: 0, y: 0 }, t: { x1: 1, y1: 0, x2: 0, y2: 1 }, showPinNames: true, showPinNumbers: true, pinNameOffset: 0 };
      const l = pinLayout({ ...(p as SchPinLike), id: { value: id } }, 0, info, c);
      if (!l) break;
      for (const which of ['number', 'name'] as const) {
        const lay = l.texts[which];
        if (!lay) continue;
        const a: TextAttrs = { size: { x: lay.size, y: lay.size }, thickness: lay.thickness, angle: lay.angle, halign: lay.halign, valign: lay.valign, lineSpacing: 1 };
        push(textRequest(`${id}:pin:${l.pinKiid}:${which}`, textMessage(lay.text, lay.pos, a, undefined, lay.thickness)));
      }
      break;
    }
    case 'KOT_SCH_FIELD':
      push(plainFieldRequest(id, p as SchFieldLike, c));
      break;
    default:
      break;
  }
  return out;
}

/**
 * Turns every `measure` request into its final `text` by asking the server for the text box
 * (`GetTextExtents`; one round trip per request). Requests that already carry `text` /
 * `textbox` are left alone. Returns the requests that are ready for `GetTextAsShapes`.
 */
export async function resolveTextRequests(requests: SchTextRequest[], textExtents: (text: RequestText) => Promise<Box>): Promise<SchTextRequest[]> {
  for (const r of requests) {
    if (r.text || r.textbox || !r.measure || !r.place) continue;
    r.text = r.place(await textExtents(r.measure));
  }
  return requests.filter((r) => r.text || r.textbox);
}

/** The owning store item of a text key (`<kiid>`, `<kiid>:field:...`, `<sym>:pin:...`, `<sheet>:pin:...`). Table cells are keyed by the cell itself. */
export function textKeyOwner(key: string): string {
  return key.split(':')[0]!;
}
