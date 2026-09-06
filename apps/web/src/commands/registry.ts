// Extensible command registry: every menu item, toolbar button, hotkey and palette entry
// is a Command. Packages can `registerCommands([...])` at import time; the palette,
// keymap and menus read from here.

import { fuzzyMatch } from '@/lib/fuzzy';
import { chordKey, parseChord } from '@/lib/keys';

export type CommandGroup = 'File' | 'Edit' | 'View' | 'Place' | 'Route' | 'Inspect' | 'Tools' | 'Board' | 'Schematic' | 'Window' | 'Help';

export interface CommandContext {
  /** Which editor is focused: gate `when` on it. */
  editor: 'project' | 'board' | 'schematic' | 'footprint';
}

export interface Command {
  id: string; // 'edit.undo'
  title: string; // 'Undo'
  group: CommandGroup;
  shortcut?: string; // default chord, e.g. 'Mod+Z'
  description?: string;
  /** Extra search terms. */
  keywords?: string[];
  /** Alias bindings (e.g. Backspace for Delete): omitted from the palette and menus. */
  hidden?: boolean;
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}

const commands = new Map<string, Command>();
const subs = new Set<() => void>();

export function registerCommands(list: Command[]): () => void {
  for (const c of list) commands.set(c.id, c);
  emit();
  return () => {
    for (const c of list) if (commands.get(c.id) === c) commands.delete(c.id);
    emit();
  };
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

export function onRegistryChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

function emit(): void {
  for (const cb of subs) cb();
}

export interface PaletteHit {
  command: Command;
  score: number;
  positions: number[];
}

export function searchCommands(query: string, ctx: CommandContext, opts: { recent?: string[]; limit?: number } = {}): PaletteHit[] {
  const recent = opts.recent ?? [];
  const limit = opts.limit ?? 50;
  const hits: PaletteHit[] = [];
  for (const command of commands.values()) {
    if (command.hidden) continue;
    if (command.when && !command.when(ctx)) continue;
    const label = `${command.group}: ${command.title}`;
    const m = fuzzyMatch(query, label);
    let score: number;
    let positions: number[] = [];
    if (m) {
      score = m.score;
      positions = m.positions;
    } else {
      const kw = (command.keywords ?? []).map((k) => fuzzyMatch(query, k)).filter((x): x is NonNullable<typeof x> => x !== null);
      const kwBest = kw.reduce<number | null>((best, x) => (best === null ? x.score : Math.max(best, x.score)), null);
      if (kwBest === null) continue;
      score = kwBest - 3;
    }
    const recentIdx = recent.indexOf(command.id);
    if (recentIdx >= 0) score += query ? 3 : 100 - recentIdx;
    hits.push({ command, score, positions });
  }
  hits.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
  return hits.slice(0, limit);
}

/** Resolves the effective binding for a command given user overrides. */
export function effectiveBinding(command: Command, overrides: Record<string, string | null>): string | undefined {
  if (command.id in overrides) return overrides[command.id] ?? undefined;
  return command.shortcut;
}

/** chordKey -> command ids, considering `when` at dispatch time. */
export function buildKeymap(overrides: Record<string, string | null>): Map<string, Command[]> {
  const map = new Map<string, Command[]>();
  for (const c of commands.values()) {
    const binding = effectiveBinding(c, overrides);
    if (!binding) continue;
    const chord = parseChord(binding);
    if (!chord) continue;
    const k = chordKey(chord);
    const list = map.get(k) ?? [];
    list.push(c);
    map.set(k, list);
  }
  return map;
}
