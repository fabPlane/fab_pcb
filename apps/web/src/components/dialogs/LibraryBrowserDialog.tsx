// The library browser: KiCad's fp-lib-table / sym-lib-table on the left, the selected library's
// entries in the middle (searchable, cached per library by the service) and a live preview of the
// selected entry on the right, rendered by the same canvas hosts the editors use over a
// throwaway one-item store.
//
// It replaces the type-a-LIB_ID prompt of the placement commands; typing is still available
// through the "Library id" field at the bottom, which accepts anything the tables resolve.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasHost, ItemStore } from '@/contracts';
import { createCanvasHost } from '@/canvas/hostFactory';
import { themeFor } from '@/canvas/theme';
import { useServices } from '@/services';
import type { LibraryEntrySummary, LibraryTableEntry } from '@/services/types';
import { useLibraryStore } from '@/state/libraryStore';
import { resolveTheme, useUiStore } from '@/state/uiStore';
import { Dialog } from '../layout/Dialog';

/** Renders one library item with the real canvas host over a single-item store. */
function EntryPreview({ kind, libId }: { kind: 'footprint' | 'symbol'; libId: string }) {
  const { library } = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const hostRef = useRef<CanvasHost | null>(null);
  const themeMode = useUiStore((s) => s.theme);
  const canvasTheme = useUiStore((s) => s.canvasTheme);
  const [store, setStore] = useState<ItemStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!library || !libId) {
      setStore(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    library
      .preview(kind, libId)
      .then((s) => {
        if (!live) return;
        setStore(s);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setStore(null);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [library, kind, libId]);

  // One host for the life of the dialog; switching entries swaps the store rather than
  // remounting, which keeps a second PixiJS application from being created per click.
  useEffect(() => {
    const el = ref.current;
    if (!el || !store) return;
    let host = hostRef.current;
    if (!host) {
      host = createCanvasHost(kind, `preview:${kind}`, store);
      hostRef.current = host;
      host.mount(el, store, themeFor(resolveTheme(themeMode), canvasTheme));
    } else {
      (host as CanvasHost & { setStore?: (s: ItemStore) => void }).setStore?.(store);
    }
    // The renderer hosts finish their first paint asynchronously (`ready`), and the server pad /
    // text shapes arrive after that, so frame the item on ready and again shortly after.
    const live = host;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fit = () => hostRef.current === live && live.zoomToFit();
    const ready = (live as CanvasHost & { ready?: Promise<unknown> }).ready;
    if (ready) void ready.then(fit).catch(() => undefined);
    else timers.push(setTimeout(fit, 120));
    timers.push(setTimeout(fit, 400), setTimeout(fit, 1000));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [store, kind, themeMode, canvasTheme]);

  // Tear the host down only when the preview itself goes away (the dialog closed, or the kind
  // changed). React's strict mode runs mount/cleanup twice, and destroying a PixiJS host before
  // its own async init finished throws inside the renderer, so wait for `ready` first.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      hostRef.current = null;
      if (!host) return;
      const ready = (host as CanvasHost & { ready?: Promise<unknown> }).ready;
      if (ready) void ready.then(() => host.unmount()).catch(() => undefined);
      else host.unmount();
    };
  }, [kind]);

  return (
    <div className="lib-preview" data-testid="library-preview">
      <div className="lib-preview-canvas" ref={ref} />
      {!libId && <div className="empty-state">Select an entry to preview it.</div>}
      {loading && <div className="empty-state">Loading {libId}…</div>}
      {error && (
        <div className="empty-state" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function EntryMeta({ entry }: { entry: LibraryEntrySummary | undefined }) {
  if (!entry) return null;
  return (
    <dl className="lib-meta">
      <dt>Id</dt>
      <dd className="mono">{entry.libId}</dd>
      {entry.description && (
        <>
          <dt>Description</dt>
          <dd>{entry.description}</dd>
        </>
      )}
      {entry.keywords && (
        <>
          <dt>Keywords</dt>
          <dd className="muted">{entry.keywords}</dd>
        </>
      )}
      {entry.padCount !== undefined && (
        <>
          <dt>Pads</dt>
          <dd>
            {entry.padCount}
            {entry.mounting ? ` · ${entry.mounting}` : ''}
          </dd>
        </>
      )}
      {entry.unitCount !== undefined && (
        <>
          <dt>Units</dt>
          <dd>
            {entry.unitCount}
            {entry.isPower ? ' · power symbol' : ''}
          </dd>
        </>
      )}
      {entry.defaultFootprint && (
        <>
          <dt>Footprint</dt>
          <dd className="mono">{entry.defaultFootprint}</dd>
        </>
      )}
    </dl>
  );
}

export function LibraryBrowserDialog() {
  const { library } = useServices();
  const request = useLibraryStore((s) => s.request);
  const finish = useLibraryStore((s) => s.finish);
  const nicknames = useLibraryStore((s) => s.nickname);
  const selectedAll = useLibraryStore((s) => s.selected);
  const setNickname = useLibraryStore((s) => s.setNickname);
  const setSelected = useLibraryStore((s) => s.setSelected);
  const filter = useLibraryStore((s) => s.filter);
  const setFilter = useLibraryStore((s) => s.setFilter);

  const kind = request?.kind ?? 'footprint';
  const nickname = nicknames[kind];
  const selected = selectedAll[kind];

  const [tables, setTables] = useState<LibraryTableEntry[]>([]);
  const [entries, setEntries] = useState<LibraryEntrySummary[]>([]);
  const [libFilter, setLibFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  // libraries of the current kind
  useEffect(() => {
    if (!request || !library) return;
    let live = true;
    setError(null);
    library
      .tables(kind)
      .then((t) => {
        if (!live) return;
        setTables(t);
        if (!t.some((r) => r.nickname === nickname)) setNickname(kind, t[0]?.nickname ?? '');
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, library, kind]);

  // entries of the selected library
  useEffect(() => {
    if (!request || !library || !nickname) {
      setEntries([]);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    library
      .entries(kind, nickname, filter)
      .then((e) => {
        if (!live) return;
        setEntries(e);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [request, library, kind, nickname, filter]);

  const visibleLibs = useMemo(() => {
    const q = libFilter.trim().toLowerCase();
    return q ? tables.filter((t) => t.nickname.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : tables;
  }, [tables, libFilter]);

  const current = entries.find((e) => e.libId === selected);
  const chosen = typed.trim() || selected;
  const confirm = useCallback(() => {
    if (!chosen) return;
    finish(chosen);
  }, [chosen, finish]);

  if (!request) return null;
  const confirmLabel = request.purpose === 'assign' ? 'Assign' : request.purpose === 'browse' ? 'Close' : kind === 'footprint' ? 'Place on board' : 'Place on schematic';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && finish(null)}
      title={request.title}
      description={request.description}
      size="wide"
      noPad
      footer={
        <>
          <label htmlFor="lib-typed" className="muted">
            Library id
          </label>
          <input
            id="lib-typed"
            className="input mono"
            data-testid="library-libid"
            style={{ width: 300 }}
            placeholder={selected || (kind === 'footprint' ? 'Library:Footprint' : 'Library:Symbol')}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
          <span className="spacer" />
          <button className="btn" onClick={() => finish(null)}>
            Cancel
          </button>
          <button className="btn primary" data-testid="library-confirm" disabled={!chosen} onClick={confirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="library-browser">
        <div className="lib-col libs">
          <div className="filter-bar">
            <input className="input" placeholder={`Filter ${tables.length} libraries`} value={libFilter} onChange={(e) => setLibFilter(e.target.value)} aria-label="Filter libraries" />
          </div>
          <div className="lib-list" role="listbox" aria-label="Libraries">
            {visibleLibs.map((t) => (
              <button
                key={`${t.scope}:${t.nickname}`}
                role="option"
                aria-selected={t.nickname === nickname}
                className={`lib-row${t.nickname === nickname ? ' selected' : ''}`}
                onClick={() => setNickname(kind, t.nickname)}
                title={t.uri}
              >
                <span className="name">{t.nickname}</span>
                <span className={`scope ${t.scope}`}>{t.scope === 'project' ? 'project' : 'global'}</span>
              </button>
            ))}
            {visibleLibs.length === 0 && <div className="empty-state">{error ? error : tables.length ? 'No library matches the filter.' : 'Reading the library tables…'}</div>}
          </div>
        </div>

        <div className="lib-col entries">
          <div className="filter-bar">
            <input
              className="input"
              data-testid="library-search"
              placeholder={nickname ? `Search ${nickname}` : 'Search'}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search entries"
            />
            <span className="muted">{loading ? 'loading…' : `${entries.length}`}</span>
          </div>
          <div className="lib-list" role="listbox" aria-label="Library entries">
            {entries.map((e) => (
              <button
                key={e.libId}
                role="option"
                aria-selected={e.libId === selected}
                className={`lib-row entry${e.libId === selected ? ' selected' : ''}`}
                data-libid={e.libId}
                onClick={() => {
                  setSelected(kind, e.libId);
                  setTyped('');
                }}
                onDoubleClick={() => finish(e.libId)}
              >
                <span className="name mono">{e.name}</span>
                <span className="desc muted">{e.description}</span>
              </button>
            ))}
            {entries.length === 0 && !loading && <div className="empty-state">{error ?? (nickname ? 'Nothing in this library matches.' : 'Pick a library.')}</div>}
          </div>
        </div>

        <div className="lib-col preview">
          <EntryPreview kind={kind} libId={selected} />
          <EntryMeta entry={current} />
        </div>
      </div>
    </Dialog>
  );
}
