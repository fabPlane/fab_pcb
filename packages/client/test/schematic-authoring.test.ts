import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  LibraryIdentifierSchema,
  SchematicFieldSchema,
  SchematicPinSchema,
  SchematicSymbolBodyStyleSchema,
  SchematicSymbolChildSchema,
  SchematicSymbolSchema,
  SchematicSymbolUnitSchema,
  SchematicSymbolInstanceSchema,
  TextSchema,
  packAny,
  unpackAnyAs,
} from "@fp-pcb/proto";
import {
  LibSymbol,
  SchematicSymbol,
  mm,
  moveNativeSymbol,
  placeNativeSymbol,
  schematicPinSheetPosition,
  toDistance,
  toVector2,
} from "../src";

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

  test("rotates and mirrors pins and fields with the symbol transform", () => {
    const placed = placeNativeSymbol(librarySymbol(), {
      reference: "R8",
      value: "1k",
      footprint: "Resistor_SMD:R_0603_1608Metric",
      position: { x: mm(30), y: mm(40) },
      rotation: 90,
      mirrorX: true,
    });

    expect(placed.symbol.rotation).toBe(90);
    expect(placed.symbol.mirrorX).toBe(true);
    expect(placed.pins).toEqual(
      new Map([
        ["1", { x: mm(30), y: mm(35) }],
        ["2", { x: mm(30), y: mm(45) }],
      ]),
    );
    expect(placed.symbol.field("Reference")?.position).toEqual({ x: mm(28), y: mm(40) });
  });

  test("moves a placed symbol and its fields while preserving local pin coordinates", () => {
    const placed = placeNativeSymbol(librarySymbol(), {
      reference: "R9",
      value: "22k",
      footprint: "Resistor_SMD:R_0603_1608Metric",
      position: { x: mm(30), y: mm(40) },
    });
    moveNativeSymbol(placed.symbol, { x: mm(50), y: mm(60) });

    expect(placed.symbol.position).toEqual({ x: mm(50), y: mm(60) });
    expect(placed.symbol.pins.map((pin) => pin.position)).toEqual([
      { x: mm(-5), y: mm(0) },
      { x: mm(5), y: mm(0) },
    ]);
    expect(placed.symbol.field("Reference")?.position).toEqual({ x: mm(50), y: mm(58) });
  });

  test("sheet endpoints use the current instance transform without changing local pins", () => {
    const source = librarySymbol();
    const pin = unpackAnyAs(source.proto.items[0]!.item!, SchematicPinSchema)!;
    pin.position = toVector2({ x: mm(-2), y: mm(3) });
    source.proto.items[0]!.item = packAny(SchematicPinSchema, pin);
    // Counterclockwise rotation in sheet coordinates, independently specified for an asymmetric pin.
    const oriented = [
      [-2, 3],
      [3, 2],
      [2, -3],
      [-3, -2],
    ] as const;
    for (const [index, rotation] of ([0, 90, 180, 270] as const).entries())
      for (const mirrorX of [false, true])
        for (const mirrorY of [false, true]) {
          const placed = placeNativeSymbol(source, {
            reference: "R1",
            value: "1k",
            footprint: "",
            position: { x: mm(30), y: mm(40) },
            rotation,
            mirrorX,
            mirrorY,
          });
          const [x, y] = oriented[index]!;
          expect(placed.pins.get("1")).toEqual({ x: mm(30 + (mirrorY ? -x : x)), y: mm(40 + (mirrorX ? -y : y)) });
          const symbol = new SchematicSymbol(
            fromBinary(SchematicSymbolInstanceSchema, toBinary(SchematicSymbolInstanceSchema, placed.symbol.proto)),
          );
          moveNativeSymbol(symbol, { x: mm(100), y: mm(60) });
          expect(schematicPinSheetPosition(symbol, symbol.pins.find((p) => p.number === "1")!)).toEqual({
            x: mm(100 + (mirrorY ? -x : x)),
            y: mm(60 + (mirrorX ? -y : y)),
          });
          expect(symbol.pins.find((p) => p.number === "1")!.position).toEqual({ x: mm(-2), y: mm(3) });
        }
  });

  test("new and existing endpoints select common pins and the current unit/body style", () => {
    const source = librarySymbol();
    for (const [number, unit, style] of [
      ["99", 0, 0],
      ["4", 2, 2],
    ] as const)
      source.proto.items.push(
        create(SchematicSymbolChildSchema, {
          unit: create(SchematicSymbolUnitSchema, { unit }),
          bodyStyle: create(SchematicSymbolBodyStyleSchema, { style }),
          item: packAny(SchematicPinSchema, create(SchematicPinSchema, { number, position: toVector2({ x: mm(2), y: mm(3) }) })),
        }),
      );
    const placed = placeNativeSymbol(source, {
      reference: "U1",
      value: "fixture",
      footprint: "",
      position: { x: mm(100), y: mm(60) },
      unit: 2,
      bodyStyle: 2,
      rotation: 90,
      mirrorY: true,
    });
    expect([...placed.pins.keys()].sort()).toEqual(["4", "99"]);
    expect(placed.symbol.pins.map((p) => p.number).sort()).toEqual(["4", "99"]);
    for (const pin of placed.symbol.pins) expect(schematicPinSheetPosition(placed.symbol, pin)).toEqual(placed.pins.get(pin.number)!);
  });
});
