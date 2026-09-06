/**
 * Item wrappers for every board and schematic item type the IPC API serves. Importing this module
 * registers all classes with `wrapAny()`.
 */
import { KiCadObjectType } from "@kicad-web/proto";

export * from "./base";
export * from "./board/tracks";
export * from "./board/footprint";
export * from "./board/graphics";
export * from "./board/zone";
export * from "./board/group";
export * from "./schematic/symbol";
export * from "./schematic/wiring";
export * from "./schematic/text";
export * from "./schematic/graphics";
export * from "./schematic/sheet";
export * from "./schematic/group";

/** Board item types `GetItems` can return for a PCB document. */
export const BOARD_ITEM_TYPES: readonly KiCadObjectType[] = [
  KiCadObjectType.KOT_PCB_FOOTPRINT,
  KiCadObjectType.KOT_PCB_PAD,
  KiCadObjectType.KOT_PCB_SHAPE,
  KiCadObjectType.KOT_PCB_REFERENCE_IMAGE,
  KiCadObjectType.KOT_PCB_FIELD,
  KiCadObjectType.KOT_PCB_TEXT,
  KiCadObjectType.KOT_PCB_TEXTBOX,
  KiCadObjectType.KOT_PCB_TABLE,
  KiCadObjectType.KOT_PCB_TABLECELL,
  KiCadObjectType.KOT_PCB_TRACE,
  KiCadObjectType.KOT_PCB_VIA,
  KiCadObjectType.KOT_PCB_ARC,
  KiCadObjectType.KOT_PCB_DIMENSION,
  KiCadObjectType.KOT_PCB_ZONE,
  KiCadObjectType.KOT_PCB_GROUP,
  KiCadObjectType.KOT_PCB_BARCODE,
  KiCadObjectType.KOT_PCB_CONSTRAINT,
  KiCadObjectType.KOT_PCB_GRIDITEM,
  KiCadObjectType.KOT_PCB_POINT,
];

/** Board item types `GetItems` serves from the top level (pads/fields/cells arrive nested in parents too). */
export const BOARD_TOP_LEVEL_TYPES: readonly KiCadObjectType[] = BOARD_ITEM_TYPES.filter(
  (t) => t !== KiCadObjectType.KOT_PCB_PAD && t !== KiCadObjectType.KOT_PCB_FIELD && t !== KiCadObjectType.KOT_PCB_TABLECELL,
);

/** Schematic item types `GetItems` can return (per sheet). */
export const SCHEMATIC_ITEM_TYPES: readonly KiCadObjectType[] = [
  KiCadObjectType.KOT_SCH_JUNCTION,
  KiCadObjectType.KOT_SCH_NO_CONNECT,
  KiCadObjectType.KOT_SCH_BUS_WIRE_ENTRY,
  KiCadObjectType.KOT_SCH_BUS_BUS_ENTRY,
  KiCadObjectType.KOT_SCH_LINE,
  KiCadObjectType.KOT_SCH_SHAPE,
  KiCadObjectType.KOT_SCH_RULE_AREA,
  KiCadObjectType.KOT_SCH_BITMAP,
  KiCadObjectType.KOT_SCH_TEXTBOX,
  KiCadObjectType.KOT_SCH_TEXT,
  KiCadObjectType.KOT_SCH_TABLE,
  KiCadObjectType.KOT_SCH_LABEL,
  KiCadObjectType.KOT_SCH_GLOBAL_LABEL,
  KiCadObjectType.KOT_SCH_HIER_LABEL,
  KiCadObjectType.KOT_SCH_DIRECTIVE_LABEL,
  KiCadObjectType.KOT_SCH_GROUP,
  KiCadObjectType.KOT_SCH_SYMBOL,
  KiCadObjectType.KOT_SCH_SHEET,
];

/** Footprint-editor document item types. */
export const FOOTPRINT_ITEM_TYPES: readonly KiCadObjectType[] = [
  KiCadObjectType.KOT_PCB_PAD,
  KiCadObjectType.KOT_PCB_SHAPE,
  KiCadObjectType.KOT_PCB_TEXT,
  KiCadObjectType.KOT_PCB_TEXTBOX,
  KiCadObjectType.KOT_PCB_FIELD,
  KiCadObjectType.KOT_PCB_DIMENSION,
  KiCadObjectType.KOT_PCB_ZONE,
  KiCadObjectType.KOT_PCB_GROUP,
  KiCadObjectType.KOT_PCB_REFERENCE_IMAGE,
];

/** Items a headless symbol document (`DOCTYPE_SYMBOL`) serves: the symbol's children. `KOT_LIB_SYMBOL` is served separately. */
export const SYMBOL_ITEM_TYPES: readonly KiCadObjectType[] = [
  KiCadObjectType.KOT_SCH_PIN,
  KiCadObjectType.KOT_SCH_SHAPE,
  KiCadObjectType.KOT_SCH_TEXT,
  KiCadObjectType.KOT_SCH_TEXTBOX,
  KiCadObjectType.KOT_SCH_FIELD,
];
