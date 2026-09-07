// Unit helpers. SWAP SEAM: `@fp-pcb/client/units` will export the same names; when it
// exists, re-export from there and delete the bodies below.

export type Unit = 'mm' | 'mil' | 'in';

export const NM_PER_MM = 1_000_000;
export const NM_PER_MIL = 25_400;
export const NM_PER_IN = 25_400_000;

export const UNIT_ORDER: Unit[] = ['mm', 'mil', 'in'];

export function nmPer(unit: Unit): number {
  switch (unit) {
    case 'mm':
      return NM_PER_MM;
    case 'mil':
      return NM_PER_MIL;
    case 'in':
      return NM_PER_IN;
  }
}

export const mm = (v: number): number => Math.round(v * NM_PER_MM);
export const mil = (v: number): number => Math.round(v * NM_PER_MIL);
export const inch = (v: number): number => Math.round(v * NM_PER_IN);

export function toUnit(nm: number, unit: Unit): number {
  return nm / nmPer(unit);
}

export function fromUnit(value: number, unit: Unit): number {
  return Math.round(value * nmPer(unit));
}

/** Default display precision per unit, matching pcbnew's status bar. */
export function precisionFor(unit: Unit): number {
  switch (unit) {
    case 'mm':
      return 4;
    case 'mil':
      return 2;
    case 'in':
      return 5;
  }
}

/** Formats a distance for display; trims trailing zeros but keeps at least one decimal. */
export function formatDistance(nm: number, unit: Unit, precision = precisionFor(unit)): string {
  if (!Number.isFinite(nm)) return '—';
  const v = toUnit(nm, unit);
  let s = v.toFixed(precision);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s += '0';
  }
  if (s === '-0.0') s = '0.0';
  return s;
}

export function formatDistanceWithUnit(nm: number, unit: Unit, precision?: number): string {
  return `${formatDistance(nm, unit, precision)} ${unit}`;
}

/**
 * Parses user input into nanometres. Accepts a bare number (interpreted in `unit`) or a
 * number with an explicit suffix: "1.2mm", "50 mil", "0.1in", "25400nm". Simple
 * expressions ("1.5*2", "10/4") are evaluated safely.
 */
export function parseDistance(text: string, unit: Unit): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  const m = /^(.*?)\s*(mm|mil|in|nm|um|µm|")?$/.exec(trimmed);
  if (!m) return null;
  const expr = m[1] ?? '';
  const suffix = m[2];
  const value = evalArithmetic(expr);
  if (value === null) return null;
  let factor: number;
  switch (suffix) {
    case 'mm':
      factor = NM_PER_MM;
      break;
    case 'mil':
      factor = NM_PER_MIL;
      break;
    case 'in':
    case '"':
      factor = NM_PER_IN;
      break;
    case 'nm':
      factor = 1;
      break;
    case 'um':
    case 'µm':
      factor = 1000;
      break;
    default:
      factor = nmPer(unit);
  }
  return Math.round(value * factor);
}

export function formatAngle(deg: number, precision = 1): string {
  if (!Number.isFinite(deg)) return '—';
  let s = deg.toFixed(precision);
  s = s.replace(/\.?0+$/, '');
  return s;
}

export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  return a;
}

/** Minimal arithmetic evaluator: + - * / ( ) and decimals. Returns null on bad input. */
export function evalArithmetic(expr: string): number | null {
  const src = expr.replace(/\s+/g, '');
  if (!src || !/^[0-9.+\-*/()]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const next = () => src[i++];
  const parseNumber = (): number | null => {
    const start = i;
    while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
    const n = Number(src.slice(start, i));
    return Number.isFinite(n) && i > start ? n : null;
  };
  const parseFactor = (): number | null => {
    const c = peek();
    if (c === '(') {
      next();
      const v = parseExpr();
      if (next() !== ')') return null;
      return v;
    }
    if (c === '-') {
      next();
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (c === '+') {
      next();
      return parseFactor();
    }
    return parseNumber();
  };
  const parseTerm = (): number | null => {
    let v = parseFactor();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = parseFactor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseExpr = (): number | null => {
    let v = parseTerm();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = parseTerm();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const result = parseExpr();
  if (result === null || i !== src.length || !Number.isFinite(result)) return null;
  return result;
}
