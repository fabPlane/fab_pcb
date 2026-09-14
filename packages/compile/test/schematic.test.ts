import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
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
      item: packAny(SchematicPinSchema, create(SchematicPinSchema, { number, position: toVector2({ x: mm(x), y: mm(y) }) })),
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
    expect(symbol.position).toEqual({ x: mm(30), y: mm(25) });
    expect(symbol.field("Reference")?.position).toEqual({ x: mm(30), y: mm(23) });
    const wire = result.items.find((item): item is SchematicLine => item instanceof SchematicLine)!;
    expect(wire.start).toEqual({ x: mm(25), y: mm(25) });
    expect(wire.end).toEqual({ x: mm(19.92), y: mm(25) });
    const label = result.items.find((item): item is LocalLabel => item instanceof LocalLabel)!;
    expect(label.text).toBe("VCC");
    expect(result.items.every((item) => item.customProperties[GENERATED_SCHEMATIC_PROPERTY] === "circuit.netlist.json")).toBe(true);
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
