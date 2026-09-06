import './setup';
import { describe, expect, test } from 'bun:test';
import { evalArithmetic, formatDistance, mm, mil, parseDistance } from '@/lib/units';

describe('units', () => {
  test('formats nm in mm, mil and in with trimmed zeros', () => {
    expect(formatDistance(mm(1.5), 'mm')).toBe('1.5');
    expect(formatDistance(mm(0.25), 'mil')).toBe('9.84');
    expect(formatDistance(mm(25.4), 'in')).toBe('1.0');
    expect(formatDistance(0, 'mm')).toBe('0.0');
  });

  test('parses bare numbers in the current unit', () => {
    expect(parseDistance('1.5', 'mm')).toBe(1_500_000);
    expect(parseDistance('10', 'mil')).toBe(254_000);
    expect(parseDistance('0.1', 'in')).toBe(2_540_000);
  });

  test('parses explicit suffixes regardless of the current unit', () => {
    expect(parseDistance('2mm', 'mil')).toBe(2_000_000);
    expect(parseDistance('50 mil', 'mm')).toBe(mil(50));
    expect(parseDistance('0.5in', 'mm')).toBe(12_700_000);
    expect(parseDistance('25400nm', 'mm')).toBe(25_400);
    expect(parseDistance('100um', 'mm')).toBe(100_000);
  });

  test('evaluates simple expressions and rejects garbage', () => {
    expect(evalArithmetic('1.5*2')).toBe(3);
    expect(evalArithmetic('(10-4)/3')).toBe(2);
    expect(evalArithmetic('-2+5')).toBe(3);
    expect(evalArithmetic('abc')).toBeNull();
    expect(evalArithmetic('1/0')).toBeNull();
    expect(parseDistance('', 'mm')).toBeNull();
    expect(parseDistance('12 furlongs', 'mm')).toBeNull();
  });
});
