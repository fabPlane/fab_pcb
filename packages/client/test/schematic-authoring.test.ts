import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  LibraryIdentifierSchema,
  SchematicFieldSchema,
  SchematicPinSchema,
  SchematicSymbolBodyStyleSchema,
  SchematicSymbolChildSchema,
  SchematicSymbolSchema,
  SchematicSymbolUnitSchema,
  TextSchema,
  packAny,
  unpackAnyAs,
} from "@fp-pcb/proto";
import { LibSymbol, mm, placeNativeSymbol, toDistance, toVector2 } from "../src";

function librarySymbol(): LibSymbol {
  const pin = (number: string, x: number, y: number, unit = 1) =>
    create(SchematicSymbolChildSchema, {
      unit: create(SchematicSymbolUnitSchema, { unit }),
      bodyStyle: create(SchematicSymbolBodyStyleSchema, { style: 1 }),
      item: packAny(SchematicPinSchema, create(SchematicPinSchema, { number, position: toVector2({ x: mm(x), y: mm(y) }) })),
    });
  const field = (name: string, text: string, x: number, y: number) =>
    create(SchematicFieldSchema, {
      name,
      text: create(TextSchema, { text, position: toVector2({ x: mm(x), y: mm(y) }) }),
    });
  return new LibSymbol(
    create(SchematicSymbolSchema, {
      id: create(LibraryIdentifierSchema, { libraryNickname: "Device", entryName: "R" }),
      referenceField: field("Reference", "R", 0, -2),
      valueField: field("Value", "R", 0, 2),
      footprintField: field("Footprint", "", 0, 3),
      showPinNames: true,
      showPinNumbers: false,
      pinNameOffset: toDistance(mm(1.016)),
      items: [pin("1", -5, 0), pin("2", 5, 0), pin("3", 0, 5, 2)],
    }),
  );
}

describe("native schematic authoring", () => {
  test("places a library symbol with durable fields and absolute, isolated pins", () => {
    const placed = placeNativeSymbol(librarySymbol(), {
      reference: "R7",
      value: "10k",
      footprint: "Resistor_SMD:R_0603_1608Metric",
      position: { x: mm(30), y: mm(40) },
      fields: { MPN: "RC0603-10K" },
    });

    expect(placed.symbol.reference).toBe("R7");
    expect(placed.symbol.value).toBe("10k");
    expect(placed.symbol.footprint).toBe("Resistor_SMD:R_0603_1608Metric");
    expect(placed.symbol.libraryId).toBe("Device:R");
    expect(placed.symbol.proto.showPinNames).toBe(true);
    expect(placed.symbol.proto.showPinNumbers).toBe(false);
    expect(placed.symbol.proto.pinNameOffset).toEqual(toDistance(mm(1.016)));
    expect(placed.pins).toEqual(
      new Map([
        ["1", { x: mm(25), y: mm(40) }],
        ["2", { x: mm(35), y: mm(40) }],
      ]),
    );
    expect(placed.symbol.field("MPN")?.text).toBe("RC0603-10K");
    const pins = placed.symbol.proto
      .definition!.items.map((child) => child.item && unpackAnyAs(child.item, SchematicPinSchema))
      .filter(Boolean);
    expect(pins.map((pin) => pin!.id)).toEqual([undefined, undefined, undefined]);
  });
});
