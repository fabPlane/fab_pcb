import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  KIIDSchema,
  LibraryIdentifierSchema,
  packAny,
  SchematicFieldSchema,
  SchematicLabelSpinStyle,
  SchematicPinOrientation,
  SchematicPinSchema,
  SchematicSymbolChildSchema,
  SchematicSymbolSchema,
  TextSchema,
} from "@fp-pcb/proto";
import { GlobalLabel, LibSymbol, mm, NoConnect, SchematicLine, SchematicSymbol, toDistance, toVector2 } from "@fp-pcb/client";
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
      showPinNames: false,
      showPinNumbers: false,
      pinNameOffset: toDistance(mm(0.254)),
      items: [pin("1", -5, 0), pin("2", 5, 0)],
    }),
  );
}

describe("generated schematic", () => {
  test("draws library symbols and labelled wire stubs with absolute field and wire geometry", () => {
    const result = buildGeneratedSchematic(
      {
        components: [{ ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0402", libSource: { lib: "Device", part: "R" } }],
        nets: [{ name: "VCC", nodes: [{ ref: "R1", pin: "1" }] }],
      },
      new Map([["Device:R", deviceSymbol()]]),
    );

    expect(result.diagnostics).toEqual([]);
    expect([result.symbolsCreated, result.wiresCreated, result.labelsCreated]).toEqual([1, 1, 1]);
    expect(result.noConnectsCreated).toBe(0);
    const symbol = result.items.find((item): item is SchematicSymbol => item instanceof SchematicSymbol)!;
    expect(symbol.reference).toBe("R1");
    expect(symbol.value).toBe("10k");
    expect(symbol.proto.showPinNames).toBe(false);
    expect(symbol.proto.showPinNumbers).toBe(false);
    expect(symbol.proto.pinNameOffset).toEqual(toDistance(mm(0.254)));
    expect(symbol.position).toEqual({ x: mm(30.48), y: mm(25.4) });
    expect(symbol.field("Reference")?.position).toEqual({ x: mm(30.48), y: mm(23.4) });
    // Definition pins stay in the symbol's local frame; the wire meets them in sheet coordinates
    expect(symbol.pins[0]?.position).toEqual({ x: mm(-5), y: 0 });
    const wire = result.items.find((item): item is SchematicLine => item instanceof SchematicLine)!;
    expect(wire.start).toEqual({ x: mm(25.48), y: mm(25.4) });
    expect(wire.end).toEqual({ x: mm(20.4), y: mm(25.4) });
    const label = result.items.find((item): item is GlobalLabel => item instanceof GlobalLabel)!;
    expect(label.text).toBe("VCC");
    expect(label.fields.map((field) => [field.name, field.text])).toContainEqual([GENERATED_SCHEMATIC_PROPERTY, "circuit.netlist.json"]);
    expect(result.items.every((item) => item.customProperties[GENERATED_SCHEMATIC_PROPERTY] === "circuit.netlist.json")).toBe(true);
  });

  test("routes wires to vertical library pins in placed-symbol sheet coordinates", () => {
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
      { x: 0, y: mm(3.81) },
      { x: 0, y: mm(-3.81) },
    ]);
    expect(result.items.filter((item): item is SchematicLine => item instanceof SchematicLine).map((wire) => wire.start)).toEqual([
      { x: mm(30.48), y: mm(29.21) },
      { x: mm(30.48), y: mm(21.59) },
    ]);
  });

  test("points labelled stubs away from every symbol edge", () => {
    const symbol = deviceSymbol();
    const pin = (number: string, x: number, y: number, orientation: SchematicPinOrientation) =>
      create(SchematicSymbolChildSchema, {
        unit: { unit: 1 },
        bodyStyle: { style: 1 },
        item: packAny(SchematicPinSchema, create(SchematicPinSchema, { number, orientation, position: toVector2({ x: mm(x), y: mm(y) }) })),
      });
    // Pins 1 and 2 model adjacent pins on the top edge of an NE555. Leftward stubs would
    // cross pin 1 while connecting pin 2 and incorrectly join the two nets.
    symbol.proto.items = [
      pin("1", 0, -10.16, SchematicPinOrientation.SPO_DOWN),
      pin("2", 2.54, -10.16, SchematicPinOrientation.SPO_DOWN),
      pin("3", 0, 10.16, SchematicPinOrientation.SPO_UP),
      pin("4", 10.16, 0, SchematicPinOrientation.SPO_LEFT),
      pin("5", -10.16, 0, SchematicPinOrientation.SPO_RIGHT),
    ];

    const result = buildGeneratedSchematic(
      {
        components: [{ ref: "R1", value: "NE555D", footprint: "x", libSource: { lib: "Device", part: "R" } }],
        nets: ["1", "2", "3", "4", "5"].map((number) => ({ name: `N${number}`, nodes: [{ ref: "R1", pin: number }] })),
      },
      new Map([["Device:R", symbol]]),
    );

    expect(result.diagnostics).toEqual([]);
    const { x, y } = result.items.find((item): item is SchematicSymbol => item instanceof SchematicSymbol)!.position;
    const at = (dx: number, dy: number) => ({ x: x + mm(dx), y: y + mm(dy) });
    const wires = result.items.filter((item): item is SchematicLine => item instanceof SchematicLine);
    expect(wires.map((wire) => [wire.start, wire.end])).toEqual([
      [at(0, -10.16), at(0, -15.24)],
      [at(2.54, -10.16), at(2.54, -15.24)],
      [at(0, 10.16), at(0, 15.24)],
      [at(10.16, 0), at(15.24, 0)],
      [at(-10.16, 0), at(-15.24, 0)],
    ]);
    const labels = result.items.filter((item): item is GlobalLabel => item instanceof GlobalLabel);
    expect(labels.map((label) => label.spinStyle)).toEqual([
      SchematicLabelSpinStyle.SLSS_UP,
      SchematicLabelSpinStyle.SLSS_UP,
      SchematicLabelSpinStyle.SLSS_BOTTOM,
      SchematicLabelSpinStyle.SLSS_RIGHT,
      SchematicLabelSpinStyle.SLSS_LEFT,
    ]);
  });

  test("keeps the historical grid for symbols that fit it", () => {
    const result = buildGeneratedSchematic(
      {
        components: [1, 2, 3, 4, 5, 6].map((n) => ({
          ref: `R${n}`,
          value: "10k",
          footprint: "x",
          libSource: { lib: "Device", part: "R" },
        })),
        nets: [{ name: "VCC", nodes: [1, 2, 3, 4, 5, 6].map((n) => ({ ref: `R${n}`, pin: "1" })) }],
      },
      new Map([["Device:R", deviceSymbol()]]),
    );
    const symbols = result.items.filter((item): item is SchematicSymbol => item instanceof SchematicSymbol);
    // Origins are whole 50 mil grid steps: 24 and 20 units in, 28 x 24 units apart.
    const grid = (x: number, y: number) => ({ x: x * mm(1.27), y: y * mm(1.27) });
    expect(symbols.map((symbol) => symbol.position)).toEqual([
      grid(24, 20),
      grid(52, 20),
      grid(80, 20),
      grid(108, 20),
      grid(24, 44),
      grid(52, 44),
    ]);
  });

  test("spaces rows so a tall symbol's bottom stubs cannot reach the next row's top stubs", () => {
    const pin = (number: string, x: number, y: number, orientation: SchematicPinOrientation) =>
      create(SchematicSymbolChildSchema, {
        unit: { unit: 1 },
        bodyStyle: { style: 1 },
        item: packAny(
          SchematicPinSchema,
          create(SchematicPinSchema, { number, orientation, length: toDistance(mm(2.54)), position: toVector2({ x: mm(x), y: mm(y) }) }),
        ),
      });
    // A USB-C power receptacle reaches 17.78 mm below its origin; a vertical resistor 3.81 mm above.
    // On the historical 30.48 mm row pitch their outward stubs overlapped in the same column.
    const tall = deviceSymbol();
    tall.proto.items = [pin("1", 0, 17.78, SchematicPinOrientation.SPO_UP), pin("2", 15.24, 0, SchematicPinOrientation.SPO_LEFT)];
    const vertical = deviceSymbol();
    vertical.proto.items = [pin("1", 0, -3.81, SchematicPinOrientation.SPO_DOWN), pin("2", 0, 3.81, SchematicPinOrientation.SPO_UP)];
    const part = (ref: string, symbol: string) => ({ ref, value: "x", footprint: "x", libSource: { lib: "Device", part: symbol } });

    const result = buildGeneratedSchematic(
      {
        components: [part("R1", "TALL"), part("R2", "R"), part("R3", "R"), part("R4", "R"), part("R5", "R")],
        nets: [
          {
            name: "GND",
            nodes: [
              { ref: "R1", pin: "1" },
              { ref: "R5", pin: "2" },
            ],
          },
          {
            name: "CC1",
            nodes: [
              { ref: "R1", pin: "2" },
              { ref: "R5", pin: "1" },
            ],
          },
        ],
      },
      new Map([
        ["Device:TALL", tall],
        ["Device:R", vertical],
      ]),
    );

    expect(result.diagnostics).toEqual([]);
    const stubs = result.items.flatMap((item, index) => {
      const label = result.items[index + 1];
      return item instanceof SchematicLine && label instanceof GlobalLabel ? [{ net: label.text, start: item.start, end: item.end }] : [];
    });
    const touches = (a: (typeof stubs)[number], b: (typeof stubs)[number]) => {
      const span = (p: number, q: number) => [Math.min(p, q), Math.max(p, q)] as const;
      const [ax0, ax1] = span(a.start.x, a.end.x);
      const [ay0, ay1] = span(a.start.y, a.end.y);
      const [bx0, bx1] = span(b.start.x, b.end.x);
      const [by0, by1] = span(b.start.y, b.end.y);
      return ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1;
    };
    const shorts = stubs.flatMap((a, i) =>
      stubs
        .slice(i + 1)
        .filter((b) => b.net !== a.net && touches(a, b))
        .map((b) => `${a.net}/${b.net}`),
    );
    expect(shorts).toEqual([]);
    const [r1, r5] = [result.items[0], result.items[4]] as SchematicSymbol[];
    expect(r5!.position.x).toBe(r1!.position.x);
    expect(r5!.position.y - r1!.position.y).toBeGreaterThan(mm(30.48));
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

  test("rejects a symbol whose library reference class does not match the component", () => {
    const result = buildGeneratedSchematic(
      {
        components: [{ ref: "U1", value: "NE555D", footprint: "x", libSource: { lib: "Connector_Generic", part: "Conn_02x04" } }],
        nets: [],
      },
      new Map([["Connector_Generic:Conn_02x04", deviceSymbol()]]),
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "symbol_reference_mismatch", message: expect.stringContaining("declares reference class R, not U") }),
    ]);
  });

  test("draws explicit no-connect intent and rejects an X on a connected position", () => {
    const result = buildGeneratedSchematic(
      {
        components: [{ ref: "R1", value: "10k", footprint: "x", libSource: { lib: "Device", part: "R" } }],
        nets: [{ name: "VCC", nodes: [{ ref: "R1", pin: "1" }] }],
        noConnects: [
          { ref: "R1", pin: "2" },
          { ref: "R1", pin: "1" },
        ],
      },
      new Map([["Device:R", deviceSymbol()]]),
    );

    expect(result.noConnectsCreated).toBe(1);
    expect(result.items.filter((item) => item instanceof NoConnect)).toHaveLength(1);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "no_connect_on_connected_position", severity: "error" })]);
  });

  test("fails closed when the authoritative schematic cannot represent symbols or pins", () => {
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
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
  });
});
