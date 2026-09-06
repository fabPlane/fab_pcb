import './setup';
import { describe, expect, test } from 'bun:test';
import { fuzzyMatch } from '@/lib/fuzzy';
import { buildKeymap, effectiveBinding, registerCommands, searchCommands, type Command } from '@/commands/registry';

const noop = () => undefined;
const cmds: Command[] = [
  { id: 'view.zoomFit', title: 'Zoom to fit', group: 'View', shortcut: 'Home', run: noop },
  { id: 'view.zoomIn', title: 'Zoom in', group: 'View', shortcut: '+', run: noop },
  { id: 'inspect.runDrc', title: 'Run DRC', group: 'Inspect', keywords: ['design rules check'], when: (c) => c.editor === 'board', run: noop },
  { id: 'edit.undo', title: 'Undo', group: 'Edit', shortcut: 'Mod+Z', run: noop },
  { id: 'edit.redoAlt', title: 'Redo', group: 'Edit', shortcut: 'Mod+Shift+Z', hidden: true, run: noop },
  { id: 'view.layerBack', title: 'Active layer: B.Cu', group: 'View', shortcut: 'PageDown', run: noop },
];

describe('fuzzy', () => {
  test('matches subsequences and prefers word starts', () => {
    expect(fuzzyMatch('zf', 'Zoom to fit')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Zoom to fit')).toBeNull();
    const a = fuzzyMatch('zoom', 'View: Zoom to fit')!.score;
    const b = fuzzyMatch('zoom', 'View: Auto zoom rebuild')!.score;
    expect(a).toBeGreaterThan(b);
  });
  test('returns highlight positions', () => {
    const m = fuzzyMatch('zt', 'Zoom to fit')!;
    expect(m.positions).toEqual([0, 5]);
  });
});

describe('command registry search', () => {
  const off = registerCommands(cmds);
  test('ranks title matches first and honours when()', () => {
    const board = searchCommands('zoom', { editor: 'board' });
    expect(board[0]!.command.id).toMatch(/^view\.zoom/);
    expect(board.some((h) => h.command.id === 'inspect.runDrc')).toBe(false);
    const drcBoard = searchCommands('drc', { editor: 'board' });
    expect(drcBoard[0]!.command.id).toBe('inspect.runDrc');
    const drcSch = searchCommands('drc', { editor: 'schematic' });
    expect(drcSch.some((h) => h.command.id === 'inspect.runDrc')).toBe(false);
  });
  test('keywords match when the title does not', () => {
    const hits = searchCommands('design rules', { editor: 'board' });
    expect(hits[0]!.command.id).toBe('inspect.runDrc');
  });
  test('hidden aliases never appear, recent commands float up on an empty query', () => {
    const all = searchCommands('', { editor: 'board' }, { recent: ['edit.undo'] });
    expect(all.some((h) => h.command.id === 'edit.redoAlt')).toBe(false);
    expect(all[0]!.command.id).toBe('edit.undo');
  });
  test('layer hotkeys are searchable by layer name', () => {
    expect(searchCommands('b.cu', { editor: 'board' })[0]!.command.id).toBe('view.layerBack');
  });
  test('keymap respects overrides and unbinding', () => {
    const map = buildKeymap({ 'view.zoomFit': 'Mod+0', 'edit.undo': null });
    expect(map.get('mod+0')?.[0]?.id).toBe('view.zoomFit');
    expect(map.get('home')).toBeUndefined();
    expect(map.get('mod+z')).toBeUndefined();
    expect(map.get('mod+shift+z')?.[0]?.id).toBe('edit.redoAlt');
    expect(map.get('pagedown')?.[0]?.id).toBe('view.layerBack');
    expect(effectiveBinding(cmds[0]!, {})).toBe('Home');
    expect(effectiveBinding(cmds[0]!, { 'view.zoomFit': null })).toBeUndefined();
  });
  test('unregister removes commands', () => {
    off();
    expect(searchCommands('zoom', { editor: 'board' })).toHaveLength(0);
  });
});
