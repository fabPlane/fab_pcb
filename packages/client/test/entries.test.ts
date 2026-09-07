/**
 * Mapping-shaped arguments (`toEntries`) and the three model methods that take one.
 *
 * The bug these cover: `Array.isArray(x) ? x : Object.entries(x)` silently reads a `Map` as
 * empty, so the command was sent with nothing in it and reported success.
 */
import { describe, expect, test } from "bun:test";
import {
  AssignFootprintsResponseSchema,
  AssignFootprintsSchema,
  DocumentType,
  ListWizardsResponseSchema,
  ListWizardsSchema,
  MapMergeMode,
  RunWizardSchema,
  SetTextVariablesSchema,
  WizardGeneratedContentSchema,
  WizardGenerationStatus,
} from "@fp-pcb/proto";
import { KiCadClient } from "../src/client";
import { KiCad, Project, Schematic, toEntries, toRecord } from "../src/model";
import { FakeTransport, ok, reply } from "./fake-transport";

async function connect(t: FakeTransport): Promise<KiCad> {
  return new KiCad(await KiCadClient.connect(t, { clientName: "fp-pcb/test" }));
}

const SPEC = {
  $typeName: "kiapi.common.types.DocumentSpecifier" as const,
  type: DocumentType.DOCTYPE_SCHEMATIC,
  project: undefined,
  identifier: { case: undefined },
} as never;

// ------------------------------------------------------------------ toEntries

describe("toEntries", () => {
  test("accepts a Map, a plain object, an array of pairs and any iterable of pairs", () => {
    const expected = [
      ["R1", "a"],
      ["R2", "b"],
    ];
    expect(toEntries(new Map(expected as [string, string][]), "x")).toEqual(expected as [string, string][]);
    expect(toEntries({ R1: "a", R2: "b" }, "x")).toEqual(expected as [string, string][]);
    expect(toEntries(expected as [string, string][], "x")).toEqual(expected as [string, string][]);
    expect(toEntries(new Map(expected as [string, string][]).entries(), "x")).toEqual(expected as [string, string][]);
    function* gen(): Generator<readonly [string, string]> {
      yield ["R1", "a"];
      yield ["R2", "b"];
    }
    expect(toEntries(gen(), "x")).toEqual(expected as [string, string][]);
  });

  test("an empty mapping of any shape is empty, not an error", () => {
    expect(toEntries(new Map(), "x")).toEqual([]);
    expect(toEntries({}, "x")).toEqual([]);
    expect(toEntries([], "x")).toEqual([]);
  });

  test("rejects everything that is not a mapping, naming the argument", () => {
    const bad: unknown[] = [null, undefined, "R1", 7, true, new Set(["R1"]), ["R1", "R2"], [["R1"]], [[1, "a"]]];
    for (const value of bad) {
      expect(() => toEntries(value as never, "assignFootprints(assignments)")).toThrow(/assignFootprints\(assignments\)/);
    }
    expect(() => toEntries(null as never, "x")).toThrow(TypeError);
    expect(() => toEntries(new Set(["R1"]) as never, "x")).toThrow(/\[key, value\] pair/);
    expect(() => toEntries([[1, "a"]] as never, "x")).toThrow(/keys must be strings/);
  });

  test("toRecord builds a plain object for proto map fields", () => {
    expect(toRecord(new Map([["VERSION", "1.0"]]), "x")).toEqual({ VERSION: "1.0" });
    expect(toRecord({ VERSION: "1.0" }, "x")).toEqual({ VERSION: "1.0" });
  });
});

// ------------------------------------------------------------------ assignFootprints

describe("Schematic.assignFootprints", () => {
  async function schematic(): Promise<{ t: FakeTransport; sch: Schematic }> {
    const t = new FakeTransport();
    t.on(AssignFootprintsSchema, (req) =>
      reply(AssignFootprintsResponseSchema, { assignedCount: req.assignments.length, unmatchedReferences: [] }),
    );
    return { t, sch: new Schematic(await connect(t), SPEC) };
  }

  const sent = (t: FakeTransport) =>
    t
      .requestsOf(AssignFootprintsSchema)[0]!
      .assignments.map((a) => [a.reference, `${a.footprint?.libraryNickname}:${a.footprint?.entryName}`]);
  const EXPECTED = [
    ["R1", "Resistor_SMD:R_0805"],
    ["C1", "Capacitor_SMD:C_0603"],
  ];

  test("a Map is assigned, not silently dropped", async () => {
    const { t, sch } = await schematic();
    const res = await sch.assignFootprints(
      new Map([
        ["R1", "Resistor_SMD:R_0805"],
        ["C1", "Capacitor_SMD:C_0603"],
      ]),
    );
    expect(sent(t)).toEqual(EXPECTED);
    expect(res.assignedCount).toBe(2);
  });

  test("a Record is assigned", async () => {
    const { t, sch } = await schematic();
    const res = await sch.assignFootprints({ R1: "Resistor_SMD:R_0805", C1: "Capacitor_SMD:C_0603" });
    expect(sent(t)).toEqual(EXPECTED);
    expect(res.assignedCount).toBe(2);
  });

  test("both array forms are assigned", async () => {
    const pairs = await schematic();
    await pairs.sch.assignFootprints([
      ["R1", "Resistor_SMD:R_0805"],
      ["C1", "Capacitor_SMD:C_0603"],
    ]);
    expect(sent(pairs.t)).toEqual(EXPECTED);

    const records = await schematic();
    await records.sch.assignFootprints([
      { reference: "R1", footprint: "Resistor_SMD:R_0805" },
      { reference: "C1", footprint: { nickname: "Capacitor_SMD", name: "C_0603" } },
    ]);
    expect(sent(records.t)).toEqual(EXPECTED);
  });

  test("garbage throws instead of assigning nothing", async () => {
    const { t, sch } = await schematic();
    for (const bad of [null, undefined, "R1", 7, new Set(["R1"])]) {
      await expect(sch.assignFootprints(bad as never)).rejects.toThrow(/assignFootprints\(assignments\)/);
    }
    // nothing reached the server
    expect(t.countOf(AssignFootprintsSchema)).toBe(0);
  });
});

// ------------------------------------------------------------------ the other two call sites

describe("other mapping arguments", () => {
  test("Project.setTextVariables sends a Map's contents (a replace-mode Map used to wipe them)", async () => {
    const t = new FakeTransport();
    t.on(SetTextVariablesSchema, () => ok());
    const project = new Project(await connect(t), SPEC);

    await project.setTextVariables(new Map([["VERSION", "1.0"]]), MapMergeMode.MMM_REPLACE);
    expect(t.requestsOf(SetTextVariablesSchema)[0]!.variables?.variables).toEqual({ VERSION: "1.0" });

    await project.setTextVariables({ REV: "B" });
    expect(t.requestsOf(SetTextVariablesSchema)[1]!.variables?.variables).toEqual({ REV: "B" });

    await expect(project.setTextVariables(new Set(["VERSION"]) as never)).rejects.toThrow(/setTextVariables\(variables\)/);
  });

  test("Libraries.runWizard types a Map's parameters instead of running with defaults", async () => {
    const t = new FakeTransport();
    t.on(ListWizardsSchema, () =>
      reply(ListWizardsResponseSchema, {
        wizards: [
          { meta: { identifier: "circular_pad_array" }, parameters: [{ identifier: "pads", value: { case: "int", value: { value: 1 } } }] },
        ],
      }),
    );
    t.on(RunWizardSchema, () => reply(WizardGeneratedContentSchema, { status: WizardGenerationStatus.WGS_OK }));
    const kicad = await connect(t);

    await kicad.libraries.runWizard("circular_pad_array", new Map([["pads", 8]]));
    const params = t.requestsOf(RunWizardSchema)[0]!.parameters?.parameters ?? [];
    expect(params.map((p) => [p.identifier, p.value.case === "int" ? p.value.value.value : undefined])).toEqual([["pads", 8]]);

    await expect(kicad.libraries.runWizard("circular_pad_array", new Set(["pads"]) as never)).rejects.toThrow(
      /runWizard\(circular_pad_array, params\)/,
    );
  });
});
