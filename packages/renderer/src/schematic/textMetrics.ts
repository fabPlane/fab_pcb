/**
 * Font-free text metrics for the schematic fallback text path. KiCad's stroke font is never
 * shipped; these estimates size the `text-glyphs` primitives (bounding box, picking, and the
 * scale the Pixi BitmapText builder stretches its glyphs to) and mimic EDA_TEXT::GetTextBox /
 * GetLinePositions so labels, fields and pin texts land where eeschema puts them. Feed
 * `textShapes(id)` (GetTextAsShapes) through the adapter context for exact glyphs.
 */
import type { TextGlyphsPrimitive, Vec2 } from '../core/model.js';
import { vAdd, vRotate } from '../core/model.js';

export type HAlign = TextGlyphsPrimitive['halign'];
export type VAlign = TextGlyphsPrimitive['valign'];

/** HA_LEFT = 1, HA_CENTER = 2, HA_RIGHT = 3 (kiapi.common.types.HorizontalAlignment). */
export function halignFromEnum(v: number | string | undefined | null, fallback: HAlign = 'center'): HAlign {
  if (v === 1 || v === 'HA_LEFT') return 'left';
  if (v === 2 || v === 'HA_CENTER') return 'center';
  if (v === 3 || v === 'HA_RIGHT') return 'right';
  return fallback;
}

/** VA_TOP = 1, VA_CENTER = 2, VA_BOTTOM = 3 (kiapi.common.types.VerticalAlignment). */
export function valignFromEnum(v: number | string | undefined | null, fallback: VAlign = 'center'): VAlign {
  if (v === 1 || v === 'VA_TOP') return 'top';
  if (v === 2 || v === 'VA_CENTER') return 'center';
  if (v === 3 || v === 'VA_BOTTOM') return 'bottom';
  return fallback;
}

export const flipHAlign = (h: HAlign): HAlign => (h === 'left' ? 'right' : h === 'right' ? 'left' : h);
export const flipVAlign = (v: VAlign): VAlign => (v === 'top' ? 'bottom' : v === 'bottom' ? 'top' : v);

/**
 * Average glyph advance of KiCad's newstroke font as a fraction of the text width setting
 * (glyph "size.x"); the stroke font's boundary limits for typical label text land around
 * 0.75..0.85 per character.
 */
export const STROKE_CHAR_ADVANCE = 0.8;
/** METRICS::GetInterline (1.62) x STROKE_FONT LEGACY_FACTOR (0.9583) */
export const INTERLINE_RATIO = 1.62 * 0.9583;

export interface TextAttrs {
  size: Vec2;
  thickness: number;
  angle: number;
  halign: HAlign;
  valign: VAlign;
  mirrored?: boolean;
  bold?: boolean;
  italic?: boolean;
  lineSpacing?: number;
}

/** Estimated extents (nm) of one line of text, stroke width included (font->StringBoundaryLimits). */
export function textExtents(text: string, size: Vec2, thickness: number, bold = false, italic = false): { w: number; h: number } {
  const n = Math.max(1, [...text].length);
  const bolden = bold ? 1.08 : 1;
  const slant = italic ? size.y / 8 : 0; // ITALIC_TILT
  return { w: n * size.x * STROKE_CHAR_ADVANCE * bolden + thickness + slant, h: size.y + thickness };
}

/** Distance between text lines (EDA_TEXT::GetInterline). */
export function interline(sizeY: number, lineSpacing = 1): number {
  return Math.round(sizeY * INTERLINE_RATIO * (lineSpacing || 1));
}

/**
 * Glyph box corners of one line: TL, TR, BR, BL of the justified box, rotated about `pos`
 * by `angle` (EDA_TEXT::GetTextBox; the mirrored flag mirrors the horizontal extent).
 */
export function textGlyphOutline(pos: Vec2, w: number, h: number, angle: number, halign: HAlign, valign: VAlign, mirrored = false): Vec2[] {
  let x0: number;
  if (halign === 'left') x0 = mirrored ? -w : 0;
  else if (halign === 'right') x0 = mirrored ? 0 : -w;
  else x0 = -w / 2;
  const y0 = valign === 'top' ? 0 : valign === 'bottom' ? -h : -h / 2;
  const local: Vec2[] = [
    { x: x0, y: y0 },
    { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + h },
    { x: x0, y: y0 + h },
  ];
  return local.map((p) => vAdd(vRotate(p, angle), pos));
}

/** Width / height of a glyph outline produced by textGlyphOutline (rotation-invariant). */
export function outlineExtents(outline: Vec2[]): { w: number; h: number } {
  if (outline.length < 4) return { w: 0, h: 0 };
  return { w: Math.hypot(outline[1]!.x - outline[0]!.x, outline[1]!.y - outline[0]!.y), h: Math.hypot(outline[3]!.x - outline[0]!.x, outline[3]!.y - outline[0]!.y) };
}

/**
 * `text-glyphs` primitives for a (possibly multi-line) text at `pos`. Lines are laid out
 * like EDA_TEXT::GetLinePositions: the block is justified as a whole, then each line is
 * offset by the interline distance rotated with the text.
 */
export function textGlyphPrims(text: string, pos: Vec2, a: TextAttrs): TextGlyphsPrimitive[] {
  const lines = text.split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  const size = { x: a.size.x || a.size.y, y: a.size.y || a.size.x };
  const step = interline(size.y, a.lineSpacing);
  let first = { x: pos.x, y: pos.y };
  if (lines.length > 1) {
    if (a.valign === 'center') first = { x: first.x, y: first.y - ((lines.length - 1) * step) / 2 };
    else if (a.valign === 'bottom') first = { x: first.x, y: first.y - (lines.length - 1) * step };
  }
  first = vRotate(first, a.angle, pos);
  const offset = vRotate({ x: 0, y: step }, a.angle);
  const out: TextGlyphsPrimitive[] = [];
  let p = first;
  for (const line of lines) {
    if (line !== '') {
      const { w, h } = textExtents(line, size, a.thickness, a.bold, a.italic);
      out.push({
        kind: 'text-glyphs',
        text: line,
        pos: p,
        size,
        thickness: a.thickness,
        angle: a.angle,
        halign: a.halign,
        valign: a.valign,
        mirrored: a.mirrored,
        bold: a.bold,
        italic: a.italic,
        outline: textGlyphOutline(p, w, h, a.angle, a.halign, a.valign, a.mirrored),
      });
    }
    p = vAdd(p, offset);
  }
  return out;
}

/** Bounding-box-only estimate of a whole text block (all lines), for layout decisions. */
export function textBlockExtents(text: string, a: TextAttrs): { w: number; h: number } {
  const lines = text.split('\n');
  const size = { x: a.size.x || a.size.y, y: a.size.y || a.size.x };
  let w = 0;
  for (const l of lines) w = Math.max(w, textExtents(l, size, a.thickness, a.bold, a.italic).w);
  const h = size.y + a.thickness + (lines.length - 1) * interline(size.y, a.lineSpacing);
  return { w, h };
}
