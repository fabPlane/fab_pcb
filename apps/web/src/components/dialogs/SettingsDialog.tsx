import { useEffect, useState, type CSSProperties } from 'react';
import { colorToCss, layerColor, themeColor, type Theme } from '@fp-pcb/renderer';
import { getCanvasHost } from '@/canvas/CanvasSlot';
import { CANVAS_THEMES, registerServerTheme, serverThemeName, themeFor } from '@/canvas/theme';
import { useServices } from '@/services';
import type { AppDefaults, ColorThemeInfo } from '@/services/types';
import { log } from '@/state/logStore';
import { formatDistance, UNIT_ORDER, type Unit } from '@/lib/units';
import { useEditorStore } from '@/state/editorStore';
import { useKeymapStore } from '@/state/keymapStore';
import { GRID_CHOICES_NM, resolveTheme, useUiStore, type CanvasThemeId, type ThemeMode } from '@/state/uiStore';
import { THEME_MODES, systemPrefersDark } from '@/theme';
import { Dialog } from '../layout/Dialog';
import { KeymapEditor } from './KeymapDialog';
import './SettingsDialog.css';

type Tab = 'appearance' | 'keyboard';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'appearance', label: 'Appearance', glyph: '◐' },
  { id: 'keyboard', label: 'Keyboard', glyph: '⌘' },
];

/** Colours of the preview thumbnails; hand-copied from theme/tokens.css so they stay fixed while the live UI changes. */
const PREVIEW: Record<'dark' | 'light', Record<string, string>> = {
  dark: { app: '#121417', panel: '#1a1d21', border: '#2a2f36', fg: '#e6e9ee', accent: '#5c9cf5', canvas: '#001023', grid: 'rgba(132,132,132,0.35)', cuF: '#c83434', cuB: '#4d7fc4' },
  light: { app: '#e8eaee', panel: '#f6f7f9', border: '#d0d4da', fg: '#1b1f26', accent: '#2563c9', canvas: '#fafafc', grid: 'rgba(120,120,130,0.35)', cuF: '#c83434', cuB: '#3f68b0' },
};

function previewVars(t: 'dark' | 'light'): CSSProperties {
  const p = PREVIEW[t];
  return {
    '--p-app': p.app,
    '--p-panel': p.panel,
    '--p-border': p.border,
    '--p-fg': p.fg,
    '--p-accent': p.accent,
    '--p-canvas': p.canvas,
    '--p-grid': p.grid,
    '--p-cu-f': p.cuF,
    '--p-cu-b': p.cuB,
  } as CSSProperties;
}

function PreviewWindow({ theme, className }: { theme: 'dark' | 'light'; className?: string }) {
  return (
    <div className={`theme-preview${className ? ` ${className}` : ''}`} style={previewVars(theme)} aria-hidden>
      <div className="p-title">
        <i />
        <i />
        <i />
      </div>
      <div className="p-body">
        <div className="p-side">
          <i />
          <i className="sel" />
          <i />
          <i />
        </div>
        <div className="p-canvas" />
        <div className="p-side right">
          <i />
          <i />
          <i />
        </div>
      </div>
    </div>
  );
}

/** Dark / Light / System with a thumbnail each; the app itself is the live preview. */
function ThemeSwitch() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const prefersDark = systemPrefersDark();
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = THEME_MODES[(i + dir + THEME_MODES.length) % THEME_MODES.length]!;
    setTheme(next.id);
    (e.currentTarget.parentElement?.querySelector(`[data-mode="${next.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {THEME_MODES.map((m, i) => {
        const checked = theme === m.id;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-mode={m.id}
            className="seg"
            onClick={() => setTheme(m.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {m.id === 'system' ? (
              <div className="theme-preview-split" aria-hidden>
                <PreviewWindow theme="light" />
                <div className="p-half">
                  <PreviewWindow theme="dark" />
                </div>
              </div>
            ) : (
              <PreviewWindow theme={m.id} />
            )}
            <span className="label">
              {m.label}
              {checked && <span className="check">✓</span>}
            </span>
            <span className="hint">{m.id === 'system' ? `${m.hint} (now ${prefersDark ? 'dark' : 'light'})` : m.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function CanvasSwatches({ theme }: { theme: Theme }) {
  const entries: [string, string][] = [
    ['Background', colorToCss(themeColor(theme, 'board.background'))],
    ['Grid', colorToCss(themeColor(theme, 'board.grid'))],
    ['Axes', colorToCss(themeColor(theme, 'board.grid_axes'))],
    ['F.Cu', colorToCss(layerColor(theme, 'BL_F_Cu'))],
    ['B.Cu', colorToCss(layerColor(theme, 'BL_B_Cu'))],
    ['Edge', colorToCss(layerColor(theme, 'BL_Edge_Cuts'))],
    ['Silk', colorToCss(layerColor(theme, 'BL_F_SilkS'))],
    ['Sch bg', colorToCss(themeColor(theme, 'schematic.background'))],
    ['Wire', colorToCss(themeColor(theme, 'schematic.wire'))],
  ];
  return (
    <div className="swatch-row" aria-label="Canvas colours">
      {entries.map(([label, css]) => (
        <span key={label} className="swatch" title={`${label}: ${css}`}>
          <i style={{ background: css }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Pushes the current canvas theme to every mounted canvas host (CanvasSlot only reacts to UI-theme changes). */
function retintCanvases(mode: ThemeMode, canvas: CanvasThemeId): void {
  const theme = themeFor(resolveTheme(mode), canvas);
  for (const key of Object.keys(useEditorStore.getState().docs)) getCanvasHost(key)?.setTheme(theme);
}

function AppearanceTab() {
  const { settings } = useServices();
  const theme = useUiStore((s) => s.theme);
  const canvasTheme = useUiStore((s) => s.canvasTheme);
  const setCanvasTheme = useUiStore((s) => s.setCanvasTheme);
  const units = useUiStore((s) => s.units);
  const setUnits = useUiStore((s) => s.setUnits);
  const gridNm = useUiStore((s) => s.gridNm);
  const setGrid = useUiStore((s) => s.setGrid);
  const showGrid = useUiStore((s) => s.showGrid);
  const toggleGrid = useUiStore((s) => s.toggleGrid);
  const resolved = resolveTheme(theme);
  const [serverThemes, setServerThemes] = useState<ColorThemeInfo[]>([]);
  const [defaults, setDefaults] = useState<AppDefaults | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);

  // KiCad's own themes and editor defaults; both are cached by the service.
  useEffect(() => {
    if (!settings) return;
    let live = true;
    settings
      .colorThemes()
      .then((t) => live && setServerThemes(t))
      .catch((e: unknown) => live && setThemeError(e instanceof Error ? e.message : String(e)));
    settings
      .appSettings('board')
      .then((d) => live && setDefaults(d))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [settings]);

  // A persisted `server:<name>` needs its colours fetched before `themeFor` can resolve it.
  useEffect(() => {
    const name = serverThemeName(canvasTheme);
    if (!settings || !name) return;
    void settings
      .colorTheme(name)
      .then((t) => {
        if (!t) return;
        registerServerTheme(name, t);
        retintCanvases(theme, canvasTheme);
      })
      .catch(() => undefined);
  }, [settings, canvasTheme, theme]);

  const canvas = themeFor(resolved, canvasTheme);
  const pickCanvas = async (id: CanvasThemeId) => {
    const name = serverThemeName(id);
    if (name && settings) {
      try {
        const t = await settings.colorTheme(name);
        if (t) registerServerTheme(name, t);
        else setThemeError(`KiCad returned no colours for "${name}"`);
      } catch (e) {
        setThemeError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setCanvasTheme(id);
    retintCanvases(theme, id);
    log(`canvas theme: ${id}`);
  };
  const applyServerDefaults = () => {
    if (!defaults) return;
    if (defaults.units) setUnits(defaults.units);
    if (defaults.currentGridNm) setGrid(defaults.currentGridNm);
    log(`Applied KiCad defaults: ${defaults.units ?? '?'} units, grid ${defaults.currentGridNm ?? '?'} nm`);
  };
  const serverGrids = defaults?.gridsNm ?? [];
  const gridChoices = [...new Set([...GRID_CHOICES_NM, ...serverGrids, gridNm])].sort((a, b) => b - a);
  return (
    <>
      <h3 className="section">Theme</h3>
      <ThemeSwitch />
      <p className="note">Applies immediately and is remembered in this browser. Dark is the default; System follows the operating system and switches live.</p>

      <h3 className="section">Canvas colours</h3>
      <div className="form-grid">
        <label htmlFor="settings-canvas-theme">Colour theme</label>
        <select id="settings-canvas-theme" data-testid="canvas-theme" className="select" value={canvasTheme} onChange={(e) => void pickCanvas(e.target.value as CanvasThemeId)}>
          {CANVAS_THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
          {serverThemes.length > 0 && (
            <optgroup label="From KiCad (ListColorThemes)">
              {serverThemes.map((t) => (
                <option key={t.name} value={`server:${t.name}`}>
                  {t.name}
                  {t.readOnly ? ' (built in)' : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <span className="help">
          {CANVAS_THEMES.find((t) => t.id === canvasTheme)?.description ?? `Colours read from KiCad itself (${serverThemeName(canvasTheme)}).`}
          {themeError ? ` — ${themeError}` : ''}
        </span>
        <label>Preview</label>
        <div>
          <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            {canvas.name}
          </span>
          <CanvasSwatches theme={canvas} />
        </div>
      </div>

      <h3 className="section">Editing defaults</h3>
      <div className="form-grid">
        <label htmlFor="settings-units">Units</label>
        <select id="settings-units" className="select" value={units} onChange={(e) => setUnits(e.target.value as Unit)}>
          {UNIT_ORDER.map((u) => (
            <option key={u} value={u}>
              {u === 'mm' ? 'Millimetres (mm)' : u === 'mil' ? 'Mils (thou)' : 'Inches (in)'}
            </option>
          ))}
        </select>
        <label htmlFor="settings-grid">Grid</label>
        <select id="settings-grid" className="select" value={gridNm} onChange={(e) => setGrid(Number(e.target.value))}>
          {gridChoices.map((nm) => (
            <option key={nm} value={nm}>
              {formatDistance(nm, units)} {units}
            </option>
          ))}
        </select>
        <label htmlFor="settings-show-grid">Show grid</label>
        <span>
          <input id="settings-show-grid" type="checkbox" className="checkbox" checked={showGrid} onChange={toggleGrid} />
        </span>
      </div>

      {defaults && (
        <>
          <h3 className="section">KiCad defaults</h3>
          <p className="note">What the PCB editor itself is configured to use (`GetAppSettings`). The app keeps its own preferences; this applies KiCad's.</p>
          <div className="form-grid" data-testid="kicad-defaults">
            <label>Units</label>
            <div className="muted">{defaults.units ?? 'unknown'}</div>
            <label>Grid</label>
            <div className="muted">
              {defaults.currentGridNm ? `${formatDistance(defaults.currentGridNm, defaults.units ?? units)} ${defaults.units ?? units}` : 'unknown'} · {defaults.gridsNm.length} square grid(s) offered
            </div>
            <label>Colour theme</label>
            <div className="muted mono">{defaults.colorTheme}</div>
            <label>Grid visible</label>
            <div className="muted">{defaults.gridVisible ? 'yes' : 'no'}</div>
            <label />
            <div>
              <button className="btn sm" data-testid="apply-kicad-defaults" onClick={applyServerDefaults}>
                Use KiCad's defaults
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Settings: Appearance (UI theme, canvas colours, editing defaults) and Keyboard (the shortcut
 * editor). Opens on the 'settings' dialog id; the legacy 'keymap' id opens it on Keyboard.
 */
export function SettingsDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const overrides = useKeymapStore((s) => s.overrides);
  const resetAll = useKeymapStore((s) => s.resetAll);
  const open = dialog === 'settings' || dialog === 'keymap';
  const [tab, setTab] = useState<Tab>('appearance');
  useEffect(() => {
    if (dialog === 'keymap') setTab('keyboard');
    else if (dialog === 'settings') setTab('appearance');
  }, [dialog]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && openDialog(null)}
      title="Settings"
      size="wide"
      noPad
      footer={
        <>
          {tab === 'keyboard' ? (
            <>
              <span className="muted">Click a shortcut and press the new key combination. Esc cancels. Stored in this browser.</span>
              <span className="spacer" />
              <button className="btn" onClick={resetAll} disabled={Object.keys(overrides).length === 0}>
                Reset all to defaults
              </button>
            </>
          ) : (
            <>
              <span className="muted">Changes apply immediately.</span>
              <span className="spacer" />
            </>
          )}
          <button className="btn primary" onClick={() => openDialog(null)}>
            Close
          </button>
        </>
      }
    >
      <div className="settings-dialog">
        <div className="dialog-sidebar">
          <nav aria-label="Settings sections">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
                <span className="glyph" aria-hidden>
                  {t.glyph}
                </span>
                {t.label}
              </button>
            ))}
          </nav>
          {tab === 'appearance' ? (
            <section aria-label="Appearance">
              <AppearanceTab />
            </section>
          ) : (
            <section className="settings-keys" aria-label="Keyboard shortcuts">
              <KeymapEditor maxHeight="calc(88vh - 150px)" />
            </section>
          )}
        </div>
      </div>
    </Dialog>
  );
}
