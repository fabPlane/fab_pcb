# @kicad-web/renderer

PixiJS v8 canvas renderer for kicad-web. Implements the `CanvasHost` contract from
[docs/contracts.md](../../docs/contracts.md) over an `ItemStore`-shaped object, with a
neutral render model (`RenderItem` / `Primitive`) so the core never depends on
`@kicad-web/proto`. Wave-2 agent A5 owns `core/` and `board/`; A6 adds `schematic/` on top.

```
src/
  core/
    model.ts      Vec2 / Box helpers, Primitive + RenderItem (contracts.md "Render model")
    geometry.ts   arcs (start/mid/end), pad shape generators, dashes, hatching, distance tests
    theme.ts      Theme type, KiCad colour JSON loader, built-in themes, layer -> colour
    camera.ts     float64 camera (nm -> px), moving origin, wheel/trackpad/pinch/touch/keys
    scene.ts      Pixi Container per layer, per-item objects, diff apply, primitive builders,
                  GraphicsContext instancing, earcut meshes for zone fills
    picker.ts     flatbush index + exact per-primitive tests, nearest-first
    overlays.ts   grid (mm/mil, adaptive), origin/axes, selection, hover, rubber band
    host.ts       BaseCanvasHost (CanvasHost contract, pointer events, resize, render loop)
  board/
    boardLayers.ts   BoardLayer enum table, copper/tech classification, pcbnew draw order
    boardAdapter.ts  kiapi board messages -> RenderItems (every KOT_PCB_* type)
    BoardCanvasHost.ts
themes/
  kicad-default.json, kicad-classic.json   generated from the KiCad sources (see below)
scripts/gen-themes.ts
demo/            synthetic board for eyeballing pan/zoom/pick
test/            bun tests (theme, camera, picker/geometry, adapter, headless scene)
```

## Usage

```ts
import { BoardCanvasHost, KICAD_DEFAULT_THEME, loadUserTheme, copperLayerList } from '@kicad-web/renderer';

const host = new BoardCanvasHost(KICAD_DEFAULT_THEME, {
  copperLayers: copperLayerList(4),          // from GetBoardEnabledLayers / stackup
  adapter: {
    padPolygons: (padId, layer) => padPolyCache.get(`${padId}/${layer}`),   // GetPadShapeAsPolygon
    textShapes: (textId) => textShapeCache.get(textId),                    // GetTextAsShapes
  },
});
host.mount(div, board.store, KICAD_DEFAULT_THEME);   // store: ItemStore from @kicad-web/client
await host.ready;                                    // WebGL context up, first frame drawn

host.onPick((hits, ev) => select(hits[0]?.owner));   // hits nearest-first, distance in px
host.onHover((hit) => showTooltip(hit?.ref));
host.onBoxSelect(({ hits, touching }) => select(hits.map((h) => h.owner)));
host.setSelection(['<kiid>']);                       // KIIDs or render-item ids
host.setHighlightNets(['GND']);
host.setActiveLayer('BL_B_Cu');                      // draw order like pcbnew
host.flipView(true);                                 // view from the back
host.setTheme(loadUserTheme(await file.text()));     // ~/.config/kicad/10.0/colors/user.json
host.setAdapterContext({ padPolygons: ... });         // rebuilds everything once server shapes arrive
```

`setLayerVisible` / `setLayerOpacity` take render-model layer ids: `BL_*` BoardLayer enum names or
theme keys for pseudo layers (`board.via_hole`, `board.pad_plated_hole`, `board.plated_hole`
(NPTH), `board.anchor`, `board.points`, `board.grid_items`, `board.aux_items`).

Extra (beyond the contract): `onBoxSelect`, `pickBox(box, touching)`, `flipView`, `isFlipped`,
`contentBox()`, `rebuildAll()`, `rebuildItems(ids)`, `getRenderItem(id)`, `requestRender()`,
`renderNow()`, `overlays.options` (grid unit/style/visibility), `camera`, `scene`, `picker`.

### PickResult

```ts
{ id, distance, owner, ref, layer, net? }
```
- `id` — render item id, unique per (object, layer): `"<kiid>"` for single-layer items,
  `"<kiid>@BL_F_Cu"` for pads / vias / zones per layer, `"<kiid>@hole"` for drill decorations.
- `ref` — the object KIID without suffix (pad, via, zone, track KIID). Use this for the UI.
- `owner` — the store item that produced it: the footprint KIID for pads / fp shapes / fields,
  otherwise equal to `ref`.
- `distance` — screen px from the pointer (0 = inside).

Footprints themselves are pickable through their bbox (a body item with no geometry), sorted
after their children, so clicking a pad yields `[pad, footprint]`.

## What the board adapter expects

`BoardCanvasHost.toRenderItems(item)` calls `boardItemToRenderItems(item, ctx)` with the
`StoredItem` from the contract: `{ id, type, layer?, net?, parent?, proto }`. `type` is the
`KOT_*` name (`KOT_PCB_TRACE`, `KOT_PCB_FOOTPRINT`, ...); if empty it is derived from
`proto.$typeName`. `proto` is the **protobuf-es message object** for the item:

- field names in camelCase as in the proto (`padStack`, `filledPolygons`, `referenceField`);
- `Vector2` = `{ xNm, yNm }`, `Distance` = `{ valueNm }`, `Angle` = `{ valueDegrees }`,
  `KIID` = `{ value }`, `Net` = `{ code: { value }, name }`; int64 fields may be
  `bigint | number | string` (normalised with `Number()`);
- enums are numbers (protobuf-es) — enum names as strings are accepted too;
- oneofs in protobuf-es form `{ case: 'segment', value: {...} }` (flat `{ segment: {...} }` is
  also accepted);
- `PolySet` = `{ polygons: [{ outline: { nodes: [{ geometry: { case: 'point'|'arc', value } }] }, holes: [...] }] }`;
- `FootprintInstance.definition.items` must be **decoded**: either the message objects with
  `$typeName` (`kiapi.board.types.Pad`, `...BoardGraphicShape`, `...BoardText`, `...Zone`,
  `...ReferencePoint`) or wrappers `{ type: 'KOT_PCB_PAD', proto }`. Undecoded `Any`s are
  skipped. Children are in absolute board coordinates (KiCad API semantics: `PAD::Serialize`
  uses `GetPosition()`); set `adapter.footprintChildrenAbsolute = false` for library
  footprints whose children are relative to the anchor (then rotation / back-side flip is applied).
- If the store *also* lists pads/shapes/fields as separate items with `parent` set, they are
  skipped when the parent footprint carries `definition.items` (no double drawing).

`BoardAdapterContext`:

| field | purpose |
|---|---|
| `copperLayers` | board copper layers front→back (`copperLayerList(n)`); vias without a layer list span their drill range or all copper |
| `padPolygons(padId, layer)` | `PolygonWithHoles[]` from `GetPadShapeAsPolygon` (or plain `Vec2[][]`); fallback draws circle/rect/oval/trapezoid/roundrect/chamfered/custom padstacks |
| `textShapes(textId)` | `GraphicShape[]` (`CompoundShape.shapes` from `GetTextAsShapes`) or plain glyph polygons; ids: text KIID, textbox KIID, `Field.text.id`, dimension KIID; fallback draws a metrics-estimated box |
| `itemBBox(id)` | bbox lookup for group outlines |
| `imagePixelNm` | reference image pixel pitch (default 25.4e6 / 300 ppi) |
| `arcTolerance` | polygon arc approximation, nm |

Covered types: Track, Arc, Via (ring per copper layer + drill), Pad (copper/mask/paste layers,
PTH/NPTH holes), BoardGraphicShape (segment, rect + corner radius, arc, circle, polygon with
holes and arcs, bezier, ellipse, ellipse arc, line styles dash/dot/dashdot, line endings),
BoardText / BoardTextBox / Field, Zone (filled polygons per layer as meshes, outline, hatched
rule areas), FootprintInstance (children, fields, anchor, body), Dimension (aligned,
orthogonal, radial, leader, center), ReferenceImage (PNG/JPEG/GIF header → size, sprite),
Group (bbox), Barcode, ReferencePoint, GridItem (cartesian/polar), Table. Markers,
generators, constraints and 3D models produce nothing.

## Themes

`themes/kicad-default.json` and `themes/kicad-classic.json` are generated by
`bun run gen:themes [path-to-kicad-src]` from `common/settings/builtin_color_themes.h`
(`s_defaultTheme` / `s_classicTheme`), `common/settings/color_settings.cpp` (the
`CLR("board.copper.f", F_Cu)` key table, gerbview layer loop, 3D-viewer user layers) and
`common/gal/color4d.cpp` (the legacy named palette, which is stored B,G,R). The JSON layout
is KiCad's own, so `themeFromJson` / `loadUserTheme` read user theme files unchanged. Only the
two built-in themes exist in the KiCad tree (no Eagle / Behave Dark there). The macOS-specific
`#ifdef __WXMAC__` selection-shadow colour is not used; the generic value is.

Layer colours: `layerColor(theme, 'BL_In3_Cu')` → `board.copper.in3` with KiCad's looping
fallbacks for copper / user layers, missing keys falling back to the default theme.

## Rendering notes

- Geometry is drawn white and tinted per item from the layer colour, so theme changes and net
  highlighting (dimming) never rebuild geometry.
- Each RenderItem is one Pixi container positioned at `anchor - origin`, geometry relative to
  its anchor; the camera re-bases the origin when it drifts > 50k px away (`Camera.maybeRebase`),
  so float32 error stays below 0.01 px at any zoom on any board size.
- Items with a `cacheKey` (pads by padstack hash + layer + angle, text by content) share one
  `GraphicsContext`; identical pads are instanced.
- Polygons with ≥ 200 vertices or `mesh: true` (zone fills) become pre-triangulated `Mesh`es.
- Width 0 means hairline (`pixelLine`), round caps/joins elsewhere.
- Wide strokes, arcs and circles are tessellated in `geometry.ts` (`stadiumPolygon`,
  `offsetPathPolygon`, `circleSegments`: ~60 µm per segment, 8..64 per circle) and handed to
  Pixi as polygon fills. Never use Pixi's own `stroke({ width })` / `circle()` / `arc()` with
  nm coordinates: its adaptive tessellation sizes round caps by the radius in local units and
  a 0.15 mm cap becomes tens of thousands of vertices (measured: 190 KB and 2.5 s of first
  frame per 19k items before the change, 6.8 KB and 61 ms after).
- The scene root is a Pixi render group, so pan/zoom is a GPU uniform and the batched child
  geometry is not re-transformed on the CPU each frame.

Measured in the demo (`?n=`, embedded Chromium, M-series Mac): n=5000 → 18.8k render items,
128 MB heap, first frame 61 ms, pan frame 1.5 ms; n=20000 → 75k items, 437 MB, 60 fps,
pan 1.4 ms; n=50000 → 187k items (≈ 400k primitives), 1.06 GB, 61 fps, pan 2.3 ms.
Conversion (adapter + Graphics contexts) runs at ≈ 90k render items/s.
- Draw order follows `pcbnew/pcb_draw_panel_gal.cpp` `GAL_LAYER_ORDER` + `SetTopLayer`.
- Rendering is on demand (`requestRender`), no ticker when idle; `prefers-reduced-motion`
  disables inertial panning.

Input: wheel = zoom (ctrl/⌘+wheel = pinch zoom, horizontal/shift wheel = pan), middle-drag or
touch = pan, two-finger pinch, arrows / +/- keys, left-drag = rubber band (`leftDrag: 'pan'`
to pan instead), click = pick.

## Demo

```
cd packages/renderer
bun run demo            # builds demo/dist/main.js and serves http://localhost:8787/
```
Open the URL; middle-drag/touch to pan, wheel to zoom, click to pick (cycles through
overlapping hits), left-drag to box-select, toggle layers / opacity / active layer, switch
themes or upload a user theme JSON, highlight a net, move R1 through a store diff.
`?n=100000` adds a 100k-primitive stress set, `&spin=1` pans continuously for an fps reading.

## Tests

```
bun test          # 48 tests: theme port, camera math, picker/geometry, adapter fixtures, headless scene
bunx tsc -b
```

## Known gaps

- No pixel-diff harness against `RunBoardJobExportSvg` yet (A5 exit test).
- Text without server shapes is a metrics-estimated box (KiCad fonts are never shipped).
- Pad solder mask / paste expansion is not applied (technical layers reuse the copper shape);
  hatched zone fills, thermal reliefs and teardrops render as whatever `filled_polygons` holds.
- Zone hatch border (`ZBS_DIAGONAL_EDGE`) draws only the outline; rule areas are fully hatched.
- Pixi's own font/text is unused; no net names on tracks/pads.
- Reference images assume 300 ppi (`imagePixelNm`); scale factor from `image_scale`.
- Ratsnest, DRC markers, routing preview, snapping: wave 3.
- Large initial loads are converted synchronously (100k items ≈ hundreds of ms); chunking TBD.
