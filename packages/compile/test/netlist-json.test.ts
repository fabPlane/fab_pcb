/** The JSON frontend is pure: files in, IR or diagnostics out. */
import { describe, expect, test } from "bun:test";
import { NETLIST_JSON_ENTRYPOINT, NETLIST_JSON_KIND, checkNetlistJson, netlistJsonFrontend } from "../src/frontends/netlist-json";
import type { CompileSource } from "../src/types";

const GOOD = {
  netlist: {
    components: [
      { ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" },
      { ref: "D1", value: "RED", footprint: "LED_SMD:LED_0603_1608Metric", fields: { MPN: "x" } },
    ],
    nets: [
      {
        name: "N1",
        nodes: [
          { ref: "R1", pin: "2" },
          { ref: "D1", pin: "1" },
        ],
      },
    ],
  },
  board: { widthMm: 20, heightMm: 10 },
};

function source(text: string, entrypoint = NETLIST_JSON_ENTRYPOINT): CompileSource {
  return { kind: NETLIST_JSON_KIND, files: { [entrypoint]: text }, entrypoint };
}

describe("netlistJsonFrontend", () => {
  test("hands a well-formed file over as IR plus board spec", async () => {
    const res = await netlistJsonFrontend.build(source(JSON.stringify(GOOD)));
    expect(res.diagnostics).toEqual([]);
    expect(res.netlist?.components.map((c) => c.ref)).toEqual(["R1", "D1"]);
    expect(res.board).toEqual({ widthMm: 20, heightMm: 10 });
  });

  test("a missing entrypoint is an error naming the file", async () => {
    const res = await netlistJsonFrontend.build({ kind: NETLIST_JSON_KIND, files: {}, entrypoint: "x.json" });
    expect(res.netlist).toBeNull();
    expect(res.diagnostics[0]).toMatchObject({ code: "missing_entrypoint", file: "x.json" });
  });

  test("a JSON syntax error is reported against the file", async () => {
    const res = await netlistJsonFrontend.build(source("{ nope"));
    expect(res.netlist).toBeNull();
    expect(res.diagnostics[0]!.code).toBe("json_syntax");
    expect(res.diagnostics[0]!.file).toBe(NETLIST_JSON_ENTRYPOINT);
  });

  test("shape problems come back one per field with a JSON pointer", () => {
    const bad = { netlist: { components: [{ ref: 1, value: "1k" }], nets: "no" } };
    const { file, diagnostics } = checkNetlistJson(bad, "f.json");
    expect(file).toBeNull();
    const messages = diagnostics.map((d) => d.message);
    expect(messages).toContain("/netlist/components/0/ref: must be a string");
    expect(messages).toContain("/netlist/components/0/footprint: is required");
    expect(messages).toContain("/netlist/nets: must be an array");
  });

  test("board is optional and outline points are checked", () => {
    const { diagnostics } = checkNetlistJson({ netlist: { components: [], nets: [] }, board: { outline: [{ x: "1", y: 2 }] } }, "f.json");
    expect(diagnostics.map((d) => d.message)).toEqual(["/board/outline/0/x: must be a finite number"]);
  });
});
