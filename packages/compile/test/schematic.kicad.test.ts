/** Integration regressions for generated schematic ownership against the pinned KiCad API. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  ErcErrorType,
  GlobalLabelSchema,
  RuleSeverity,
  SchematicFieldSchema,
  SchematicLabelSpinStyle,
  SchematicLineSchema,
  SchematicLineType,
  TextSchema,
} from "@fp-pcb/proto";
import { GlobalLabel, mm, NoConnect, SchematicLine, toVector2 } from "@fp-pcb/client";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedNetMerges, generateSchematic, GENERATED_SCHEMATIC_PROPERTY } from "../src/schematic";
import { registerLibraries } from "../src/libraries";
import type { Netlist } from "../src/types";
import { haveKicad, KICAD_CLI, newProjectWithLibraries, QA_LIBRARIES, startBareServer, type RunningServer } from "./kicad-server";

const STANDARD_SYMBOLS = process.env.KICAD11_SYMBOL_DIR ?? process.env.KICAD_SYMBOL_DIR ?? "";
const haveUsbSymbols = existsSync(join(STANDARD_SYMBOLS, "Connector.kicad_sym")) && existsSync(join(STANDARD_SYMBOLS, "Device.kicad_sym"));
const haveTimerSymbols = haveUsbSymbols && ["Timer", "power"].every((lib) => existsSync(join(STANDARD_SYMBOLS, `${lib}.kicad_sym`)));

/** The USB-C 555 blinker from a Fabdesk circuit_build run whose leftward stubs merged +5V with CTRL. */
function usb555BlinkerNetlist(powerFlags = true): Netlist {
  const part = (ref: string, value: string, lib: string, symbol: string) => ({
    ref,
    value,
    footprint: "x",
    libSource: { lib, part: symbol },
  });
  const nodes = (...keys: string[]) =>
    keys.map((key) => {
      const [ref, pin] = key.split(":") as [string, string];
      return { ref, pin };
    });
  const netlist: Netlist = {
    components: [
      part("J1", "USB_C_POWER", "Connector", "USB_C_Receptacle_PowerOnly_6P"),
      part("R1", "10k", "Device", "R"),
      part("R2", "68k", "Device", "R"),
      part("R5", "1k", "Device", "R"),
      part("#FLG02", "PWR_FLAG", "power", "PWR_FLAG"),
      part("R3", "5.1k", "Device", "R"),
      part("R4", "5.1k", "Device", "R"),
      part("D1", "RED", "Device", "LED"),
      part("C2", "10nF", "Device", "C"),
      part("C3", "100nF", "Device", "C"),
      part("C1", "10uF", "Device", "C"),
      part("#FLG01", "PWR_FLAG", "power", "PWR_FLAG"),
      part("U1", "NE555D", "Timer", "NE555D"),
    ],
    nets: [
      // NE555D pins 8 (+5V) and 5 (CTRL) are adjacent on the symbol's top edge.
      { name: "+5V", nodes: nodes("J1:A9", "J1:B9", "U1:8", "U1:4", "R1:1", "C3:1", "#FLG01:1") },
      { name: "DISCH", nodes: nodes("R1:2", "R2:1", "U1:7") },
      { name: "TIMING", nodes: nodes("R2:2", "U1:2", "U1:6", "C1:1") },
      { name: "CTRL", nodes: nodes("U1:5", "C2:1") },
      { name: "OUT", nodes: nodes("U1:3", "R5:1") },
      { name: "LED_A", nodes: nodes("R5:2", "D1:2") },
      { name: "CC1", nodes: nodes("J1:A5", "R3:1") },
      { name: "CC2", nodes: nodes("J1:B5", "R4:1") },
      { name: "GND", nodes: nodes("J1:A12", "J1:B12", "U1:1", "R3:2", "R4:2", "C1:2", "C2:2", "C3:2", "D1:1", "#FLG02:1") },
    ],
    noConnects: nodes("J1:S1"),
  };
  if (powerFlags) return netlist;
  // Without the flags every later symbol shifts one grid slot, which put J1's downward GND stub in
  // the column above R3's upward CC1 stub.
  const flag = (ref: string) => ref.startsWith("#FLG");
  return {
    ...netlist,
    components: netlist.components.filter((component) => !flag(component.ref)),
    nets: netlist.nets.map((net) => ({ ...net, nodes: net.nodes.filter((node) => !flag(node.ref)) })),
  };
}

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
  const registerTimerLibraries = () =>
    registerLibraries(
      server.kicad,
      ["Connector", "Device", "Timer", "power"].map((lib) => ({
        kind: "symbol" as const,
        nickname: lib,
        uri: join(STANDARD_SYMBOLS, `${lib}.kicad_sym`),
      })),
    );

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

  test("a short between generated labels is reported although KiCad rates it a warning", async () => {
    const { board } = await newProjectWithLibraries(server.kicad, root, "generated-net-merge");
    const project = server.kicad.projectFrom(board.specifier);
    let schematic = (await server.kicad.currentSchematic()) ?? (await project.openSchematic());
    const labelledWire = (y: number, names: [string, string], owned: boolean) => {
      const [start, end] = [
        { x: mm(25.4), y: mm(y) },
        { x: mm(50.8), y: mm(y) },
      ];
      const wire = new SchematicLine(
        create(SchematicLineSchema, { start: toVector2(start), end: toVector2(end), type: SchematicLineType.SLT_WIRE }),
      );
      const labels = ([start, end] as const).map(
        (position, index) =>
          new GlobalLabel(
            create(GlobalLabelSchema, {
              position: toVector2(position),
              text: create(TextSchema, { text: names[index], position: toVector2(position) }),
              spinStyle: index ? SchematicLabelSpinStyle.SLSS_RIGHT : SchematicLabelSpinStyle.SLSS_LEFT,
              fields: owned
                ? [
                    create(SchematicFieldSchema, {
                      name: GENERATED_SCHEMATIC_PROPERTY,
                      visible: false,
                      text: create(TextSchema, { text: "circuit.netlist.json", position: toVector2(position) }),
                    }),
                  ]
                : [],
            }),
          ),
      );
      return [wire, ...labels];
    };
    await (
      await schematic.rootSheet()
    ).commit("test: generated and manual shorts", (tx) =>
      tx.create([...labelledWire(25.4, ["+5V", "CTRL"], true), ...labelledWire(50.8, ["MANUAL_A", "MANUAL_B"], false)]),
    );
    await schematic.save();
    await schematic.close();

    schematic = await project.openSchematic();
    const erc = await schematic.erc.run();
    // The pre-existing gate only rejects ERC errors; both shorts arrive as warnings.
    const conflicts = erc.markers.filter((marker) => marker.errorType === ErcErrorType.ERCET_DRIVER_CONFLICT);
    expect(conflicts.map((marker) => marker.severity)).toEqual([RuleSeverity.RS_WARNING, RuleSeverity.RS_WARNING]);
    const merges = await generatedNetMerges(schematic, erc.markers);
    expect(merges).toHaveLength(1);
    expect(merges[0]).toContain("CTRL");
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
      let erc = await schematic.erc.run();
      expect(erc.errorCount).toBe(0);
      expect(erc.markers.filter((marker) => /doesn't match copy in library/i.test(marker.description))).toEqual([]);

      generated = await generateSchematic(server.kicad, usbPowerNetlist("USB_C_Receptacle_PowerOnly_6P"));
      expect(generated.diagnostics).toEqual([]);
      expect(generated.noConnectsCreated).toBe(0);
      await generated.schematic.save();
      await generated.schematic.close();
      schematic = await server.kicad.projectFrom(board.specifier).openSchematic();
      const sheet = await schematic.rootSheet();
      expect((await sheet.getAllItems()).filter((item) => item instanceof NoConnect)).toHaveLength(0);
      expect((await sheet.getAllItems()).filter((item) => item instanceof GlobalLabel)).toHaveLength(11);
      erc = await schematic.erc.run();
      expect(erc.errorCount).toBe(0);
      expect(erc.markers.filter((marker) => /doesn't match copy in library/i.test(marker.description))).toEqual([]);
    },
    60_000,
  );

  for (const timer of ["NE555D", "TLC555xD"])
    test.skipIf(!haveTimerSymbols)(
      `stubs on ${timer} pins keep exact saved endpoints separate and satisfy ERC`,
      async () => {
        const { board } = await newProjectWithLibraries(server.kicad, root, `${timer}-top-edge`);
        await registerTimerLibraries();

        const source = usb555BlinkerNetlist();
        source.components.find((component) => component.ref === "U1")!.libSource!.part = timer;
        const generated = await generateSchematic(server.kicad, source);
        expect(generated.diagnostics).toEqual([]);
        await generated.schematic.save();
        await generated.schematic.close();

        const schematic = await server.kicad.projectFrom(board.specifier).openSchematic();
        const erc = await schematic.erc.run();
        // Placeholder footprints are irrelevant here; every connectivity marker is a regression.
        const markers = erc.markers.map((marker) => marker.description).filter((description) => !/footprint library/i.test(description));
        expect(markers).toEqual([]);
        expect(erc.errorCount).toBe(0);
        expect(await generatedNetMerges(schematic, erc.markers)).toEqual([]);
        const pinNumbers = (await (await schematic.rootSheet()).getSymbols())
          .find((symbol) => symbol.reference === "U1")!
          .pins.map((pin) => pin.number)
          .sort();
        expect(pinNumbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
        const projectDir = join(root, `${timer}-top-edge`);
        const xmlPath = join(projectDir, "saved.xml");
        const proc = Bun.spawn(
          [KICAD_CLI, "sch", "export", "netlist", "--format", "kicadxml", "-o", xmlPath, join(projectDir, `${timer}-top-edge.kicad_sch`)],
          { stdout: "ignore", stderr: "pipe" },
        );
        const stderr = new Response(proc.stderr).text();
        expect(await proc.exited, await stderr).toBe(0);
        const nets: Record<string, string[]> = {};
        const attribute = (text: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(text)![1]!;
        for (const match of (await readFile(xmlPath, "utf8")).matchAll(/<net\b([^>]*)>([\s\S]*?)<\/net>/g))
          nets[attribute(match[1]!, "name")] = [...match[2]!.matchAll(/<node\b([^>]*)\/?\s*>/g)]
            .map((node) => `${attribute(node[1]!, "ref")}:${attribute(node[1]!, "pin")}`)
            .sort();
        expect(nets).toEqual(
          Object.fromEntries(
            source.nets.map((net) => [
              net.name,
              net.nodes
                .filter((node) => !node.ref.startsWith("#"))
                .map((node) => `${node.ref}:${node.pin}`)
                .sort(),
            ]),
          ),
        );
      },
      60_000,
    );

  test.skipIf(!haveTimerSymbols)(
    "a tall connector's bottom stubs stay clear of the next row's top stubs",
    async () => {
      const { board } = await newProjectWithLibraries(server.kicad, root, "ne555-no-flags");
      await registerTimerLibraries();

      const generated = await generateSchematic(server.kicad, usb555BlinkerNetlist(false));
      expect(generated.diagnostics).toEqual([]);
      await generated.schematic.save();
      await generated.schematic.close();

      // Unflagged power pins are ERC errors by design here; only net merges matter.
      const schematic = await server.kicad.projectFrom(board.specifier).openSchematic();
      const erc = await schematic.erc.run();
      expect(
        erc.markers.filter((marker) => marker.errorType === ErcErrorType.ERCET_DRIVER_CONFLICT).map((marker) => marker.description),
      ).toEqual([]);
    },
    60_000,
  );
});
