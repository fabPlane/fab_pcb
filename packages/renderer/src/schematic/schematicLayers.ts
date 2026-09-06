/**
 * Schematic render-model layers. Layer ids are KiCad colour-theme keys (`schematic.wire`,
 * `schematic.label_local`, ...; the `CLR("schematic.*", LAYER_*)` table in
 * common/settings/color_settings.cpp) so the theme lookup is direct. The draw order mirrors
 * `SCH_LAYER_ORDER` in eeschema/sch_view.h (which is listed top-most first; here bottom-most
 * first as the Scene wants it).
 */

export type SchLayerKey =
  | 'wire' | 'bus' | 'junction' | 'busJunction' | 'labelLocal' | 'labelGlobal' | 'labelHier' | 'netclassFlag'
  | 'pinNumber' | 'pinName' | 'reference' | 'value' | 'fields' | 'ruleArea' | 'device' | 'deviceBackground'
  | 'note' | 'privateNote' | 'noteBackground' | 'pin' | 'sheet' | 'sheetBackground' | 'sheetName' | 'sheetFilename'
  | 'sheetFields' | 'sheetLabel' | 'noConnect' | 'dnpMarker' | 'excludedFromSim' | 'hidden' | 'ercWarning' | 'ercError'
  | 'ercExclusion' | 'anchor' | 'auxItems' | 'bitmaps';

/** Theme key per eeschema SCH_LAYER_ID the adapter emits. */
export const SCH_LAYERS: Readonly<Record<SchLayerKey, string>> = Object.freeze({
  wire: 'schematic.wire',
  bus: 'schematic.bus',
  junction: 'schematic.junction',
  busJunction: 'schematic.bus_junction',
  labelLocal: 'schematic.label_local',
  labelGlobal: 'schematic.label_global',
  labelHier: 'schematic.label_hier',
  netclassFlag: 'schematic.netclass_flag',
  pinNumber: 'schematic.pin_number',
  pinName: 'schematic.pin_name',
  reference: 'schematic.reference',
  value: 'schematic.value',
  fields: 'schematic.fields',
  ruleArea: 'schematic.rule_area',
  device: 'schematic.component_outline',
  deviceBackground: 'schematic.component_body',
  note: 'schematic.note',
  privateNote: 'schematic.private_note',
  noteBackground: 'schematic.note_background',
  pin: 'schematic.pin',
  sheet: 'schematic.sheet',
  sheetBackground: 'schematic.sheet_background',
  sheetName: 'schematic.sheet_name',
  sheetFilename: 'schematic.sheet_filename',
  sheetFields: 'schematic.sheet_fields',
  sheetLabel: 'schematic.sheet_label',
  noConnect: 'schematic.no_connect',
  dnpMarker: 'schematic.dnp_marker',
  excludedFromSim: 'schematic.excluded_from_sim',
  hidden: 'schematic.hidden',
  ercWarning: 'schematic.erc_warning',
  ercError: 'schematic.erc_error',
  ercExclusion: 'schematic.erc_exclusion',
  anchor: 'schematic.anchor',
  auxItems: 'schematic.aux_items',
  /** LAYER_DRAW_BITMAPS has no theme key; unknown keys resolve to white, which leaves sprites untinted */
  bitmaps: 'schematic.bitmaps',
});

/**
 * Draw order, bottom-most first (reverse of SCH_LAYER_ORDER, with the layers eeschema draws
 * inside the symbol pass — pins, DNP markers — slotted where they appear on screen).
 */
export const SCHEMATIC_DRAW_ORDER: readonly string[] = Object.freeze([
  SCH_LAYERS.noteBackground,
  SCH_LAYERS.sheetBackground,
  SCH_LAYERS.deviceBackground,
  SCH_LAYERS.bitmaps,
  SCH_LAYERS.sheet,
  SCH_LAYERS.device,
  SCH_LAYERS.pin,
  SCH_LAYERS.bus,
  SCH_LAYERS.wire,
  SCH_LAYERS.privateNote,
  SCH_LAYERS.note,
  SCH_LAYERS.sheetFields,
  SCH_LAYERS.sheetLabel,
  SCH_LAYERS.sheetName,
  SCH_LAYERS.sheetFilename,
  SCH_LAYERS.labelLocal,
  SCH_LAYERS.labelGlobal,
  SCH_LAYERS.labelHier,
  SCH_LAYERS.noConnect,
  SCH_LAYERS.junction,
  SCH_LAYERS.busJunction,
  SCH_LAYERS.ruleArea,
  SCH_LAYERS.netclassFlag,
  SCH_LAYERS.pinName,
  SCH_LAYERS.pinNumber,
  SCH_LAYERS.fields,
  SCH_LAYERS.value,
  SCH_LAYERS.reference,
  SCH_LAYERS.hidden,
  SCH_LAYERS.dnpMarker,
  SCH_LAYERS.excludedFromSim,
  SCH_LAYERS.ercExclusion,
  SCH_LAYERS.ercWarning,
  SCH_LAYERS.ercError,
  SCH_LAYERS.anchor,
  SCH_LAYERS.auxItems,
]);

/** Layer ids that are real KiCad theme keys (everything except the bitmap pseudo layer). */
export const SCHEMATIC_THEME_LAYERS: readonly string[] = SCHEMATIC_DRAW_ORDER.filter((l) => l !== SCH_LAYERS.bitmaps);

/** Human-readable name for a schematic layer id (`schematic.label_local` -> `Label local`). */
export function schematicLayerDisplayName(l: string): string {
  const key = l.replace(/^schematic\./, '').replace(/_/g, ' ');
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ---------------------------------------------------------------------------
// KiCad defaults (eeschema/default_values.h), in nm
// ---------------------------------------------------------------------------

export type SchDefaultKey =
  | 'lineWidth' | 'wireWidth' | 'busWidth' | 'junctionDiameter' | 'noConnectSize' | 'busEntrySize' | 'textSize'
  | 'pinLength' | 'pinTextSize' | 'textOffsetRatio' | 'labelSizeRatio' | 'danglingSize' | 'pinTargetRadius'
  | 'pinTextMargin' | 'directivePinLength' | 'directiveSymbolSize' | 'dnpStroke';

export const MIL = 25_400;
export const SCH_DEFAULTS: Readonly<Record<SchDefaultKey, number>> = Object.freeze({
  /** DEFAULT_LINE_WIDTH_MILS */
  lineWidth: 6 * MIL,
  /** DEFAULT_WIRE_WIDTH_MILS */
  wireWidth: 6 * MIL,
  /** DEFAULT_BUS_WIDTH_MILS */
  busWidth: 12 * MIL,
  /** DEFAULT_JUNCTION_DIAM */
  junctionDiameter: 36 * MIL,
  /** DEFAULT_NOCONNECT_SIZE */
  noConnectSize: 48 * MIL,
  /** DEFAULT_SCH_ENTRY_SIZE */
  busEntrySize: 100 * MIL,
  /** DEFAULT_TEXT_SIZE */
  textSize: 50 * MIL,
  /** DEFAULT_PIN_LENGTH */
  pinLength: 100 * MIL,
  /** DEFAULT_PINNUM_SIZE / DEFAULT_PINNAME_SIZE */
  pinTextSize: 50 * MIL,
  /** DEFAULT_TEXT_OFFSET_RATIO: text baseline offset above a wire as a ratio of the text height */
  textOffsetRatio: 0.15,
  /** DEFAULT_LABEL_SIZE_RATIO: space around global label text as a ratio of the text height */
  labelSizeRatio: 0.375,
  /** DANGLING_SYMBOL_SIZE */
  danglingSize: 12 * MIL,
  /** TARGET_PIN_RADIUS (sch_pin.h) */
  pinTargetRadius: 15 * MIL,
  /** PIN_TEXT_MARGIN (pin_layout_cache.cpp) */
  pinTextMargin: 4 * MIL,
  /** directive label defaults (SCH_DIRECTIVE_LABEL ctor) */
  directivePinLength: 100 * MIL,
  directiveSymbolSize: 20 * MIL,
  /** DNP cross stroke: 3 x default line width (SCH_PAINTER::draw(SCH_SYMBOL)) */
  dnpStroke: 18 * MIL,
});
