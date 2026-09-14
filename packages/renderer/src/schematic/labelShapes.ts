/**
 * Label outline shapes and text placement, ported from eeschema/sch_label.cpp
 * (SCH_GLOBALLABEL / SCH_HIERLABEL / SCH_DIRECTIVE_LABEL::CreateGraphicShape, the
 * TemplateShape tables, GetSchematicTextOffset, SetSpinStyle) and
 * SCH_SHEET_PIN::CreateGraphicShape. All lengths in nm; y down.
 */
import type { Vec2 } from '../core/model.js';
import { vAdd, vRotate } from '../core/model.js';
import type { HAlign } from './textMetrics.js';
import { SCH_DEFAULTS } from './schematicLayers.js';

export type SpinStyle = 'left' | 'up' | 'right' | 'bottom';
export type LabelShape = 'input' | 'output' | 'bidi' | 'tristate' | 'passive' | 'dot' | 'circle' | 'diamond' | 'rectangle';

/** SLSS_LEFT = 1, SLSS_UP = 2, SLSS_RIGHT = 3, SLSS_BOTTOM = 4. */
export function spinStyleFromEnum(v: number | string | undefined | null): SpinStyle | undefined {
  switch (v) {
    case 1:
    case 'SLSS_LEFT':
      return 'left';
    case 2:
    case 'SLSS_UP':
      return 'up';
    case 3:
    case 'SLSS_RIGHT':
      return 'right';
    case 4:
    case 'SLSS_BOTTOM':
      return 'bottom';
    default:
      return undefined;
  }
}

/** SCH_LABEL_BASE::GetSpinStyle from the text attributes (angle + horizontal justification). */
export function spinStyleFromText(angle: number, halign: HAlign): SpinStyle {
  const vertical = Math.abs((((angle % 180) + 180) % 180) - 90) < 1e-6;
  if (vertical) return halign === 'right' ? 'bottom' : 'up';
  return halign === 'right' ? 'left' : 'right';
}

/** Text angle / horizontal justification a spin style implies (SCH_LABEL_BASE::SetSpinStyle). */
export function spinTextAttrs(spin: SpinStyle): { angle: number; halign: HAlign } {
  switch (spin) {
    case 'right':
      return { angle: 0, halign: 'left' };
    case 'up':
      return { angle: 90, halign: 'left' };
    case 'left':
      return { angle: 0, halign: 'right' };
    case 'bottom':
      return { angle: 90, halign: 'right' };
  }
}

/** SLSH_INPUT = 1 ... SLSH_RECTANGLE = 9 (SLSH_PASSIVE = L_UNSPECIFIED). */
export function labelShapeFromEnum(v: number | string | undefined | null, fallback: LabelShape = 'input'): LabelShape {
  switch (v) {
    case 1:
    case 'SLSH_INPUT':
      return 'input';
    case 2:
    case 'SLSH_OUTPUT':
      return 'output';
    case 3:
    case 'SLSH_BIDI':
      return 'bidi';
    case 4:
    case 'SLSH_TRISTATE':
      return 'tristate';
    case 5:
    case 'SLSH_PASSIVE':
      return 'passive';
    case 6:
    case 'SLSH_DOT':
      return 'dot';
    case 7:
    case 'SLSH_CIRCLE':
      return 'circle';
    case 8:
    case 'SLSH_DIAMOND':
      return 'diamond';
    case 9:
    case 'SLSH_RECTANGLE':
      return 'rectangle';
    default:
      return fallback;
  }
}

/** The `switch( GetSpinStyle() ) RotatePoint(...)` step of CreateGraphicShape. */
export function rotateForSpin(p: Vec2, spin: SpinStyle): Vec2 {
  switch (spin) {
    case 'left':
      return p;
    case 'up':
      return vRotate(p, -90);
    case 'right':
      return vRotate(p, 180);
    case 'bottom':
      return vRotate(p, 90);
  }
}

// ---------------------------------------------------------------------------
// Global labels
// ---------------------------------------------------------------------------

/** GetLabelBoxExpansion: margin around the text inside a global label flag. */
export const labelBoxExpansion = (textHeight: number, ratio = SCH_DEFAULTS.labelSizeRatio): number => Math.round(ratio * textHeight);

/**
 * SCH_GLOBALLABEL::CreateGraphicShape. `textWidth` is the unrotated text box width.
 * Returns the closed outline (first point repeated at the end).
 */
export function globalLabelShape(
  pos: Vec2,
  textHeight: number,
  textWidth: number,
  penWidth: number,
  shape: LabelShape,
  spin: SpinStyle,
): Vec2[] {
  const margin = labelBoxExpansion(textHeight);
  const halfSize = Math.round(textHeight / 2) + margin;
  const symbLen = textWidth + 2 * margin;
  const x = symbLen + penWidth + 300; // "+ 3" schematic IU (100 nm each)
  const y = halfSize + penWidth + 300;
  const pts: Vec2[] = [
    { x: 0, y: 0 },
    { x: 0, y: -y },
    { x: -x, y: -y },
    { x: -x, y: 0 },
    { x: -x, y: y },
    { x: 0, y: y },
  ];
  let xOffset = 0;
  switch (shape) {
    case 'input':
      xOffset = -halfSize;
      pts[0]!.x += halfSize;
      break;
    case 'output':
      pts[3]!.x -= halfSize;
      break;
    case 'bidi':
    case 'tristate':
      xOffset = -halfSize;
      pts[0]!.x += halfSize;
      pts[3]!.x -= halfSize;
      break;
    default:
      break;
  }
  const out = pts.map((p) => vAdd(rotateForSpin({ x: p.x + xOffset, y: p.y }, spin), pos));
  out.push(out[0]!);
  return out;
}

/** SCH_GLOBALLABEL::GetSchematicTextOffset. */
export function globalLabelTextOffset(textHeight: number, shape: LabelShape, spin: SpinStyle): Vec2 {
  let horiz = labelBoxExpansion(textHeight);
  const vert = Math.round(textHeight * 0.0715);
  if (shape === 'input' || shape === 'bidi' || shape === 'tristate') horiz += Math.round((textHeight * 3) / 4);
  switch (spin) {
    case 'left':
      return { x: -horiz, y: vert };
    case 'up':
      return { x: vert, y: -horiz };
    case 'right':
      return { x: horiz, y: vert };
    case 'bottom':
      return { x: vert, y: horiz };
  }
}

// ---------------------------------------------------------------------------
// Hierarchical labels and sheet pins (template shapes in units of textHeight / 2)
// ---------------------------------------------------------------------------

// [shape][spin] -> flat point list; sch_label.cpp Template*_HN / _UP / _HI / _BOTTOM
const T_IN = {
  left: [0, 0, -1, -1, -2, -1, -2, 1, -1, 1, 0, 0],
  up: [0, 0, 1, -1, 1, -2, -1, -2, -1, -1, 0, 0],
  right: [0, 0, 1, 1, 2, 1, 2, -1, 1, -1, 0, 0],
  bottom: [0, 0, 1, 1, 1, 2, -1, 2, -1, 1, 0, 0],
};
const T_OUT = {
  left: [-2, 0, -1, 1, 0, 1, 0, -1, -1, -1, -2, 0],
  up: [0, -2, 1, -1, 1, 0, -1, 0, -1, -1, 0, -2],
  right: [2, 0, 1, -1, 0, -1, 0, 1, 1, 1, 2, 0],
  bottom: [0, 2, 1, 1, 1, 0, -1, 0, -1, 1, 0, 2],
};
const T_UNSPC = {
  left: [0, -1, -2, -1, -2, 1, 0, 1, 0, -1],
  up: [1, 0, 1, -2, -1, -2, -1, 0, 1, 0],
  right: [0, -1, 2, -1, 2, 1, 0, 1, 0, -1],
  bottom: [1, 0, 1, 2, -1, 2, -1, 0, 1, 0],
};
const T_BIDI = {
  left: [0, 0, -1, -1, -2, 0, -1, 1, 0, 0],
  up: [0, 0, -1, -1, 0, -2, 1, -1, 0, 0],
  right: [0, 0, 1, -1, 2, 0, 1, 1, 0, 0],
  bottom: [0, 0, -1, 1, 0, 2, 1, 1, 0, 0],
};
const T_3STATE = T_BIDI;

function hierTemplate(shape: LabelShape, spin: SpinStyle): number[] {
  switch (shape) {
    case 'input':
      return T_IN[spin];
    case 'output':
      return T_OUT[spin];
    case 'bidi':
      return T_BIDI[spin];
    case 'tristate':
      return T_3STATE[spin];
    default:
      return T_UNSPC[spin];
  }
}

/** SCH_HIERLABEL::CreateGraphicShape: closed polyline (first point repeated). */
export function hierLabelShape(pos: Vec2, textHeight: number, shape: LabelShape, spin: SpinStyle): Vec2[] {
  const half = Math.round(textHeight / 2);
  const t = hierTemplate(shape, spin);
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < t.length; i += 2) out.push({ x: half * t[i]! + pos.x, y: half * t[i + 1]! + pos.y });
  return out;
}

/** SCH_SHEET_PIN::CreateGraphicShape: hierarchical shape with input / output swapped. */
export function sheetPinShape(pos: Vec2, textHeight: number, shape: LabelShape, spin: SpinStyle): Vec2[] {
  const s: LabelShape = shape === 'input' ? 'output' : shape === 'output' ? 'input' : shape;
  return hierLabelShape(pos, textHeight, s, spin);
}

/** SCH_HIERLABEL::GetSchematicTextOffset (also used by sheet pins). */
export function hierLabelTextOffset(
  textHeight: number,
  textWidth: number,
  spin: SpinStyle,
  offsetRatio = SCH_DEFAULTS.textOffsetRatio,
): Vec2 {
  const dist = Math.round(offsetRatio * textHeight) + textWidth;
  switch (spin) {
    case 'left':
      return { x: -dist, y: 0 };
    case 'up':
      return { x: 0, y: -dist };
    case 'right':
      return { x: dist, y: 0 };
    case 'bottom':
      return { x: 0, y: dist };
  }
}

/** SCH_LABEL_BASE::GetSchematicTextOffset for local labels (raised off the wire). */
export function localLabelTextOffset(
  textHeight: number,
  penWidth: number,
  spin: SpinStyle,
  offsetRatio = SCH_DEFAULTS.textOffsetRatio,
): Vec2 {
  const dist = Math.round(offsetRatio * textHeight) + penWidth;
  return spin === 'up' || spin === 'bottom' ? { x: -dist, y: 0 } : { x: 0, y: -dist };
}

/** Sheet side (SHS_LEFT = 1, SHS_RIGHT = 2, SHS_TOP = 3, SHS_BOTTOM = 4) -> spin style (SCH_SHEET_PIN::SetSide). */
export function sheetSideSpin(v: number | string | undefined | null): SpinStyle | undefined {
  switch (v) {
    case 1:
    case 'SHS_LEFT':
      return 'right';
    case 2:
    case 'SHS_RIGHT':
      return 'left';
    case 3:
    case 'SHS_TOP':
      return 'bottom';
    case 4:
    case 'SHS_BOTTOM':
      return 'up';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Directive labels (netclass flags)
// ---------------------------------------------------------------------------

export interface DirectiveShape {
  /** polyline to stroke (open) */
  line: Vec2[];
  /** circle (dot / round shapes), filled for dot */
  circle?: { c: Vec2; r: number; fill: boolean };
}

/** SCH_DIRECTIVE_LABEL::CreateGraphicShape + the way SCH_PAINTER strokes it. */
export function directiveLabelShape(
  pos: Vec2,
  shape: LabelShape,
  spin: SpinStyle,
  pinLength = SCH_DEFAULTS.directivePinLength,
  symbolSize = SCH_DEFAULTS.directiveSymbolSize,
): DirectiveShape {
  const place = (pts: Vec2[]): Vec2[] => pts.map((p) => vAdd(rotateForSpin(p, spin), pos));
  switch (shape) {
    case 'dot':
    case 'circle': {
      const s = shape === 'dot' ? Math.round(symbolSize * 0.7) : symbolSize;
      const pts = place([
        { x: 0, y: 0 },
        { x: 0, y: pinLength - s },
        { x: 0, y: pinLength },
      ]);
      return {
        line: [pts[0]!, pts[1]!],
        circle: { c: pts[2]!, r: Math.hypot(pts[2]!.x - pts[1]!.x, pts[2]!.y - pts[1]!.y), fill: shape === 'dot' },
      };
    }
    case 'diamond':
      return {
        line: place([
          { x: 0, y: 0 },
          { x: 0, y: pinLength - symbolSize },
          { x: -2 * symbolSize, y: pinLength },
          { x: 0, y: pinLength + symbolSize },
          { x: 2 * symbolSize, y: pinLength },
          { x: 0, y: pinLength - symbolSize },
          { x: 0, y: 0 },
        ]),
      };
    case 'rectangle': {
      const s = Math.round(symbolSize * 0.8);
      return {
        line: place([
          { x: 0, y: 0 },
          { x: 0, y: pinLength - s },
          { x: -2 * s, y: pinLength - s },
          { x: -2 * s, y: pinLength + s },
          { x: 2 * s, y: pinLength + s },
          { x: 2 * s, y: pinLength - s },
          { x: 0, y: pinLength - s },
          { x: 0, y: 0 },
        ]),
      };
    }
    default:
      return { line: [] };
  }
}
