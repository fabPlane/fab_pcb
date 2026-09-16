import { useEffect, useMemo, useRef, useState } from 'react';
import { effectiveBinding, onRegistryChange, searchCommands, type CommandContext } from '@/commands/registry';
import { highlightSegments } from '@/lib/fuzzy';
import { formatBinding } from '@/lib/keys';
import { useAppStore } from '@/state/appStore';
import { useKeymapStore } from '@/state/keymapStore';
import { usePaletteStore } from '@/state/paletteStore';

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const query = usePaletteStore((s) => s.query);
  const setQuery = usePaletteStore((s) => s.setQuery);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const recent = usePaletteStore((s) => s.recent);
  const markUsed = usePaletteStore((s) => s.markUsed);
  const editor = useAppStore((s) => s.activeEditor);
  const overrides = useKeymapStore((s) => s.overrides);
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => onRegistryChange(() => setTick((t) => t + 1)), []);
  const ctx = useMemo<CommandContext>(() => ({ editor }), [editor]);
  const hits = useMemo(() => searchCommands(query, ctx, { recent, limit: 40 }), [query, ctx, recent, tick]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    setOpen(false);
    markUsed(hit.command.id);
    void hit.command.run(ctx);
  };

  return (
    <>
      <div className="palette-overlay" onClick={() => setOpen(false)} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="input"
          placeholder="Type a command… (e.g. “zoom fit”, “drc”, “layer b.cu”)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(active);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'PageDown') {
              setActive((a) => Math.min(a + 10, hits.length - 1));
            } else if (e.key === 'PageUp') {
              setActive((a) => Math.max(a - 10, 0));
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {hits.length === 0 && <div className="empty-state">No command matches “{query}”.</div>}
          {hits.map((h, i) => {
            const label = `${h.command.group}: ${h.command.title}`;
            const segs = highlightSegments(label, h.positions);
            const binding = effectiveBinding(h.command, overrides);
            return (
              <div key={h.command.id} role="option" aria-selected={i === active} className={`palette-item${i === active ? ' active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => run(i)}>
                <span className="group">{h.command.group}</span>
                <span className="title">{segs.slice(h.command.group.length + 2 > 0 ? 0 : 0).map((s, j) => (s.hit ? <mark key={j}>{s.text}</mark> : <span key={j}>{s.text}</span>))}</span>
                {h.command.description && <span className="desc">{h.command.description}</span>}
                {binding && <span className="kbd">{formatBinding(binding)}</span>}
              </div>
            );
          })}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span style={{ marginLeft: 'auto' }}>{hits.length} commands</span>
        </div>
      </div>
    </>
  );
}
