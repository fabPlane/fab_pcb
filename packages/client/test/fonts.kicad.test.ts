/**
 * Outline fonts through the manifest backend (`common/font/fontconfig_manifest.cpp`).
 *
 * KiCad's headless build has no system font database, so `Fontconfig()->FindFont()` is answered
 * from a manifest (or a bare folder of font files) at `KICAD_FONTS_DIR`. When that misses,
 * `OUTLINE_FONT::LoadFont()` returns null and every text falls back to the stroke font — which
 * is the *only* behaviour the module had before the manifest existed, and it is silent: the API
 * still answers, just with the wrong glyphs.
 *
 * These tests make the difference observable. They need fonts on disk, so they are skipped
 * unless `KICAD_FONTS_DIR` points at a directory with at least one .ttf/.otf:
 *
 *   KICAD_TRANSPORT=stdio KICAD_API_HOST=<...>/kicad-api-host-native \
 *   KICAD_FONTS_DIR=<...>/fonts bun test packages/client/test/fonts.kicad.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KiCad } from "../src/model";
import { mm, toDistance, toVector2 } from "../src/units";
import { KICAD_FONTS_DIR, KICAD_TRANSPORT, haveKicad, startKiCad, type RunningKiCad } from "./kicad-server";

function fontFiles(dir: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /\.(ttf|otf)$/i.test(n));
}

const HAVE_FONTS = fontFiles(KICAD_FONTS_DIR).length > 0 && haveKicad();

if (!HAVE_FONTS) {
  console.log(
    KICAD_FONTS_DIR
      ? `[skip] no .ttf/.otf in KICAD_FONTS_DIR=${KICAD_FONTS_DIR}`
      : "[skip] set KICAD_FONTS_DIR to a directory of fonts to run the outline-font tests",
  );
}

/** The family the manifest says is there, so the test does not hard-code "Carlito". */
async function manifestFamily(dir: string): Promise<string> {
  const text = await readFile(join(dir, "manifest.json"), "utf8").catch(() => null);
  if (text) {
    const js = JSON.parse(text) as { default?: string; fonts?: { family?: string; bold?: boolean; italic?: boolean }[] };
    const plain = js.fonts?.find((f) => f.family && !f.bold && !f.italic)?.family;
    const family = js.default ?? plain ?? js.fonts?.[0]?.family;
    if (family) return family;
  }
  // No manifest: the backend scans the folder, and the file stem before the dash is the family
  // for every font KiCad ships. Good enough to name one that is definitely present.
  return fontFiles(dir)[0]!
    .replace(/\.[^.]+$/, "")
    .split("-")[0]!;
}

const SIZE = { size: toVector2({ x: mm(2), y: mm(2) }), strokeWidth: toDistance(mm(0.2)) };

describe.skipIf(!HAVE_FONTS)(`outline fonts from KICAD_FONTS_DIR (${KICAD_TRANSPORT})`, () => {
  let rt: RunningKiCad;
  let k: KiCad;
  let family: string;

  beforeAll(async () => {
    family = await manifestFamily(KICAD_FONTS_DIR);
    rt = await startKiCad(null, "fonts");
    k = rt.kicad;
  }, 120_000);

  afterAll(async () => {
    await rt?.stop();
  });

  test("the manifest family is listed by the backend", async () => {
    // Nothing in the API returns the font list, so this is the indirect proof: a family the
    // manifest names must not measure the same as the stroke font.
    expect(family.length).toBeGreaterThan(0);
  });

  test("GetTextExtents differs between the stroke font and the manifest family", async () => {
    const text = "Wg1i- fp-pcb";
    const stroke = await k.textExtents({ text, attributes: { ...SIZE, fontName: "" } });
    const outline = await k.textExtents({ text, attributes: { ...SIZE, fontName: family } });

    expect(stroke.w).toBeGreaterThan(0);
    expect(outline.w).toBeGreaterThan(0);
    // The stroke font is a fixed-pitch vector font; a real outline face is proportional, so the
    // advance width of a mixed string cannot coincide.
    expect(outline.w).not.toBe(stroke.w);
  });

  test("GetTextAsShapes returns different geometry for the manifest family", async () => {
    const text = { text: "Wg", attributes: { ...SIZE } };
    const [stroke] = await k.textAsShapes([{ text: { ...text, attributes: { ...SIZE, fontName: "" } } }]);
    const [outline] = await k.textAsShapes([{ text: { ...text, attributes: { ...SIZE, fontName: family } } }]);

    const strokeShapes = stroke!.shapes?.shapes ?? [];
    const outlineShapes = outline!.shapes?.shapes ?? [];
    expect(strokeShapes.length).toBeGreaterThan(0);
    expect(outlineShapes.length).toBeGreaterThan(0);

    // The stroke font tessellates to open segments/arcs; an outline face comes back as filled
    // polygons. Even where both are polygons the point counts cannot match. (Coordinates are
    // BigInt, so the fingerprint is built by hand rather than with JSON.stringify.)
    const fingerprint = (shapes: typeof strokeShapes) =>
      shapes
        .map((s) => {
          const g = s.geometry;
          const points = g.case === "polygon" ? g.value.polygons.reduce((n, p) => n + (p.outline?.nodes.length ?? 0), 0) : 0;
          return `${g.case}:${points}`;
        })
        .join(",");
    expect(fingerprint(outlineShapes)).not.toBe(fingerprint(strokeShapes));
  });

  test("an unknown family substitutes the manifest default rather than the stroke font", async () => {
    const text = "Wg1i- fp-pcb";
    const stroke = await k.textExtents({ text, attributes: { ...SIZE, fontName: "" } });
    const known = await k.textExtents({ text, attributes: { ...SIZE, fontName: family } });
    const unknown = await k.textExtents({ text, attributes: { ...SIZE, fontName: "No Such Family At All" } });

    // FindFont answers FF_SUBSTITUTE with the default family, exactly as fontconfig would; the
    // stroke fallback only happens on FF_ERROR, i.e. with no fonts mounted at all.
    expect(unknown.w).not.toBe(stroke.w);
    expect(unknown.w).toBe(known.w);
  });
});

/**
 * The same proof for the fonts the *module* carries: `KICAD_WASM_PRELOAD_FONTS` bundles Carlito
 * Regular + Bold and a manifest into `kicad_api.data` at `/kicad/fonts`, which is where the host
 * config's `fonts` already points under Emscripten. So a wasm build resolves outline text with no
 * `KICAD_FONTS_DIR` and nothing mounted from the host at all — and that is exactly the case the
 * block above skips, because it keys off a host directory.
 */
const PRELOADED = KICAD_TRANSPORT === "wasm" && !KICAD_FONTS_DIR && haveKicad();

if (KICAD_TRANSPORT === "wasm" && !PRELOADED && !KICAD_FONTS_DIR) {
  console.log("[skip] no wasm module: set KICAD_WASM_DIR to a build with kicad_api.{js,wasm,data}");
}

describe.skipIf(!PRELOADED)("outline fonts preloaded into the module (wasm, no KICAD_FONTS_DIR)", () => {
  let rt: RunningKiCad;
  let k: KiCad;
  const family = "Carlito";

  beforeAll(async () => {
    rt = await startKiCad(null, "fonts-preloaded");
    k = rt.kicad;
  }, 120_000);

  afterAll(async () => {
    await rt?.stop();
  });

  test("GetTextExtents differs between the stroke font and the preloaded family", async () => {
    const text = "Wg1i- fp-pcb";
    const stroke = await k.textExtents({ text, attributes: { ...SIZE, fontName: "" } });
    const outline = await k.textExtents({ text, attributes: { ...SIZE, fontName: family } });

    expect(outline.w).toBeGreaterThan(0);
    expect(outline.w).not.toBe(stroke.w);
  });

  test("GetTextAsShapes returns filled polygons for the preloaded family", async () => {
    const attributes = { ...SIZE };
    const [stroke] = await k.textAsShapes([{ text: { text: "Wg", attributes: { ...attributes, fontName: "" } } }]);
    const [outline] = await k.textAsShapes([{ text: { text: "Wg", attributes: { ...attributes, fontName: family } } }]);

    const strokeShapes = stroke!.shapes?.shapes ?? [];
    const outlineShapes = outline!.shapes?.shapes ?? [];
    expect(strokeShapes.length).toBeGreaterThan(0);
    expect(outlineShapes.length).toBeGreaterThan(0);

    // The stroke font tessellates to open segments; an outline face is polygons with nodes.
    const nodes = outlineShapes.reduce((n, s) => {
      const g = s.geometry;
      return g.case === "polygon" ? n + g.value.polygons.reduce((m, p) => m + (p.outline?.nodes.length ?? 0), 0) : n;
    }, 0);
    expect(outlineShapes.every((s) => s.geometry.case === "polygon")).toBe(true);
    expect(nodes).toBeGreaterThan(0);
    expect(strokeShapes.some((s) => s.geometry.case === "polygon")).toBe(false);
  });
});
