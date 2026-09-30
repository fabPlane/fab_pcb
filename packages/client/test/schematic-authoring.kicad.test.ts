/** Compare model endpoints with KiCad's own saved-file pin locations, including normalized mirrors. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibSymbol, mm, placeNativeSymbol, schematicPinSheetPosition, type PlacedNativeSymbol } from "../src";
import { haveKicad, KICAD_CLI, startKiCad } from "./kicad-server";

const symbols = process.env.KICAD_SYMBOL_DIR;

describe.skipIf(!haveKicad() || !symbols)("native schematic pin transforms against saved KiCad", () => {
  test("new and reopened asymmetric pins match ERC positions for every rotation and mirror", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fp-pcb-sheet-pins-"));
    const server = await startKiCad(null, "sheet-pins");
    try {
      await server.kicad.newProject(join(dir, "board.kicad_pro"));
      await server.kicad.libraries.addTableRow("symbol", "project", {
        nickname: "Connector_Generic",
        type: "KiCad",
        enabled: true,
        uri: join(symbols!, "Connector_Generic.kicad_sym"),
      });
      const source = await server.kicad.libraries.symbols.get("Connector_Generic:Conn_01x02");
      expect(source).toBeInstanceOf(LibSymbol);
      if (!(source instanceof LibSymbol)) throw new Error("connector definition unavailable");
      let schematic = await server.kicad.openSchematic(join(dir, "board.kicad_sch"));
      let sheet = await schematic.rootSheet();
      const placed: PlacedNativeSymbol[] = [];
      for (const rotation of [0, 90, 180, 270] as const)
        for (const mirrorX of [false, true])
          for (const mirrorY of [false, true])
            placed.push(
              placeNativeSymbol(source, {
                reference: `J${placed.length + 1}`,
                value: "probe",
                footprint: "",
                position: { x: mm(30.48 + (placed.length % 4) * 25.4), y: mm(30.48 + Math.floor(placed.length / 4) * 25.4) },
                rotation,
                mirrorX,
                mirrorY,
              }),
            );
      await sheet.commit("test native endpoint transforms", (tx) => tx.create(placed.map((p) => p.symbol)));
      await schematic.save();
      await schematic.close();
      schematic = await server.kicad.openSchematic(join(dir, "board.kicad_sch"));
      sheet = await schematic.rootSheet();
      const out = join(dir, "erc.json");
      const proc = Bun.spawn([KICAD_CLI, "sch", "erc", "--format", "json", "--units", "mm", "-o", out, join(dir, "board.kicad_sch")], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = new Response(proc.stderr).text();
      expect(await proc.exited, await stderr).toBe(0);
      const report = JSON.parse(await readFile(out, "utf8"));
      const endpoints = new Map<string, { x: number; y: number }>();
      for (const s of report.sheets)
        for (const violation of s.violations)
          if (violation.type === "pin_not_connected") {
            const item = violation.items[0];
            const match = /Symbol (\S+) Pin (\S+)/.exec(item.description)!;
            endpoints.set(`${match[1]}:${match[2]}`, item.pos);
          }
      expect(endpoints.size).toBe(32);
      for (const symbol of await sheet.getSymbols())
        for (const pin of symbol.pins) {
          const actual = endpoints.get(`${symbol.reference}:${pin.number}`)!;
          const endpoint = schematicPinSheetPosition(symbol, pin);
          expect(endpoint).toEqual({ x: Math.round(mm(actual.x)), y: Math.round(mm(actual.y)) });
          expect(placed.find((p) => p.symbol.reference === symbol.reference)!.pins.get(pin.number)).toEqual(endpoint);
          expect(pin.position).toEqual(source.pins.find((p) => p.number === pin.number)!.position);
        }
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
