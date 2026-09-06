import './setup';
import { describe, expect, test } from 'bun:test';
import { chordKey, parseChord } from '@/lib/keys';

describe('chords', () => {
  test('parses modifiers and aliases', () => {
    expect(chordKey(parseChord('Mod+Shift+Z')!)).toBe('mod+shift+z');
    expect(chordKey(parseChord('Ctrl+K')!)).toBe('mod+k');
    expect(chordKey(parseChord('Cmd+,')!)).toBe('mod+,');
    expect(chordKey(parseChord('Delete')!)).toBe('delete');
    expect(chordKey(parseChord('Del')!)).toBe('delete');
    expect(chordKey(parseChord('Esc')!)).toBe('escape');
    expect(chordKey(parseChord('PageUp')!)).toBe('pageup');
    expect(chordKey(parseChord('Alt+Backspace')!)).toBe('alt+backspace');
  });
  test('handles the literal plus and minus keys', () => {
    expect(chordKey(parseChord('+')!)).toBe('+');
    expect(chordKey(parseChord('-')!)).toBe('-');
    expect(chordKey(parseChord('Mod++')!)).toBe('mod++');
    expect(parseChord('')).toBeNull();
  });
});
