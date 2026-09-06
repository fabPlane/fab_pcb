/** Layer 3 `Settings`: colour/enum conversion and the shape `colorTheme()` hands the renderer. */
import { describe, expect, test } from "bun:test";
import {
  AppSettingsSchema,
  AppType,
  ColorThemeResponseSchema,
  ColorThemesResponseSchema,
  GetAppSettingsSchema,
  GetColorThemeSchema,
  ListColorThemesSchema,
  UnitSystem,
} from "@kicad-web/proto";
import { KiCadClient } from "../src/client";
import { KiCad, toAppType, toThemeColor, unitSuffix } from "../src/model";
import { FakeTransport, reply } from "./fake-transport";

async function connect(t: FakeTransport): Promise<KiCad> {
  return new KiCad(await KiCadClient.connect(t, { clientName: "kicad-web/test" }));
}

describe("settings conversions", () => {
  test("toThemeColor scales COLOR4D 0..1 channels to 0..255 and clamps", () => {
    // KiCad's default F.Cu, #C83434.
    expect(
      toThemeColor({ $typeName: "kiapi.common.types.Color", r: 0.7843137254901961, g: 0.20392156862745098, b: 0.20392156862745098, a: 1 }),
    ).toEqual({
      r: 200,
      g: 52,
      b: 52,
      a: 1,
    });
    expect(toThemeColor({ $typeName: "kiapi.common.types.Color", r: -1, g: 2, b: 0.5, a: 3 })).toEqual({ r: 0, g: 255, b: 128, a: 1 });
    expect(toThemeColor(undefined)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  test("toAppType maps the short names, unitSuffix the unit systems", () => {
    expect(toAppType("pcb")).toBe(AppType.APP_PCB_EDITOR);
    expect(toAppType("schematic")).toBe(AppType.APP_SCHEMATIC_EDITOR);
    expect(toAppType("footprint")).toBe(AppType.APP_FOOTPRINT_EDITOR);
    expect(toAppType("symbol")).toBe(AppType.APP_SYMBOL_EDITOR);
    expect(toAppType(AppType.APP_SYMBOL_EDITOR)).toBe(AppType.APP_SYMBOL_EDITOR);
    expect([UnitSystem.US_MILLIMETRES, UnitSystem.US_INCHES, UnitSystem.US_MILS, UnitSystem.US_UNKNOWN].map(unitSuffix)).toEqual([
      "mm",
      "in",
      "mil",
      "",
    ]);
  });
});

describe("Settings", () => {
  test("colorThemes() flattens ColorThemeInfo", async () => {
    const t = new FakeTransport().on(ListColorThemesSchema, () =>
      reply(ColorThemesResponseSchema, {
        themes: [
          { name: "KiCad Default", filename: "", readOnly: true },
          { name: "Mine", filename: "mine", readOnly: false },
        ],
      }),
    );
    expect(await (await connect(t)).settings.colorThemes()).toEqual([
      { name: "KiCad Default", filename: "", readOnly: true },
      { name: "Mine", filename: "mine", readOnly: false },
    ]);
  });

  test("colorTheme() produces a renderer Theme: flat keys -> 0..255 colours, plus layer ids", async () => {
    const t = new FakeTransport().on(GetColorThemeSchema, () =>
      reply(ColorThemeResponseSchema, {
        theme: { name: "KiCad Default", filename: "", readOnly: true },
        overrideSchematicItemColors: true,
        colors: [
          { key: "board.copper.f", layer: 0, color: { r: 0.7843137254901961, g: 0.20392156862745098, b: 0.20392156862745098, a: 1 } },
          { key: "schematic.wire", layer: 1102, color: { r: 0, g: 0.5882352941176471, b: 0, a: 1 } },
        ],
      }),
    );
    const theme = await (await connect(t)).settings.colorTheme("KiCad Default");
    expect(theme.name).toBe("KiCad Default");
    expect(theme.readOnly).toBe(true);
    expect(theme.overrideSchItemColors).toBe(true);
    expect(theme.colors).toEqual({ "board.copper.f": { r: 200, g: 52, b: 52, a: 1 }, "schematic.wire": { r: 0, g: 150, b: 0, a: 1 } });
    expect(theme.layers).toEqual({ "board.copper.f": 0, "schematic.wire": 1102 });
  });

  test("appSettings() takes a short name and currentGrid() indexes into grids", async () => {
    const t = new FakeTransport().on(GetAppSettingsSchema, (req) =>
      reply(AppSettingsSchema, {
        app: (req as { app: AppType }).app,
        units: UnitSystem.US_MILLIMETRES,
        colorTheme: "_builtin_default",
        grids: [
          { name: "", x: "1.0 mm", y: "1.0 mm" },
          { name: "coarse", x: "5.0 mm", y: "5.0 mm" },
        ],
        currentGrid: 1,
        settingsFile: "pcbnew.json",
      }),
    );
    const settings = (await connect(t)).settings;
    const s = await settings.appSettings("pcb");
    expect(s.app).toBe(AppType.APP_PCB_EDITOR);
    expect(s.settingsFile).toBe("pcbnew.json");
    expect(await settings.currentGrid("pcb")).toEqual({ name: "coarse", x: "5.0 mm", y: "5.0 mm" });
  });

  test("currentGrid() is undefined when current_grid is out of range", async () => {
    const t = new FakeTransport().on(GetAppSettingsSchema, () => reply(AppSettingsSchema, { grids: [], currentGrid: 3 }));
    expect(await (await connect(t)).settings.currentGrid("symbol")).toBeUndefined();
  });
});
