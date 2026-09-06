import { useEffect } from 'react';
import { buildKeymap, onRegistryChange, type CommandContext } from '@/commands/registry';
import { chordFromEvent, chordKey } from '@/lib/keys';
import { useAppStore } from '@/state/appStore';
import { useKeymapStore } from '@/state/keymapStore';
import { usePaletteStore } from '@/state/paletteStore';
import { useUiStore } from '@/state/uiStore';

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Installs the global hotkey dispatcher. */
export function useKeyboard(): void {
  useEffect(() => {
    let keymap = buildKeymap(useKeymapStore.getState().overrides);
    const rebuild = () => {
      keymap = buildKeymap(useKeymapStore.getState().overrides);
    };
    const offRegistry = onRegistryChange(rebuild);
    const offStore = useKeymapStore.subscribe(rebuild);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.isComposing || ev.repeat) return;
      const chord = chordFromEvent(ev);
      const inText = isTextTarget(ev.target);
      // Inside text fields only chords with a modifier (or Escape) reach commands.
      if (inText && !chord.ctrl && !chord.alt && chord.key !== 'escape') return;
      // Let Radix dialogs/menus and the palette own their keys.
      if (usePaletteStore.getState().open) return;
      if (useUiStore.getState().dialog) return;
      const candidates = keymap.get(chordKey(chord));
      if (!candidates?.length) return;
      const ctx: CommandContext = { editor: useAppStore.getState().activeEditor };
      const cmd = candidates.find((c) => !c.when || c.when(ctx));
      if (!cmd) return;
      ev.preventDefault();
      ev.stopPropagation();
      void cmd.run(ctx);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      offRegistry();
      offStore();
    };
  }, []);
}
