/**
 * The emitter and validator are pure, so everything here runs on hand-written IR — no transport,
 * no KiCad. Format expectations are pinned literally: `ImportNetlist` is unforgiving and a silent
 * shape change here would only surface as an empty board.
 */
import { describe, expect, test } from "bun:test";
import { emitKicadNetlist, validateNetlist } from "../src/netlist";
import type { Netlist } from "../src/types";

const DATE = "2026-01-01T00:00:00.000Z";

function netlist(over: Partial<Netlist> = {}): Netlist {
  return {
    components: [
      { ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" },
      { ref: "D1", value: "RED", footprint: "LED_SMD:LED_0603_1608Metric" },
    ],
    nets: [
      {
        name: "GND",
        nodes: [
          { ref: "R1", pin: "2" },
          { ref: "D1", pin: "2" },
        ],
      },
      {
        name: "VCC",
        nodes: [
          { ref: "R1", pin: "1" },
          { ref: "D1", pin: "1" },
        ],
      },
    ],
    ...over,
  };
}

describe("emitKicadNetlist", () => {
  test("writes an export block KiCad's importer recognises", () => {
    const out = emitKicadNetlist(netlist(), { date: DATE });
    expect(out.startsWith('(export (version "E")')).toBe(true);
    expect(out.trimEnd().endsWith(")")).toBe(true);
    expect(out).toContain(`(date "${DATE}")`);
    expect(out).toContain('(comp (ref "R1")');
    expect(out).toContain('(footprint "Resistor_SMD:R_0402_1005Metric")');
    expect(out).toContain('(node (ref "R1") (pin "2"))');
  });

  test("numbers nets from 1 in array order when no code is given", () => {
    const out = emitKicadNetlist(netlist(), { date: DATE });
    expect(out).toContain('(net (code "1") (name "GND")');
    expect(out).toContain('(net (code "2") (name "VCC")');
  });

  test("keeps an explicit net code", () => {
    const out = emitKicadNetlist(netlist({ nets: [{ name: "GND", code: 7, nodes: [{ ref: "R1", pin: "2" }] }] }), { date: DATE });
    expect(out).toContain('(net (code "7") (name "GND")');
  });

  test("escapes backslashes and quotes in every string position", () => {
    const out = emitKicadNetlist(netlist({ components: [{ ref: 'R"1', value: "a\\b", footprint: "" }], nets: [] }), { date: DATE });
    expect(out).toContain('(ref "R\\"1")');
    expect(out).toContain('(value "a\\\\b")');
  });

  test("omits footprint, libsource and tstamps when absent", () => {
    const out = emitKicadNetlist(netlist({ components: [{ ref: "R1", value: "1k", footprint: "" }], nets: [] }), { date: DATE });
    expect(out).not.toContain("(footprint");
    expect(out).not.toContain("(libsource");
    expect(out).not.toContain("(tstamps");
  });

  test("emits fields as a bare value after the name, and libsource and tstamps when present", () => {
    const out = emitKicadNetlist(
      netlist({
        components: [
          {
            ref: "R1",
            value: "1k",
            footprint: "Resistor_SMD:R_0402_1005Metric",
            fields: { MPN: "RC0402FR-071KL" },
            libSource: { lib: "Device", part: "R", description: "Resistor" },
            uuid: "abc",
          },
        ],
        nets: [],
      }),
      { date: DATE },
    );
    expect(out).toContain('(field (name "MPN") "RC0402FR-071KL")');
    expect(out).toContain('(libsource (lib "Device") (part "R") (description "Resistor"))');
    expect(out).toContain('(tstamps "/abc")');
  });

  test("pin function and type ride along only when set", () => {
    const withFn = emitKicadNetlist(
      netlist({ nets: [{ name: "GND", nodes: [{ ref: "R1", pin: "2", pinFunction: "GND", pinType: "passive" }] }] }),
      { date: DATE },
    );
    expect(withFn).toContain('(pinfunction "GND")');
    expect(withFn).toContain('(pintype "passive")');
    expect(emitKicadNetlist(netlist(), { date: DATE })).not.toContain("(pinfunction");
  });
});

describe("validateNetlist", () => {
  test("passes a well-formed netlist", () => {
    expect(validateNetlist(netlist())).toEqual([]);
  });

  test("rejects a duplicate reference designator", () => {
    const bad = netlist({
      components: [
        { ref: "R1", value: "1k", footprint: "f" },
        { ref: "R1", value: "2k", footprint: "f" },
      ],
      nets: [],
    });
    expect(validateNetlist(bad).filter((d) => d.code === "duplicate_ref")).toHaveLength(1);
  });

  test("rejects a component with no reference", () => {
    const bad = netlist({ components: [{ ref: "", value: "1k", footprint: "f" }], nets: [] });
    const codes = validateNetlist(bad).map((d) => d.code);
    expect(codes).toContain("missing_ref");
  });

  test("rejects a net referencing an unknown component", () => {
    const bad = netlist({
      nets: [
        {
          name: "GND",
          nodes: [
            { ref: "R9", pin: "1" },
            { ref: "R1", pin: "2" },
          ],
        },
      ],
    });
    const unknown = validateNetlist(bad).filter((d) => d.code === "unknown_ref");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe("error");
  });

  test("rejects a duplicate net name", () => {
    const bad = netlist({
      nets: [
        {
          name: "GND",
          nodes: [
            { ref: "R1", pin: "2" },
            { ref: "D1", pin: "2" },
          ],
        },
        {
          name: "GND",
          nodes: [
            { ref: "R1", pin: "1" },
            { ref: "D1", pin: "1" },
          ],
        },
      ],
    });
    expect(validateNetlist(bad).filter((d) => d.code === "duplicate_net")).toHaveLength(1);
  });

  test("requires no-connect declarations to be unique, known, and absent from nets", () => {
    const bad = netlist({
      noConnects: [
        { ref: "R1", pin: "1" },
        { ref: "R1", pin: "1" },
        { ref: "U99", pin: "3" },
      ],
    });
    const codes = validateNetlist(bad).map((diagnostic) => diagnostic.code);
    expect(codes).toContain("connected_no_connect");
    expect(codes).toContain("duplicate_no_connect");
    expect(codes).toContain("unknown_no_connect_ref");
  });

  test("rejects one component pin assigned to different nets", () => {
    const bad = netlist({
      nets: [
        { name: "A", nodes: [{ ref: "R1", pin: "1" }] },
        { name: "B", nodes: [{ ref: "R1", pin: "1" }] },
      ],
    });
    expect(validateNetlist(bad).map((diagnostic) => diagnostic.code)).toContain("pin_in_multiple_nets");
  });

  test("a missing footprint is a warning, not an error", () => {
    const d = validateNetlist(netlist({ components: [{ ref: "R1", value: "1k", footprint: "" }], nets: [] }));
    const fp = d.filter((x) => x.code === "missing_footprint");
    expect(fp).toHaveLength(1);
    expect(fp[0]!.severity).toBe("warning");
  });

  test("a net that connects nothing is a warning", () => {
    const d = validateNetlist(netlist({ nets: [{ name: "GND", nodes: [{ ref: "R1", pin: "2" }] }] }));
    const single = d.filter((x) => x.code === "single_node_net");
    expect(single).toHaveLength(1);
    expect(single[0]!.severity).toBe("warning");
  });
});
