// Keyboard chord parsing/formatting shared by the keymap store, palette and settings dialog.

export interface Chord {
  key: string; // lower-case KeyboardEvent.key, e.g. 'm', 'delete', 'arrowup', '+', 'f1'
  ctrl: boolean; // Ctrl on Windows/Linux, Cmd on macOS ("mod")
  shift: boolean;
  alt: boolean;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

const ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  space: ' ',
  plus: '+',
  minus: '-',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  cmd: 'mod',
  meta: 'mod',
  ctrl: 'mod',
  control: 'mod',
  option: 'alt',
};

/** Parses "Mod+Shift+Z", "Ctrl+K", "Delete", "+" into a Chord. */
export function parseChord(text: string): Chord | null {
  const raw = text.trim();
  if (!raw) return null;
  // split on '+' but allow the literal '+' key at the end ("Ctrl++", "+")
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '+' && buf.length > 0 && i < raw.length - 1) {
      parts.push(buf);
      buf = '';
    } else buf += c;
  }
  parts.push(buf);
  const chord: Chord = { key: '', ctrl: false, shift: false, alt: false };
  for (const p of parts) {
    const lower = p.trim().toLowerCase();
    const name = ALIASES[lower] ?? lower;
    if (name === 'mod') chord.ctrl = true;
    else if (name === 'shift') chord.shift = true;
    else if (name === 'alt') chord.alt = true;
    else chord.key = name;
  }
  if (!chord.key) return null;
  return chord;
}

export function chordFromEvent(ev: KeyboardEvent): Chord {
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
  return {
    key,
    ctrl: isMac ? ev.metaKey : ev.ctrlKey,
    shift: ev.shiftKey,
    alt: ev.altKey,
  };
}

export function chordKey(c: Chord): string {
  return `${c.ctrl ? 'mod+' : ''}${c.alt ? 'alt+' : ''}${c.shift ? 'shift+' : ''}${c.key}`;
}

export function formatChord(c: Chord | null): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.ctrl) parts.push(isMac ? '⌘' : 'Ctrl');
  if (c.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (c.shift) parts.push(isMac ? '⇧' : 'Shift');
  const names: Record<string, string> = {
    escape: 'Esc',
    delete: 'Del',
    backspace: '⌫',
    enter: '↵',
    ' ': 'Space',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
  };
  parts.push(names[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0]!.toUpperCase() + c.key.slice(1)));
  return parts.join(isMac ? '' : '+');
}

export function formatBinding(text: string | undefined): string {
  if (!text) return '';
  return formatChord(parseChord(text));
}
