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
import { SchematicSymbol, type LibSymbol } from "./items";
import { toVector2, vec2, type Vec2 } from "../units";

export interface NativeSymbolPlacement {
  reference: string;
  value: string;
  footprint: string;
  position: Vec2;
  unit?: number;
  bodyStyle?: number;
  fields?: Readonly<Record<string, string>>;
}

export interface PlacedNativeSymbol {
  symbol: SchematicSymbol;
  /** Absolute sheet coordinates, keyed by pin number, for the selected unit and body style. */
  pins: ReadonlyMap<string, Vec2>;
}

function positionedField(source: SchematicField | undefined, name: string, value: string, origin: Vec2): SchematicField {
  const field = source ? clone(SchematicFieldSchema, source) : create(SchematicFieldSchema, { name, visible: false, allowAutoPlace: true });
  field.name = name;
  field.text ??= create(TextSchema);
  field.text.text = value;
  const relative = vec2(field.text.position);
  field.text.position = toVector2({ x: origin.x + relative.x, y: origin.y + relative.y });
  return field;
}

/**
 * Creates a native `SchematicSymbolInstance` suitable for a sheet commit. Library pin identities
 * are cleared and their positions are translated into the absolute sheet coordinates required by
 * KiCad's placed-symbol API. Rotation is deliberately left to a later transform-aware helper;
 * this constructor creates the conventional zero-degree placement without hiding that limitation.
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
    const relative = vec2(pin.position);
    const absolute = { x: placement.position.x + relative.x, y: placement.position.y + relative.y };
    pin.id = undefined;
    pin.position = toVector2(absolute);
    child.item = packAny(SchematicPinSchema, pin);
    const childUnit = child.unit?.unit ?? 0;
    const childStyle = child.bodyStyle?.style ?? 0;
    if (pin.number && (childUnit === 0 || childUnit === unit) && (childStyle === 0 || childStyle === bodyStyle))
      pins.set(pin.number, absolute);
  }

  const fields = placement.fields ?? {};
  const symbol = new SchematicSymbol(
    create(SchematicSymbolInstanceSchema, {
      position: toVector2(placement.position),
      transform: create(SchematicSymbolTransformSchema, { orientation: SchematicSymbolOrientation.SSO_0 }),
      definition,
      libId: definition.id,
      referenceField: positionedField(definition.referenceField, "Reference", placement.reference, placement.position),
      valueField: positionedField(definition.valueField, "Value", placement.value, placement.position),
      footprintField: positionedField(definition.footprintField, "Footprint", placement.footprint, placement.position),
      datasheetField: positionedField(
        definition.datasheetField,
        "Datasheet",
        fields["Datasheet"] ?? fields["datasheet"] ?? "",
        placement.position,
      ),
      descriptionField: positionedField(
        definition.descriptionField,
        "Description",
        fields["Description"] ?? fields["description"] ?? "",
        placement.position,
      ),
      unit: create(SchematicSymbolUnitSchema, { unit }),
      bodyStyle: create(SchematicSymbolBodyStyleSchema, { style: bodyStyle }),
      showPinNames: definition.showPinNames,
      showPinNumbers: definition.showPinNumbers,
      pinNameOffset: definition.pinNameOffset,
      fieldsAutoplaced: false,
      userFields: Object.entries(fields)
        .filter(([name]) => !["Datasheet", "datasheet", "Description", "description"].includes(name))
        .map(([name, value]) => positionedField(undefined, name, value, placement.position)),
    }),
  );
  return { symbol, pins };
}
