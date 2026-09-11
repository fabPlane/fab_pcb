import { useEffect, useMemo, useState } from 'react';
import { allCommands, effectiveBinding, onRegistryChange, type Command } from '@/commands/registry';
import { chordFromEvent, chordKey, formatBinding, formatChord, parseChord } from '@/lib/keys';
import { useKeymapStore } from '@/state/keymapStore';
import { useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

/**
 * The shortcut editor: filter bar plus one row per visible command with a click-to-capture
 * binding. Rendered inside the Settings dialog's Keyboard tab (SettingsDialog.tsx); the
 * standalone KeymapDialog below wraps it for callers that still want a dialog of its own.
 */
export function KeymapEditor({ maxHeight = '60vh', autoFocus = true }: { maxHeight?: string; autoFocus?: boolean }) {
  const overrides = useKeymapStore((s) => s.overrides);
  const setBinding = useKeymapStore((s) => s.setBinding);
  const resetBinding = useKeymapStore((s) => s.resetBinding);
  const [filter, setFilter] = useState('');
  const [listening, setListening] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onRegistryChange(() => setTick((t) => t + 1)), []);

  const commands = useMemo(
    () =>
      allCommands()
        .filter((c) => !c.hidden)
        .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title)),
    [tick],
  );
  const bindings = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const c of allCommands()) {
      const b = effectiveBinding(c, overrides);
      const chord = b ? parseChord(b) : null;
      if (!chord) continue;
      const k = chordKey(chord);
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    return map;
  }, [overrides, tick]);
  const conflicts = (c: Command): Command[] => {
    const b = effectiveBinding(c, overrides);
    const chord = b ? parseChord(b) : null;
    if (!chord) return [];
    return (bindings.get(chordKey(chord)) ?? []).filter((o) => o.id !== c.id && o.group === c.group);
  };

  useEffect(() => {
    if (!listening) return;
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        setListening(null);
        return;
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return;
      const chord = chordFromEvent(ev);
      const text = `${chord.ctrl ? 'Mod+' : ''}${chord.alt ? 'Alt+' : ''}${chord.shift ? 'Shift+' : ''}${chord.key === ' ' ? 'Space' : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.charAt(0).toUpperCase() + chord.key.slice(1)}`;
      setBinding(listening, text);
      setListening(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [listening, setBinding]);

  const visible = commands.filter((c) => `${c.group} ${c.title} ${effectiveBinding(c, overrides) ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="filter-bar">
        <input className="input" placeholder="Filter commands" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ flex: 1 }} autoFocus={autoFocus} aria-label="Filter commands" />
        <span className="muted">{visible.length} commands</span>
      </div>
      <div style={{ maxHeight, overflow: 'auto' }}>
        {visible.map((c) => {
          const binding = effectiveBinding(c, overrides);
          const custom = c.id in overrides;
          const conf = conflicts(c);
          return (
            <div key={c.id} className="keymap-row">
              <span className="group">{c.group}</span>
              <span>{c.title}</span>
              <span
                className={`capture${listening === c.id ? ' listening' : ''}${conf.length ? ' conflict' : ''}${custom ? ' custom' : ''}`}
                onClick={() => setListening(c.id)}
                title={conf.length ? `Conflicts with ${conf.map((x) => x.title).join(', ')}` : custom ? 'Custom binding' : 'Default binding'}
              >
                {listening === c.id ? 'Press keys…' : binding ? formatBinding(binding) : <span className="faint">unbound</span>}
              </span>
              <span style={{ display: 'flex', gap: 2 }}>
                {custom ? (
                  <button className="btn ghost sm" onClick={() => resetBinding(c.id)} title={`Reset to ${c.shortcut ? formatChord(parseChord(c.shortcut)) : 'unbound'}`}>
                    reset
                  </button>
                ) : (
                  binding && (
                    <button className="btn ghost sm" onClick={() => setBinding(c.id, null)} title="Remove binding">
                      unbind
                    </button>
                  )
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Standalone shortcuts dialog. Not mounted by default any more: the 'keymap' dialog id now
 * opens Settings on its Keyboard tab (see dialogs/index.tsx). Kept for embedding elsewhere.
 */
export function KeymapDialog() {
  const open = useUiStore((s) => s.dialog === 'keymap');
  const openDialog = useUiStore((s) => s.openDialog);
  const overrides = useKeymapStore((s) => s.overrides);
  const resetAll = useKeymapStore((s) => s.resetAll);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Keyboard Shortcuts"
      size="wide"
      noPad
      footer={
        <>
          <span className="muted">Click a shortcut and press the new key combination. Esc cancels. Stored in this browser.</span>
          <span className="spacer" />
          <button className="btn" onClick={resetAll} disabled={Object.keys(overrides).length === 0}>
            Reset all to defaults
          </button>
          <button className="btn primary" onClick={() => openDialog(null)}>
            Close
          </button>
        </>
      }
    >
      <KeymapEditor />
    </Dialog>
  );
}
