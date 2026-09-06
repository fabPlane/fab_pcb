// KiCad's own settings: the colour themes it ships or the user installed (`ListColorThemes` /
// `GetColorTheme`) and the editor defaults (`GetAppSettings`: units, grids, grid visibility).
//
// `GetColorTheme` answers with the same flat "board.copper.f" / "schematic.wire" keys the
// renderer's Theme uses, so a server theme drops straight into the canvas — only the colour
// channels differ (KiCad sends 0..1 floats, the renderer wants 0..255).

import { AppType, UnitSystem } from '@kicad-web/proto';
import { commands as cmd } from '@kicad-web/client';
import { KICAD_DEFAULT_THEME, mergeThemes, type Theme, type ThemeColor } from '@kicad-web/renderer';
import type { AppDefaults, ColorThemeInfo, ServerSettingsService } from '../extras';
import type { KicadDocumentService } from './KicadDocumentService';

const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));

/** KiCad's `Color` (0..1 floats) as a renderer `ThemeColor` (0..255 + alpha). */
export function toThemeColor(c: { r: number; g: number; b: number; a: number } | undefined): ThemeColor {
  return { r: ch(c?.r ?? 0), g: ch(c?.g ?? 0), b: ch(c?.b ?? 0), a: c?.a ?? 1 };
}

/** Distance strings KiCad returns for grids ("1000 mil", "0.5 mm"), in nanometres. */
export function gridToNm(s: string): number | undefined {
  const m = /^\s*([-+]?[\d.]+)\s*(mm|mil|in|thou|")?\s*$/i.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  const unit = (m[2] ?? 'mm').toLowerCase();
  if (unit === 'mm') return Math.round(v * 1e6);
  if (unit === 'mil' || unit === 'thou') return Math.round(v * 25_400);
  return Math.round(v * 25_400_000);
}

const UNITS: Record<number, AppDefaults['units']> = {
  [UnitSystem.US_MILLIMETRES]: 'mm',
  [UnitSystem.US_INCHES]: 'in',
  [UnitSystem.US_MILS]: 'mil',
};

export class KicadSettingsService implements ServerSettingsService {
  private themeList: Promise<ColorThemeInfo[]> | undefined;
  private themes = new Map<string, Promise<Theme | null>>();
  private settings = new Map<string, Promise<AppDefaults | null>>();

  constructor(
    private readonly docs: KicadDocumentService,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  private get client() {
    const k = this.docs.kicad;
    if (!k) throw new Error('not connected');
    return k.client;
  }

  colorThemes(): Promise<ColorThemeInfo[]> {
    this.themeList ??= (async () => {
      const res = await cmd.listColorThemes(this.client, {});
      this.log(`ListColorThemes: ${res.themes.map((t) => t.name).join(', ') || '(none)'}`);
      return res.themes.map((t) => ({ name: t.name, filename: t.filename, readOnly: t.readOnly }));
    })().catch((e: unknown) => {
      this.themeList = undefined;
      throw e;
    });
    return this.themeList;
  }

  colorTheme(name: string): Promise<Theme | null> {
    let p = this.themes.get(name);
    if (!p) {
      p = (async () => {
        const res = await cmd.getColorTheme(this.client, { name });
        if (!res.colors.length) return null;
        const colors: Record<string, ThemeColor> = {};
        for (const e of res.colors) if (e.key) colors[e.key] = toThemeColor(e.color);
        this.log(`GetColorTheme(${name}): ${res.colors.length} colours`);
        // Missing keys fall back to KiCad Default, exactly as KiCad does when reading a theme file.
        return mergeThemes(KICAD_DEFAULT_THEME, { name: res.theme?.name || name, colors, overrideSchItemColors: res.overrideSchematicItemColors });
      })().catch((e: unknown) => {
        this.themes.delete(name);
        throw e;
      });
      this.themes.set(name, p);
    }
    return p;
  }

  appSettings(app: 'board' | 'schematic'): Promise<AppDefaults | null> {
    let p = this.settings.get(app);
    if (!p) {
      p = (async () => {
        const res = await cmd.getAppSettings(this.client, { app: app === 'board' ? AppType.APP_PCB_EDITOR : AppType.APP_SCHEMATIC_EDITOR });
        const gridsNm = res.grids.map((g) => (g.x === g.y ? gridToNm(g.x) : undefined)).filter((n): n is number => typeof n === 'number');
        const current = res.grids[res.currentGrid];
        this.log(`GetAppSettings(${app}): units ${UNITS[res.units] ?? '?'}, theme "${res.colorTheme}", ${gridsNm.length} square grids`);
        return {
          units: UNITS[res.units],
          colorTheme: res.colorTheme,
          gridsNm,
          currentGridNm: current && current.x === current.y ? gridToNm(current.x) : undefined,
          gridVisible: res.gridVisible,
        } satisfies AppDefaults;
      })().catch((e: unknown) => {
        this.settings.delete(app);
        this.log(`GetAppSettings(${app}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
        return null;
      });
      this.settings.set(app, p);
    }
    return p;
  }
}
