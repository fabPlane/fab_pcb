/**
 * Fallback text rendering for the schematic layer: `text-glyphs` primitives become Pixi
 * `BitmapText` objects (one dynamic bitmap font per family / weight / style, glyph atlas
 * shared by every label). The glyphs are stretched to the adapter's metrics estimate
 * (`outline`), so what is drawn matches what is picked. This is an approximation of KiCad's
 * stroke font; feed `GetTextAsShapes` results through `SchematicAdapterContext.textShapes`
 * for exact output. The core never imports this module (it stays font-free).
 */
import { BitmapText, type Container } from 'pixi.js';
import type { Primitive } from '../core/model.js';
import type { PrimitiveBuilder } from '../core/scene.js';
import { outlineExtents } from './textMetrics.js';

export interface TextGlyphOptions {
  /** CSS font family for the dynamic bitmap font (default: a sans-serif stack) */
  fontFamily?: string;
  /** atlas glyph size in px; bigger = sharper when zoomed in, more atlas memory (default 96) */
  fontSize?: number;
  /** cap height / ascent of the font as fractions of the em size (defaults fit Arial / Helvetica) */
  capHeight?: number;
  ascent?: number;
}

/**
 * Scene `primitiveBuilder` that draws `text-glyphs` with BitmapText. Headless (no
 * `document`) it claims the primitive and draws nothing, so tests run without a canvas.
 */
export function createTextGlyphBuilder(opts: TextGlyphOptions = {}): PrimitiveBuilder {
  const fontFamily = opts.fontFamily ?? 'Helvetica Neue, Helvetica, Arial, sans-serif';
  const fontSize = opts.fontSize ?? 96;
  const capHeight = (opts.capHeight ?? 0.716) * fontSize;
  const baseline = (opts.ascent ?? 0.905) * fontSize;
  const capTop = baseline - capHeight;
  return (prim: Primitive, ax: number, ay: number, host: Container): boolean => {
    if (prim.kind !== 'text-glyphs') return false;
    if (typeof document === 'undefined' || !prim.text) return true;
    let text: BitmapText;
    try {
      text = new BitmapText({
        text: prim.text,
        style: { fontFamily, fontSize, fill: 0xffffff, fontWeight: prim.bold ? 'bold' : 'normal', fontStyle: prim.italic ? 'italic' : 'normal' },
      });
    } catch {
      return true; // no canvas / font support: leave the text out rather than fail the item
    }
    const measured = Math.max(1, text.width);
    const { w, h } = outlineExtents(prim.outline);
    const targetW = w || prim.size.x * prim.text.length * 0.8;
    const targetH = h || prim.size.y;
    const sx = targetW / measured;
    const sy = targetH / capHeight;
    const px = prim.halign === 'left' ? 0 : prim.halign === 'right' ? measured : measured / 2;
    const py = prim.valign === 'top' ? capTop : prim.valign === 'bottom' ? baseline : (capTop + baseline) / 2;
    text.pivot.set(px, py);
    text.scale.set(prim.mirrored ? -sx : sx, sy);
    text.rotation = (-prim.angle * Math.PI) / 180; // KiCad angles are counter-clockwise on screen
    text.position.set(prim.pos.x - ax, prim.pos.y - ay);
    text.roundPixels = false;
    text.label = 'text-glyphs';
    host.addChild(text);
    return true;
  };
}
