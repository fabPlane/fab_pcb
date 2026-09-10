import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  KIIDSchema,
  LibraryIdentifierSchema,
  packAny,
  SchematicFieldSchema,
  SchematicPinSchema,
  SchematicSymbolChildSchema,
  SchematicSymbolSchema,
  TextSchema,
} from "@fp-pcb/proto";
import { LibSymbol, LocalLabel, mm, SchematicLine, SchematicSymbol, toVector2 } from "@fp-pcb/client";
import { buildGeneratedSchematic, GENERATED_SCHEMATIC_PROPERTY } from "../src/schematic";

function deviceSymbol(): LibSymbol {
  const pin = (number: string, x: number, y: number) =>
    create(SchematicSymbolChildSchema, {
      unit: { unit: 1 },
      bodyStyle: { style: 1 },
      item: packAny(
        SchematicPinSchema,
        create(SchematicPinSchema, {
          id: create(KIIDSchema, { value: `library-pin-${number}` }),
          number,
          position: toVector2({ x: mm(x), y: mm(y) }),
        }),
      ),
    });
  const field = (name: string, text: string, x: number, y: number) =>
    create(SchematicFieldSchema, { name, text: create(TextSchema, { text, position: toVector2({ x: mm(x), y: mm(y) }) }) });
  return new LibSymbol(
    create(SchematicSymbolSchema, {
      id: create(LibraryIdentifierSchema, { libraryNickname: "Device", entryName: "R" }),
      referenceField: field("Reference", "R", 0, -2),
      valueField: field("Value", "R", 0, 2),
      footprintField: field("Footprint", "", 0, 0),
      datasheetField: field("Datasheet", "", 0, 0),
      descriptionField: field("Description", "resistor", 0, 0),
      unitCount: 1,
      items: [pin("1", -5, 0), pin("2", 5, 0)],
    }),
  );
}

describe("generated schematic", () => {
  test("draws library symbols and labelled wire stubs with absolute field and pin geometry", () => {
    const result = buildGeneratedSchematic(
      {
        components: [{ ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0402", libSource: { lib: "Device", part: "R" } }],
        nets: [{ name: "VCC", nodes: [{ ref: "R1", pin: "1" }] }],
      },
      new Map([["Device:R", deviceSymbol()]]),
    );

    expect(result.diagnostics).toEqual([]);
    expect([result.symbolsCreated, result.wiresCreated, result.labelsCreated]).toEqual([1, 1, 1]);
    const symbol = result.items.find((item): item is SchematicSymbol => item instanceof SchematicSymbol)!;
    expect(symbol.reference).toBe("R1");
    expect(symbol.value).toBe("10k");
    expect(symbol.position).toEqual({ x: mm(30.48), y: mm(25.4) });
    expect(symbol.field("Reference")?.position).toEqual({ x: mm(30.48), y: mm(23.4) });
    expect(symbol.pins[0]?.position).toEqual({ x: mm(25.48), y: mm(25.4) });
    const wire = result.items.find((item): item is SchematicLine => item instanceof SchematicLine)!;
    expect(wire.start).toEqual({ x: mm(25.48), y: mm(25.4) });
    expect(wire.end).toEqual({ x: mm(20.4), y: mm(25.4) });
    const label = result.items.find((item): item is LocalLabel => item instanceof LocalLabel)!;
    expect(label.text).toBe("VCC");
    expect(result.items.every((item) => item.customProperties[GENERATED_SCHEMATIC_PROPERTY] === "circuit.netlist.json")).toBe(true);
  });

  test("converts vertical library pins to placed-symbol sheet coordinates", () => {
    const vertical = deviceSymbol();
    const pin1 = vertical.proto.items[0]!.item!;
    const pin2 = vertical.proto.items[1]!.item!;
    pin1.value = packAny(SchematicPinSchema, create(SchematicPinSchema, { number: "1", position: toVector2({ x: 0, y: mm(3.81) }) })).value;
    pin2.value = packAny(
      SchematicPinSchema,
      create(SchematicPinSchema, { number: "2", position: toVector2({ x: 0, y: mm(-3.81) }) }),
    ).value;

    const result = buildGeneratedSchematic(
      {
        components: [{ ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0402", libSource: { lib: "Device", part: "R" } }],
        nets: [
          { name: "VCC", nodes: [{ ref: "R1", pin: "1" }] },
          { name: "GND", nodes: [{ ref: "R1", pin: "2" }] },
        ],
      },
      new Map([["Device:R", vertical]]),
    );

    const symbol = result.items.find((item): item is SchematicSymbol => item instanceof SchematicSymbol)!;
    expect(symbol.pins.map((pin) => pin.position)).toEqual([
      { x: mm(30.48), y: mm(29.21) },
      { x: mm(30.48), y: mm(21.59) },
    ]);
    expect(result.items.filter((item): item is SchematicLine => item instanceof SchematicLine).map((wire) => wire.start)).toEqual([
      { x: mm(30.48), y: mm(29.21) },
      { x: mm(30.48), y: mm(21.59) },
    ]);
  });

  test("does not reuse library pin identities for placed symbols", () => {
    const result = buildGeneratedSchematic(
      {
        components: [
          { ref: "R1", value: "1k", footprint: "x", libSource: { lib: "Device", part: "R" } },
          { ref: "R2", value: "2k2", footprint: "x", libSource: { lib: "Device", part: "R" } },
        ],
        nets: [],
      },
      new Map([["Device:R", deviceSymbol()]]),
    );
    const symbols = result.items.filter((item): item is SchematicSymbol => item instanceof SchematicSymbol);
    const pinIds = symbols.flatMap((symbol) => symbol.pins.map((pin) => pin.id));

    expect(pinIds).toHaveLength(4);
    expect(pinIds).toEqual(["", "", "", ""]);
  });

  test("keeps board compilation compatible while diagnosing missing symbols and pins", () => {
    const result = buildGeneratedSchematic(
      {
        components: [
          { ref: "R1", value: "10k", footprint: "x" },
          { ref: "C1", value: "1u", footprint: "x", libSource: { lib: "Missing", part: "C" } },
        ],
        nets: [
          {
            name: "GND",
            nodes: [
              { ref: "R1", pin: "1" },
              { ref: "C1", pin: "2" },
            ],
          },
        ],
      },
      new Map(),
    );
    expect(result.items).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "missing_symbol",
      "unknown_symbol",
      "unknown_symbol_pin",
      "unknown_symbol_pin",
    ]);
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });
});
