# 03 — Drawing the GUI on an HTML page

Two independent problems: drawing the _design_ (board, schematic) and drawing the
_application_ (panels, dialogs). The application is ordinary web UI. The design is a
CAD canvas and gets its own package.

## What data the server gives us to draw with

Everything needed for a faithful render is already available headless:

| Need                | Source                                                                                  | Notes                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Item geometry       | `GetItems(types)` → `board_types` / `schematic_types` messages                          | tracks, arcs, vias, shapes, text, zones, footprints (with child pads/shapes/fields), dimensions, images, groups |
| Zone fills          | `Zone.filled_polygons` (`ZoneFilledPolygons` per layer)                                 | after `RefillZones` (works headless)                                                                            |
| Pad outlines        | `GetPadShapeAsPolygon(pad ids, layer)`                                                  | server tessellates custom/chamfered/rounded pads; cache by padstack hash                                        |
| Text outlines       | `GetTextAsShapes(text items)`                                                           | server renders KiCad stroke and outline fonts to segments/polygons; we never ship font engines                  |
| Layer set and names | `GetBoardEnabledLayers`, `GetBoardLayerName`, `GetBoardStackup`                         | order and copper count drive the layer panel                                                                    |
| Bounding box        | `GetBoundingBox`                                                                        | zoom-to-fit                                                                                                     |
| Netlist / nets      | `GetNets`, `GetItemsByNet`, `GetConnectedItems`                                         | net highlight is client-side                                                                                    |
| Symbols             | `SchematicSymbol.items` (lib pins/shapes/text), transform, fields, `unit`, `body_style` | render the lib definition through the symbol transform                                                          |
| Wires/labels/sheets | `SchematicLine`, `LocalLabel`… , `SheetSymbol`, `SheetPin`                              | hierarchy from `GetSchematicHierarchy`                                                                          |
| Colours             | none via API today (gap G11)                                                            | ship KiCad's default colour theme JSON (`resources` in the KiCad tree) and allow user theme upload              |
| Snapshot images     | `RunBoardJobExportSvg`, `RunSchematicJobExportSvg`                                      | early milestones, printing, thumbnails, side-by-side diff against our renderer                                  |

Not available and therefore drawn or computed client-side: ratsnest / unrouted
connections (gap G9, computed from `GetNets` + `GetConnectedItems` until then),
DRC markers (gap G4), selection (owned by the UI anyway).

## Renderer design (`@fp-pcb/renderer`)

**Choice: WebGL2 via PixiJS v8** (WebGPU when available). Pixi gives batching,
containers, hit testing and text-free primitives out of the box, and its `Graphics`
API maps 1:1 onto KiCad shapes. Custom shaders only where needed (net highlight
dimming, layer alpha compositing, dashed strokes). Rejected: raw Canvas2D (fine for
schematics, too slow for 200k-segment boards) and three.js (2D is a poor fit).

Structure:

- `Scene` — one `Container` per KiCad layer, ordered by the layer presentation
  order used by pcbnew (front copper on top when viewing from front, flipped when
  viewing from back). Each container has `alpha`, `visible`, `tint` from the theme.
- `ItemView` — pure function `(item, ctx) → DisplayObject[]`, one per item type.
  Board: track, arc, via (annular + drill), pad (polygon from server, cached), shape
  (segment/rect/circle/arc/polygon/bezier), text (shapes from server), zone (fill
  polygons + hatch + outline), footprint (recursive), dimension, image, group
  (outline only). Schematic: line (wire/bus/graphic with line styles), junction,
  no-connect, bus entries, labels (shape + text), symbol (lib children through
  `SchematicSymbolTransform`), sheet (rect + pins + fields), shape, text, textbox,
  table, rule area.
- `Store subscription` — the renderer diffs the item store: added/removed/updated
  KIIDs map to create/destroy/rebuild of that item's `DisplayObject`s. Rebuild is
  per item, never whole-layer.
- `Camera` — pan/zoom with wheel/trackpad/touch, world units in nm as `number`,
  a `Float64` model-to-screen transform; Pixi receives float32 coordinates _relative
  to a moving origin_ to avoid precision loss on large boards.
- `Picker` — spatial index (flatbush / rbush) over item bounding boxes plus exact
  per-shape tests for hover/click; multi-hit disambiguation menu like pcbnew.
- `Theme` — KiCad colour theme JSON → per-layer colour, plus selection / highlight /
  ratsnest colours. Both light and dark canvas backgrounds.
- `Overlays` — selection outlines, move preview, snap points, ratsnest lines, DRC
  marker glyphs, grid, origin markers, rulers.

Performance targets: kitchen-sink boards instantly; a 100k-item board < 2 s first
paint, 60 fps pan/zoom. Levers: instanced vias/pads by padstack hash, zone fills as
pre-triangulated meshes (earcut), text as cached meshes, layer containers cached to
`RenderTexture` when idle.

## Application shell (`apps/web`)

React 19 + Zustand + Vite, Radix primitives for dialogs/menus, a docking layout
(three-column: project tree / canvas / properties + bottom panel). No CSS framework
that fights the CAD look; a small token set with light and dark themes.

Screens, each an independently buildable slice:

1. **Project** — open recent, file browser (via bridge), new project/board/schematic
   (needs gap G5), project settings (netclasses, text variables, variants).
2. **Schematic editor** — hierarchy tree, sheet canvas, place symbol (library
   browser, gap G7), wire/bus/label tools, symbol properties, fields table (bulk
   `UpdateItems`), annotate (gap G8), ERC panel (gap G4), netlist/BOM export.
3. **Board editor** — layer panel (appearance state lives in the UI), route tool
   (client-side manual routing writing tracks/vias; interactive push-and-shove needs
   gap G9), footprint properties, zone editor + refill, design rules editor
   (`Get/SetBoardDesignRules`, custom rules text), DRC panel, update from schematic
   (`GetSchematicNetlist` → `ImportNetlist`), exports/jobs, 3D view (three.js on the
   GLB from `RunBoardJobExport3D`).
4. **Footprint editor** — open by LIB_ID, edit pads/shapes, save.
5. **Command palette** — every client command and every UI action, searchable;
   `RunAction` names surface here once headless (gap G3).

Interaction model: the UI owns selection, hover, active layer, visible layers, and
undo history. This matches the API's GUI-only list exactly — those 15 commands are
GUI _state_, and in a web UI that state belongs to the page, not to KiCad. The only
GUI-only command we genuinely need from KiCad is `RunAction` (gap G3).
