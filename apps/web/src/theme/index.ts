// UI theme: resolves the persisted preference ('dark' | 'light' | 'system') to the concrete
// theme and keeps `<html data-theme>` in sync with the store and, in system mode, with
// prefers-color-scheme. The same logic runs before the first paint as the inline script in
// index.html (which only reads localStorage), so keep `readPersistedTheme` /
// `resolveThemeMode` in step with it.
//
// Tokens live in ./tokens.css; the canvas colour themes in ../canvas/theme.ts.

import { useEffect } from 'react';
import { useUiStore, type ThemeMode } from '@/state/uiStore';

export type ResolvedTheme = 'light' | 'dark';

/** localStorage key of the persisted UI store (zustand persist, `{ state, version }`). */
export const UI_STORAGE_KEY = 'kicad-web.ui';

/** What new users get. Only the persisted preference overrides it. */
export const DEFAULT_THEME: ThemeMode = 'dark';

export const THEME_MODES: readonly { id: ThemeMode; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Low-glare, the default' },
  { id: 'light', label: 'Light', hint: 'Bright surfaces, dark text' },
  { id: 'system', label: 'System', hint: 'Follows the OS setting' },
];

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light' || v === 'system';
}

/** The theme stored by an earlier session, or undefined when nothing (valid) is persisted. */
export function readPersistedTheme(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): ThemeMode | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(UI_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { state?: { theme?: unknown } } | null;
    const theme = parsed?.state?.theme;
    return isThemeMode(theme) ? theme : undefined;
  } catch {
    return undefined;
  }
}

/** Initial mode for a fresh store: persisted preference (any value, 'light' included) or dark. */
export function initialTheme(storage?: Pick<Storage, 'getItem'>): ThemeMode {
  return readPersistedTheme(storage) ?? DEFAULT_THEME;
}

type MediaWindow = Pick<Window, 'matchMedia'>;

export function systemPrefersDark(win: MediaWindow | undefined = defaultWindow()): boolean {
  if (!win || typeof win.matchMedia !== 'function') return true; // no media queries: stay dark
  try {
    return win.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean = systemPrefersDark()): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** Writes the resolved theme to the root element. Returns what was applied. */
export function applyTheme(mode: ThemeMode, doc: Document | undefined = defaultDocument(), win?: MediaWindow): ResolvedTheme {
  const resolved = resolveThemeMode(mode, systemPrefersDark(win ?? defaultWindow()));
  if (doc) {
    const root = doc.documentElement;
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-mode', mode);
    root.style.colorScheme = resolved;
  }
  return resolved;
}

/** The theme currently applied to the document (falls back to resolving the store). */
export function currentTheme(doc: Document | undefined = defaultDocument()): ResolvedTheme {
  const v = doc?.documentElement.getAttribute('data-theme');
  if (v === 'light' || v === 'dark') return v;
  return resolveThemeMode(useUiStore.getState().theme);
}

/**
 * Applies the store's theme now and whenever it changes; in system mode also follows
 * prefers-color-scheme changes. Returns a disposer.
 */
export function installThemeSync(doc: Document | undefined = defaultDocument(), win: MediaWindow | undefined = defaultWindow()): () => void {
  let mq: MediaQueryList | null = null;
  const onMedia = () => applyTheme(useUiStore.getState().theme, doc, win);
  const detachMedia = () => {
    mq?.removeEventListener?.('change', onMedia);
    mq = null;
  };
  const sync = (mode: ThemeMode) => {
    applyTheme(mode, doc, win);
    detachMedia();
    if (mode === 'system' && win && typeof win.matchMedia === 'function') {
      try {
        mq = win.matchMedia('(prefers-color-scheme: dark)');
        mq.addEventListener?.('change', onMedia);
      } catch {
        mq = null;
      }
    }
  };
  sync(useUiStore.getState().theme);
  const unsubscribe = useUiStore.subscribe((s, prev) => {
    if (s.theme !== prev.theme) sync(s.theme);
  });
  return () => {
    unsubscribe();
    detachMedia();
  };
}

/** React hook wrapper around installThemeSync for the app root. */
export function useThemeSync(): void {
  useEffect(() => installThemeSync(), []);
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

function defaultWindow(): Window | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

function defaultDocument(): Document | undefined {
  return typeof document !== 'undefined' ? document : undefined;
}
