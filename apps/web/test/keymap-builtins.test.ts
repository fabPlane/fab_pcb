// The default keymap after the builtin + editing commands are registered (what main.tsx does):
// guards against chord collisions such as the zone tool taking Mod+Shift+Z from redo.
import './setup';
import { afterAll, describe, expect, test } from 'bun:test';
import { registerBuiltinCommands } from '@/commands/builtins';
import { registerEditingCommands } from '@/commands/editing';
import { buildKeymap, getCommand, type CommandContext } from '@/commands/registry';
import { createMockServices } from '@/services';

const services = createMockServices();
const offBuiltins = registerBuiltinCommands(services);
const offEditing = registerEditingCommands(services);
afterAll(() => {
  offEditing();
  offBuiltins();
});

const board: CommandContext = { editor: 'board' };
const schematic: CommandContext = { editor: 'schematic' };
const firstFor = (chord: string, ctx: CommandContext) =>
  buildKeymap({})
    .get(chord)
    ?.find((c) => !c.when || c.when(ctx))?.id;

describe('default keymap', () => {
  test('Mod+Shift+Z and Mod+Y are redo in every editor; nothing else claims them', () => {
    const map = buildKeymap({});
    expect(map.get('mod+shift+z')?.map((c) => c.id)).toEqual(['edit.redoAlt']);
    expect(map.get('mod+y')?.map((c) => c.id)).toEqual(['edit.redo']);
    expect(firstFor('mod+shift+z', board)).toBe('edit.redoAlt');
    expect(firstFor('mod+shift+z', schematic)).toBe('edit.redoAlt');
    expect(firstFor('mod+z', board)).toBe('edit.undo');
    expect(getCommand('board.drawZone')?.shortcut).toBeUndefined();
  });

  test('single-letter tool keys resolve per editor', () => {
    expect(firstFor('x', board)).toBe('board.route');
    expect(firstFor('a', board)).toBe('board.placeFootprint');
    expect(firstFor('a', schematic)).toBe('schematic.placeSymbol');
    expect(firstFor('w', schematic)).toBe('schematic.wire');
    expect(firstFor('b', schematic)).toBe('schematic.bus');
    expect(firstFor('b', board)).toBe('board.refillZones');
    expect(firstFor('v', board)).toBe('view.layerFlipSide');
    expect(firstFor('escape', board)).toBe('edit.escape');
  });

  test('no chord is claimed twice within one editor context', () => {
    const map = buildKeymap({});
    const dupes: string[] = [];
    for (const [chord, list] of map) {
      for (const ctx of [board, schematic]) {
        const live = list.filter((c) => !c.when || c.when(ctx));
        if (live.length > 1) dupes.push(`${chord} (${ctx.editor}): ${live.map((c) => c.id).join(', ')}`);
      }
    }
    expect(dupes).toEqual([]);
  });
});
