import './setup';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { useUiStore } from '@/state/uiStore';
import { applyTheme, DEFAULT_THEME, initialTheme, installThemeSync, readPersistedTheme, resolveThemeMode, UI_STORAGE_KEY } from '@/theme';

/** A controllable stand-in for window.matchMedia('(prefers-color-scheme: dark)'). */
function fakeMedia(initial: boolean) {
  const listeners = new Set<(ev: MediaQueryListEvent) => void>();
  const mql = {
    matches: initial,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (ev: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
  return {
    win: { matchMedia: () => mql as unknown as MediaQueryList },
    listeners,
    set(matches: boolean) {
      mql.matches = matches;
      for (const fn of listeners) fn({ matches } as MediaQueryListEvent);
    },
  };
}

const root = () => document.documentElement;
const persisted = () => JSON.parse(localStorage.getItem(UI_STORAGE_KEY) ?? 'null') as { state?: { theme?: string } } | null;

describe('theme', () => {
  beforeEach(() => {
    localStorage.removeItem(UI_STORAGE_KEY);
    root().removeAttribute('data-theme');
    root().removeAttribute('data-theme-mode');
  });
  afterEach(() => {
    useUiStore.getState().setTheme(DEFAULT_THEME);
    localStorage.removeItem(UI_STORAGE_KEY);
  });

  test('dark is the default when nothing is persisted', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readPersistedTheme({ getItem: () => null })).toBeUndefined();
    expect(initialTheme({ getItem: () => null })).toBe('dark');
    expect(useUiStore.getState().theme).toBe('dark');
  });

  test('garbage or unknown persisted values fall back to dark', () => {
    expect(initialTheme({ getItem: () => 'not json' })).toBe('dark');
    expect(initialTheme({ getItem: () => JSON.stringify({ state: { theme: 'sepia' }, version: 1 }) })).toBe('dark');
    expect(initialTheme({ getItem: () => JSON.stringify({ version: 1 }) })).toBe('dark');
    expect(
      initialTheme({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('dark');
  });

  test('a persisted light preference is respected and left untouched', async () => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ state: { theme: 'light', units: 'mil' }, version: 1 }));
    expect(readPersistedTheme()).toBe('light');
    expect(initialTheme()).toBe('light');
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe('light');
    expect(useUiStore.getState().units).toBe('mil');
    expect(persisted()?.state?.theme).toBe('light');
  });

  test('a persisted system preference is kept as well', async () => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ state: { theme: 'system' }, version: 1 }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe('system');
  });

  test('resolveThemeMode maps system onto the OS preference', () => {
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
  });

  test('applyTheme writes the resolved theme and the mode to <html>', () => {
    expect(applyTheme('light', document)).toBe('light');
    expect(root().getAttribute('data-theme')).toBe('light');
    expect(root().getAttribute('data-theme-mode')).toBe('light');
    expect(root().style.colorScheme).toBe('light');
    expect(applyTheme('system', document, fakeMedia(true).win)).toBe('dark');
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().getAttribute('data-theme-mode')).toBe('system');
  });

  test('switching the store updates data-theme live', () => {
    const off = installThemeSync(document, fakeMedia(true).win);
    expect(root().getAttribute('data-theme')).toBe('dark');
    useUiStore.getState().setTheme('light');
    expect(root().getAttribute('data-theme')).toBe('light');
    expect(root().getAttribute('data-theme-mode')).toBe('light');
    useUiStore.getState().setTheme('dark');
    expect(root().getAttribute('data-theme')).toBe('dark');
    off();
    useUiStore.getState().setTheme('light');
    expect(root().getAttribute('data-theme')).toBe('dark'); // detached
  });

  test('system mode follows prefers-color-scheme and stops listening when left', () => {
    const media = fakeMedia(false);
    const off = installThemeSync(document, media.win);
    useUiStore.getState().setTheme('system');
    expect(root().getAttribute('data-theme')).toBe('light');
    expect(root().getAttribute('data-theme-mode')).toBe('system');
    expect(media.listeners.size).toBe(1);
    media.set(true);
    expect(root().getAttribute('data-theme')).toBe('dark');
    media.set(false);
    expect(root().getAttribute('data-theme')).toBe('light');
    useUiStore.getState().setTheme('dark');
    expect(media.listeners.size).toBe(0);
    media.set(false);
    expect(root().getAttribute('data-theme')).toBe('dark');
    off();
  });

  test('the persisted choice survives a store round trip', () => {
    useUiStore.getState().setTheme('light');
    expect(persisted()?.state?.theme).toBe('light');
    useUiStore.getState().setTheme('system');
    expect(persisted()?.state?.theme).toBe('system');
  });

  test('the index.html boot script agrees with the module', () => {
    // The inline script runs before any module loads (no flash of the wrong theme); make sure
    // it reads the same key and resolves the same way as src/theme/index.ts.
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const m = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    const boot = new Function(m![1]!);
    const run = (stored: string | null, prefersDark: boolean) => {
      root().removeAttribute('data-theme');
      root().removeAttribute('data-theme-mode');
      if (stored === null) localStorage.removeItem(UI_STORAGE_KEY);
      else localStorage.setItem(UI_STORAGE_KEY, stored);
      const original = window.matchMedia;
      window.matchMedia = fakeMedia(prefersDark).win.matchMedia as typeof window.matchMedia;
      try {
        boot();
      } finally {
        window.matchMedia = original;
      }
      return [root().getAttribute('data-theme'), root().getAttribute('data-theme-mode')];
    };
    expect(run(null, false)).toEqual(['dark', 'dark']);
    expect(run(JSON.stringify({ state: { theme: 'light' }, version: 1 }), true)).toEqual(['light', 'light']);
    expect(run(JSON.stringify({ state: { theme: 'system' }, version: 1 }), true)).toEqual(['dark', 'system']);
    expect(run(JSON.stringify({ state: { theme: 'system' }, version: 1 }), false)).toEqual(['light', 'system']);
    expect(run('{broken', false)).toEqual(['dark', 'dark']);
  });
});
