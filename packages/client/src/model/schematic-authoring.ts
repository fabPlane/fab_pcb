/** Pure helpers for constructing native, placed schematic items from library definitions. */
import { clone, create } from "@bufbuild/protobuf";
import {
  SchematicFieldSchema,
  SchematicPinSchema,
  SchematicSymbolSchema,
  SchematicSymbolBodyStyleSchema,
  SchematicSymbolInstanceSchema,
  SchematicSymbolOrientation,
  SchematicSymbolTransformSchema,
  SchematicSymbolUnitSchema,
  TextSchema,
  packAny,
  unpackAnyAs,
  type SchematicField,
} from "@fp-pcb/proto";
import { SchematicSymbol, type LibSymbol, type SchematicPin } from "./items";
import { toVector2, vec2, type Vec2 } from "../units";

export interface NativeSymbolPlacement {
  reference: string;
  value: string;
  footprint: string;
  position: Vec2;
  unit?: number;
  bodyStyle?: number;
  /** KiCad symbol orientation: 90 degrees rotates counterclockwise on the sheet. */
  rotation?: 0 | 90 | 180 | 270;
  mirrorX?: boolean;
  mirrorY?: boolean;
  fields?: Readonly<Record<string, string>>;
}

const ORIENTATION_BY_DEGREES = {
  0: SchematicSymbolOrientation.SSO_0,
  90: SchematicSymbolOrientation.SSO_90,
  180: SchematicSymbolOrientation.SSO_180,
  270: SchematicSymbolOrientation.SSO_270,
} as const;

function transformRelative(point: Vec2, placement: { rotation?: number; mirrorX?: boolean; mirrorY?: boolean }): Vec2 {
  let { x, y } = point;
  switch (placement.rotation ?? 0) {
    case 90:
      [x, y] = [y, -x];
      break;
    case 180:
      x = -x;
      y = -y;
      break;
    case 270:
      [x, y] = [-y, x];
      break;
  }
  // KiCad mirrors the oriented symbol about the sheet axes: X flips Y, Y flips X.
  if (placement.mirrorX) y = -y;
  if (placement.mirrorY) x = -x;
  return { x, y };
}

/** Resolve a definition pin into sheet coordinates using the instance's current transform.
 * `SchematicPin.position` remains local; callers should select pins through `symbol.pins`.
 */
export function schematicPinSheetPosition(symbol: SchematicSymbol, pin: SchematicPin): Vec2 {
  const relative = transformRelative(pin.position, symbol);
  return { x: symbol.position.x + relative.x, y: symbol.position.y + relative.y };
}

export interface PlacedNativeSymbol {
  symbol: SchematicSymbol;
  /** Absolute sheet coordinates, keyed by pin number, for the selected unit and body style. */
  pins: ReadonlyMap<string, Vec2>;
}

/** Move an already-placed native symbol while keeping its absolute fields aligned. */
export function moveNativeSymbol(symbol: SchematicSymbol, position: Vec2): SchematicSymbol {
  const delta = { x: position.x - symbol.position.x, y: position.y - symbol.position.y };
  if (!delta.x && !delta.y) return symbol;
  symbol.position = position;
  for (const field of symbol.fields) {
    const current = field.position;
    field.position = { x: current.x + delta.x, y: current.y + delta.y };
  }
  return symbol;
}

function positionedField(
  source: SchematicField | undefined,
  name: string,
  value: string,
  placement: NativeSymbolPlacement,
): SchematicField {
  const field = source ? clone(SchematicFieldSchema, source) : create(SchematicFieldSchema, { name, visible: false, allowAutoPlace: true });
  field.name = name;
  field.text ??= create(TextSchema);
  field.text.text = value;
  const relative = transformRelative(vec2(field.text.position), placement);
  field.text.position = toVector2({
    x: placement.position.x + relative.x,
    y: placement.position.y + relative.y,
  });
  return field;
}

/**
 * Creates a native `SchematicSymbolInstance` suitable for a sheet commit. Library pin identities
 * are cleared; pin positions stay in the symbol's local frame, which KiCad expects for definition
 * children. The returned pin map and absolute fields receive the rotation/mirror transform recorded
 * on the symbol instance, so callers can wire immediately without corrupting the embedded symbol.
 */
export function placeNativeSymbol(source: LibSymbol, placement: NativeSymbolPlacement): PlacedNativeSymbol {
  const definition = clone(SchematicSymbolSchema, source.proto);
  const unit = placement.unit ?? 1;
  const bodyStyle = placement.bodyStyle ?? 1;
  const pins = new Map<string, Vec2>();

  for (const child of definition.items) {
    if (!child.item) continue;
    const pin = unpackAnyAs(child.item, SchematicPinSchema);
    if (!pin) continue;
    pin.id = undefined;
    child.item = packAny(SchematicPinSchema, pin);
  }

  const fields = placement.fields ?? {};
  const symbol = new SchematicSymbol(
    create(SchematicSymbolInstanceSchema, {
      position: toVector2(placement.position),
      transform: create(SchematicSymbolTransformSchema, {
        orientation: ORIENTATION_BY_DEGREES[placement.rotation ?? 0],
        mirrorX: placement.mirrorX ?? false,
        mirrorY: placement.mirrorY ?? false,
      }),
      definition,
      libId: definition.id,
      referenceField: positionedField(definition.referenceField, "Reference", placement.reference, placement),
      valueField: positionedField(definition.valueField, "Value", placement.value, placement),
      footprintField: positionedField(definition.footprintField, "Footprint", placement.footprint, placement),
      datasheetField: positionedField(definition.datasheetField, "Datasheet", fields["Datasheet"] ?? fields["datasheet"] ?? "", placement),
      descriptionField: positionedField(
        definition.descriptionField,
        "Description",
        fields["Description"] ?? fields["description"] ?? "",
        placement,
      ),
      unit: create(SchematicSymbolUnitSchema, { unit }),
      bodyStyle: create(SchematicSymbolBodyStyleSchema, { style: bodyStyle }),
      showPinNames: definition.showPinNames,
      showPinNumbers: definition.showPinNumbers,
      pinNameOffset: definition.pinNameOffset,
      fieldsAutoplaced: false,
      userFields: Object.entries(fields)
        .filter(([name]) => !["Datasheet", "datasheet", "Description", "description"].includes(name))
        .map(([name, value]) => positionedField(undefined, name, value, placement)),
    }),
  );
  for (const pin of symbol.pins) if (pin.number) pins.set(pin.number, schematicPinSheetPosition(symbol, pin));
  return { symbol, pins };
}
