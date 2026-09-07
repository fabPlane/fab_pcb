/**
 * `Settings` — read access to the user's KiCad settings (`common/commands/settings_commands.proto`,
 * KiCad >= 11.0): the colour themes and the editors' application settings. Reachable as
 * `kicad.settings`; none of these need a document (or even a project) open.
 *
 * The board's own "Text & Graphics Defaults" are *not* here — they live in the document, see
 * `board.graphicsDefaults()` / `board.setGraphicsDefaults()`. `AppSettings.defaults` carries the
 * equivalent for the schematic editor (whose defaults are application-wide).
 */
import { AppType, UnitSystem, type AppSettings, type Color } from "@fp-pcb/proto";
import * as cmd from "../commands";
import type { KiCad } from "./kicad";

/**
 * One colour of a theme. `r`/`g`/`b` are 0..255 integers and `a` is 0..1 — the same shape as
 * `@fp-pcb/renderer`'s `ThemeColor` (KiCad's `COLOR4D` on the wire is 0..1 per channel).
 */
export interface ThemeColor {
  /** 0..255 */
  r: number;
  /** 0..255 */
  g: number;
  /** 0..255 */
  b: number;
  /** 0..1 */
  a: number;
}

/** A theme as `ListColorThemes` describes it, without its colours. */
export interface ColorThemeSummary {
  /** Display name, as the preferences show it ("KiCad Default"). */
  name: string;
  /** File name without extension in the user's colors folder; the built-in themes have none. */
  filename: string;
  /** Built-in and system themes cannot be edited. */
  readOnly: boolean;
}

/**
 * A full theme.
 *
 * `colors` is keyed by KiCad's own flat theme-file keys ("board.copper.f", "schematic.wire",
 * "3d_viewer.background_top", ...) — exactly the keys `COLOR_SETTINGS` writes into
 * `~/.config/kicad/<ver>/colors/*.json`, and exactly the keys the renderer's `themeFromJson`
 * produces when it walks that JSON. So `{ name, colors, overrideSchItemColors }` is structurally
 * the renderer's `Theme`:
 *
 *     host.setTheme(await kicad.settings.colorTheme("KiCad Default"));
 *
 * `layers` maps the same keys to KiCad's numeric layer ids (`PCB_LAYER_ID` / `GAL_LAYER_ID` /
 * `SCH_LAYER_ID`), which the renderer does not need but a layer-id-driven caller does.
 */
export interface ColorTheme extends ColorThemeSummary {
  /** Flat theme key -> colour. */
  colors: Record<string, ThemeColor>;
  /** Whether the schematic colours override the colours symbols carry themselves. */
  overrideSchItemColors: boolean;
  /** Flat theme key -> KiCad layer id. */
  layers: Record<string, number>;
}

/** Short names for `AppType`, so callers need not import the enum. */
export type AppName = "pcb" | "schematic" | "footprint" | "symbol";

const APP_BY_NAME: Record<AppName, AppType> = {
  pcb: AppType.APP_PCB_EDITOR,
  schematic: AppType.APP_SCHEMATIC_EDITOR,
  footprint: AppType.APP_FOOTPRINT_EDITOR,
  symbol: AppType.APP_SYMBOL_EDITOR,
};

export function toAppType(app: AppType | AppName): AppType {
  return typeof app === "string" ? APP_BY_NAME[app] : app;
}

/** `COLOR4D` (0..1 doubles) -> `ThemeColor` (0..255 channels, 0..1 alpha). */
export function toThemeColor(c: Color | undefined): ThemeColor {
  if (!c) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: Math.max(0, Math.min(1, c.a)) };
}

/** Millimetres / inches / mils as an editor's `AppSettings.units`, as a short string. */
export function unitSuffix(units: UnitSystem): string {
  switch (units) {
    case UnitSystem.US_MILLIMETRES:
      return "mm";
    case UnitSystem.US_INCHES:
      return "in";
    case UnitSystem.US_MILS:
      return "mil";
    default:
      return "";
  }
}

export class Settings {
  constructor(readonly kicad: KiCad) {}

  get client() {
    return this.kicad.client;
  }

  /**
   * `ListColorThemes`: the built-in themes plus the system, PCM and user ones, in KiCad's own
   * order. A stock install answers "KiCad Classic" and "KiCad Default".
   */
  async colorThemes(): Promise<ColorThemeSummary[]> {
    const res = await cmd.listColorThemes(this.client, {});
    return res.themes.map((t) => ({ name: t.name, filename: t.filename, readOnly: t.readOnly }));
  }

  /**
   * `GetColorTheme`: every colour of one theme, by display name (case-insensitive) or file name.
   * The empty default asks for KiCad's built-in default theme. An unknown name is `AS_BAD_REQUEST`.
   *
   * KICAD-BUG: "KiCad Classic" comes back with an empty `colors` map. `COLOR_SETTINGS::
   * CreateBuiltinColorSettings()` clears the classic theme's `m_params` to disable load/store, and
   * the handler enumerates keys through `GetColorKeys()`, which reads exactly those params — so
   * only the default theme (and themes loaded from JSON) report any colours. Callers that need a
   * complete theme should merge over the renderer's built-in default, as `loadUserTheme` does.
   */
  async colorTheme(name = ""): Promise<ColorTheme> {
    const res = await cmd.getColorTheme(this.client, { name });
    const colors: Record<string, ThemeColor> = {};
    const layers: Record<string, number> = {};
    for (const e of res.colors) {
      colors[e.key] = toThemeColor(e.color);
      layers[e.key] = e.layer;
    }
    return {
      name: res.theme?.name ?? name,
      filename: res.theme?.filename ?? "",
      readOnly: res.theme?.readOnly ?? false,
      colors,
      overrideSchItemColors: res.overrideSchematicItemColors,
      layers,
    };
  }

  /**
   * `GetAppSettings`: the subset of one editor's settings a client needs to show a document the way
   * that editor would — units, colour theme (by *file* name, e.g. `_builtin_default`), grid list
   * and the selected grid, zoom factors, undo depth, the editor's item defaults and the settings
   * file they came from. `APP_UNKNOWN` is `AS_BAD_REQUEST`.
   *
   * Sizes in `grids` and `defaults` are the user's own strings ("1.0 mm", "50 mil", "6" in the
   * schematic file's mils) — deliberately not converted to nm, since KiCad stores them verbatim.
   */
  appSettings(app: AppType | AppName): Promise<AppSettings> {
    return cmd.getAppSettings(this.client, { app: toAppType(app) });
  }

  /** The grid an editor currently has selected (`grids[currentGrid]`), if any. */
  async currentGrid(app: AppType | AppName): Promise<{ name: string; x: string; y: string } | undefined> {
    const s = await this.appSettings(app);
    const g = s.grids[s.currentGrid];
    return g ? { name: g.name, x: g.x, y: g.y } : undefined;
  }
}
