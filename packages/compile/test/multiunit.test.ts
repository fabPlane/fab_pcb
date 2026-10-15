import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { SchematicSymbolSchema } from "@fp-pcb/proto";
import { LibSymbol, SchematicSymbol, SchematicLine, NoConnect, schematicPinSheetPosition } from "@fp-pcb/client";
import { buildGeneratedSchematic } from "../src/schematic";
import stock from "./fixtures/stock-multiunit-symbols.json";

// Effective stock definitions captured from packaged KiCad 10.99.0-4517-g329aba9ff.
// Native integration separately uses the actual stock libraries, not these captured bytes.
describe("stock multi-unit symbol geometry", () => {
  for (const row of stock)
    test(row.id, () => {
      const definition = new LibSymbol(fromBinary(SchematicSymbolSchema, Buffer.from(row.protoBase64, "base64")));
      const allPins = Array.from({ length: definition.unitCount }, (_, i) => definition.unitItems(i + 1))
        .flat()
        .filter((p: any) => typeof p.number === "string")
        .map((p: any) => p.number as string);
      const uniquePins = [...new Set(allPins)];
      const [lib, part] = row.id.split(":") as [string, string];
      const netlist = {
        components: [{ ref: "U1", value: part, footprint: "x", libSource: { lib, part } }],
        nets: uniquePins.map((pin) => ({ name: `PIN_${pin}`, nodes: [{ ref: "U1", pin }] })),
      };
      const result = buildGeneratedSchematic(netlist, new Map([[row.id, definition]]));
      expect(result.diagnostics).toEqual([]);
      const symbols = result.items.filter((x): x is SchematicSymbol => x instanceof SchematicSymbol);
      expect(symbols.map((x) => x.unit)).toEqual(Array.from({ length: definition.unitCount }, (_, i) => i + 1));
      const wires = result.items.filter((x): x is SchematicLine => x instanceof SchematicLine);
      const starts = new Set(wires.map((x) => `${x.start.x}:${x.start.y}`));
      for (const symbol of symbols)
        for (const pin of symbol.pins) {
          const at = schematicPinSheetPosition(symbol, pin);
          expect(starts.has(`${at.x}:${at.y}`)).toBe(true);
        }
      // Different pins on different units must not coincide (the LM358 net-merge regression).
      const positions = new Map<string, string>();
      for (const symbol of symbols)
        for (const pin of symbol.pins) {
          const at = schematicPinSheetPosition(symbol, pin),
            key = `${at.x}:${at.y}`;
          expect(positions.get(key) ?? pin.number).toBe(pin.number);
          positions.set(key, pin.number);
        }
      const disconnected = buildGeneratedSchematic(
        { ...netlist, nets: [], noConnects: uniquePins.map((pin) => ({ ref: "U1", pin })) },
        new Map([[row.id, definition]]),
      );
      expect(disconnected.diagnostics).toEqual([]);
      expect(disconnected.items.filter((x) => x instanceof NoConnect).length).toBe(positions.size);
    });
});
