/** Integration regressions for generated schematic ownership against the pinned KiCad API. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  GlobalLabelSchema,
  SchematicFieldSchema,
  SchematicLabelSpinStyle,
  SchematicLineSchema,
  SchematicLineType,
  TextSchema,
} from "@fp-pcb/proto";
import { GlobalLabel, mm, NoConnect, SchematicLine, toVector2 } from "@fp-pcb/client";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSchematic, GENERATED_SCHEMATIC_PROPERTY } from "../src/schematic";
import { registerLibraries } from "../src/libraries";
import type { Netlist } from "../src/types";
import { haveKicad, KICAD_CLI, newProjectWithLibraries, QA_LIBRARIES, startBareServer, type RunningServer } from "./kicad-server";

const STANDARD_SYMBOLS = process.env.KICAD11_SYMBOL_DIR ?? process.env.KICAD_SYMBOL_DIR ?? "";
const haveUsbSymbols = existsSync(join(STANDARD_SYMBOLS, "Connector.kicad_sym")) && existsSync(join(STANDARD_SYMBOLS, "Device.kicad_sym"));

function usbPowerNetlist(part: "USB_C_Receptacle_USB2.0_16P" | "USB_C_Receptacle_PowerOnly_6P"): Netlist {
  const full = part === "USB_C_Receptacle_USB2.0_16P";
  return {
    components: [
      { ref: "J1", value: "USB-C Power", footprint: "x", libSource: { lib: "Connector", part } },
      { ref: "R1", value: "5.1k", footprint: "x", libSource: { lib: "Device", part: "R" } },
      { ref: "R2", value: "5.1k", footprint: "x", libSource: { lib: "Device", part: "R" } },
    ],
    nets: [
      {
        name: "VBUS",
        nodes: (full ? ["A4", "A9", "B4", "B9"] : ["A9", "B9"]).map((pin) => ({ ref: "J1", pin })),
      },
      {
        name: "GND",
        nodes: [
          ...(full ? ["A1", "A12", "B1", "B12"] : ["A12", "B12"]).map((pin) => ({ ref: "J1", pin })),
          { ref: "J1", pin: "S1" },
          { ref: "R1", pin: "2" },
          { ref: "R2", pin: "2" },
        ],
      },
      {
        name: "CC1",
        nodes: [
          { ref: "J1", pin: "A5" },
          { ref: "R1", pin: "1" },
        ],
      },
      {
        name: "CC2",
        nodes: [
          { ref: "J1", pin: "B5" },
          { ref: "R2", pin: "1" },
        ],
      },
    ],
    ...(full
      ? {
          noConnects: ["A6", "A7", "A8", "B6", "B7", "B8"].map((pin) => ({ ref: "J1", pin })),
        }
      : {}),
  };
}

if (!haveKicad()) console.log(`[skip] pinned kicad-cli or qa libraries not found (${KICAD_CLI})`);

describe.skipIf(!haveKicad())("generated schematic + kicad-cli api-server", () => {
  let server: RunningServer;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fp-pcb-schematic-"));
    server = await startBareServer("schematic");
  }, 90_000);

  afterAll(async () => {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("a generated global label remains discoverable and can be deleted after save/reopen", async () => {
    const { board } = await newProjectWithLibraries(server.kicad, root, "global-label-delete");
    const project = server.kicad.projectFrom(board.specifier);
    let schematic = (await server.kicad.currentSchematic()) ?? (await project.openSchematic());
    let sheet = await schematic.rootSheet();
    const position = { x: mm(25.4), y: mm(25.4) };
    const label = new GlobalLabel(
      create(GlobalLabelSchema, {
        position: toVector2(position),
        text: create(TextSchema, { text: "OLD_NET", position: toVector2(position) }),
        spinStyle: SchematicLabelSpinStyle.SLSS_LEFT,
        fields: [
          create(SchematicFieldSchema, {
            name: GENERATED_SCHEMATIC_PROPERTY,
            visible: false,
            text: create(TextSchema, { text: "circuit.netlist.json", position: toVector2(position) }),
          }),
        ],
      }),
    );
    label.setCustomProperty(GENERATED_SCHEMATIC_PROPERTY, "circuit.netlist.json");
    await sheet.commit("test: create global label", (tx) => tx.create([label]));
    await schematic.save();
    await schematic.close();

    schematic = await project.openSchematic();
    sheet = await schematic.rootSheet();
    const generated = (await sheet.getAllItems()).filter(
      (item) =>
        item.customProperties[GENERATED_SCHEMATIC_PROPERTY] === "circuit.netlist.json" ||
        (item instanceof GlobalLabel &&
          item.fields.some((field) => field.name === GENERATED_SCHEMATIC_PROPERTY && field.text === "circuit.netlist.json")),
    );
    expect(generated).toHaveLength(1);
    expect(generated[0]).toBeInstanceOf(GlobalLabel);
    await sheet.commit("test: delete global label", (tx) => tx.delete(generated));

    const remaining = await sheet.getAllItems();
    expect(remaining.filter((item) => item instanceof GlobalLabel)).toHaveLength(0);
    expect(await schematic.saveToString()).not.toContain("OLD_NET");
  }, 60_000);

  test("rebuild removes legacy global labels by their generated wire endpoint", async () => {
    const { board } = await newProjectWithLibraries(server.kicad, root, "legacy-global-label-delete");
    const project = server.kicad.projectFrom(board.specifier);
    let schematic = (await server.kicad.currentSchematic()) ?? (await project.openSchematic());
    let sheet = await schematic.rootSheet();
    const start = { x: mm(30.48), y: mm(25.4) };
    const end = { x: mm(25.4), y: mm(25.4) };
    const wire = new SchematicLine(
      create(SchematicLineSchema, { start: toVector2(start), end: toVector2(end), type: SchematicLineType.SLT_WIRE }),
    );
    const label = new GlobalLabel(
      create(GlobalLabelSchema, {
        position: toVector2(end),
        text: create(TextSchema, { text: "LEGACY_NET", position: toVector2(end) }),
        spinStyle: SchematicLabelSpinStyle.SLSS_LEFT,
      }),
    );
    for (const item of [wire, label]) item.setCustomProperty(GENERATED_SCHEMATIC_PROPERTY, "circuit.netlist.json");
    await sheet.commit("test: create legacy generated stub", (tx) => tx.create([wire, label]));
    await schematic.save();
    await schematic.close();

    schematic = await project.openSchematic();
    sheet = await schematic.rootSheet();
    const before = await sheet.getAllItems();
    expect(before.find((item) => item instanceof SchematicLine)?.customProperties[GENERATED_SCHEMATIC_PROPERTY]).toBe(
      "circuit.netlist.json",
    );
    expect(before.find((item) => item instanceof GlobalLabel)?.customProperties[GENERATED_SCHEMATIC_PROPERTY]).toBeUndefined();

    await generateSchematic(server.kicad, { components: [], nets: [] });
    const remaining = await sheet.getAllItems();
    expect(remaining.filter((item) => item instanceof SchematicLine || item instanceof GlobalLabel)).toHaveLength(0);
  }, 60_000);

  test("explicit no-connects survive save/reopen and satisfy ERC", async () => {
    const { board } = await newProjectWithLibraries(server.kicad, root, "explicit-no-connect");
    await registerLibraries(server.kicad, [
      { kind: "symbol", nickname: "Device", uri: join(QA_LIBRARIES, "Device.kicad_sym"), description: "qa copy" },
    ]);
    const generated = await generateSchematic(server.kicad, {
      components: [
        {
          ref: "R1",
          value: "10k",
          footprint: "Resistor_SMD:R_0402_1005Metric",
          libSource: { lib: "Device", part: "R" },
        },
      ],
      nets: [],
      noConnects: [
        { ref: "R1", pin: "1" },
        { ref: "R1", pin: "2" },
      ],
    });
    expect(generated.diagnostics).toEqual([]);
    expect(generated.noConnectsCreated).toBe(2);
    await generated.schematic.save();
    await generated.schematic.close();

    const schematic = await server.kicad.projectFrom(board.specifier).openSchematic();
    const sheet = await schematic.rootSheet();
    expect((await sheet.getAllItems()).filter((item) => item instanceof NoConnect)).toHaveLength(2);
    expect((await schematic.erc.run()).errorCount).toBe(0);
  }, 60_000);

  test.skipIf(!haveUsbSymbols)(
    "USB-C rebuild replaces 16-pin labels/no-connects with a clean 6-pin schematic",
    async () => {
      const { board } = await newProjectWithLibraries(server.kicad, root, "usb-rebuild");
      await registerLibraries(server.kicad, [
        { kind: "symbol", nickname: "Connector", uri: join(STANDARD_SYMBOLS, "Connector.kicad_sym") },
        { kind: "symbol", nickname: "Device", uri: join(STANDARD_SYMBOLS, "Device.kicad_sym") },
      ]);

      let generated = await generateSchematic(server.kicad, usbPowerNetlist("USB_C_Receptacle_USB2.0_16P"));
      expect(generated.diagnostics).toEqual([]);
      expect(generated.noConnectsCreated).toBe(6);
      await generated.schematic.save();
      await generated.schematic.close();
      let schematic = await server.kicad.projectFrom(board.specifier).openSchematic();
      expect((await schematic.erc.run()).errorCount).toBe(0);

      generated = await generateSchematic(server.kicad, usbPowerNetlist("USB_C_Receptacle_PowerOnly_6P"));
      expect(generated.diagnostics).toEqual([]);
      expect(generated.noConnectsCreated).toBe(0);
      await generated.schematic.save();
      await generated.schematic.close();
      schematic = await server.kicad.projectFrom(board.specifier).openSchematic();
      const sheet = await schematic.rootSheet();
      expect((await sheet.getAllItems()).filter((item) => item instanceof NoConnect)).toHaveLength(0);
      expect((await sheet.getAllItems()).filter((item) => item instanceof GlobalLabel)).toHaveLength(11);
      expect((await schematic.erc.run()).errorCount).toBe(0);
    },
    60_000,
  );
});
