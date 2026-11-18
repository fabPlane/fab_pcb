import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ErcErrorType, ErcMarkerSchema, RuleSeverity, SchematicPinOrientation } from "@fp-pcb/proto";
import { toVector2 } from "@fp-pcb/client";
import { powerPinDiagnostic, ercDiagnostics } from "../src/power-diagnostic";
import type { PlacedPin } from "../src/schematic";
import type { Netlist } from "../src/types";

const pin = (number: string, x: number, name = "VCC", ref = "U1"): PlacedPin => ({
  ref, number, name, sourceRef: ref, position: { x, y: 0 }, orientation: SchematicPinOrientation.SPO_LEFT,
});
const pins = (...values: PlacedPin[]) => new Map(values.map((p) => [`${p.ref}:${p.number}`, [p]]));
const marker = (x: number, extra = {}) => create(ErcMarkerSchema, {
  errorType: ErcErrorType.ERCET_POWERPIN_NOT_DRIVEN, severity: RuleSeverity.RS_ERROR,
  position: toVector2({ x, y: 0 }), description: "power failure", ...extra,
});
const netlist = (numbers: string[] = [], extraRefs: string[] = []): Netlist => ({
  components: ["U1", ...extraRefs].map((ref) => ({ ref, value: "", footprint: "" })),
  nets: numbers.length ? [{ name: "GND", nodes: numbers.map((pin) => ({ ref: "U1", pin })) }] : [],
});
const flags = (ref = "#FLG01") => `If they really are supplied (a connector, or a part whose output pin is passive), add one PWR_FLAG per net:\n{"ref":"${ref}","value":"PWR_FLAG","footprint":"","libSource":{"lib":"power","part":"PWR_FLAG"}} and net node {"ref":"${ref}","pin":"1"}\nIf nothing supplies them, fix the circuit instead.`;

test("net pin and two pins on the same net produce one net and exact help", () => {
  const result = powerPinDiagnostic(netlist(["1", "2"]), pins(pin("1", 10), pin("2", 20)), [marker(10), marker(20)]);
  expect(result.diagnostic).toEqual({ severity: "error", stage: "schematic", code: "power_pin_not_driven", message: `Nets GND have power-input pins but nothing KiCad counts as a power source.\n${flags()}` });
  expect(result.unexplained).toEqual([]);
});
test("unconnected pin has connect advice only", () => {
  expect(powerPinDiagnostic(netlist(), pins(pin("8", 10)), [marker(10)]).diagnostic?.message).toBe("U1 pin 8 (VCC) is a power input on no net; connect it.");
});
test("both, with the first available flag reference", () => {
  expect(powerPinDiagnostic(netlist(["1"], ["#FLG01"]), pins(pin("1", 10), pin("8", 20)), [marker(10), marker(20)]).diagnostic?.message).toBe(`U1 pin 8 (VCC) is a power input on no net; connect it.\nNets GND have power-input pins but nothing KiCad counts as a power source.\n${flags("#FLG02")}`);
});
test("same named pins in separate unit frames do not hide an unconnected twin", () => {
  expect(powerPinDiagnostic(netlist(["2"]), pins(pin("2", 10, "V+"), pin("15", 20, "V+")), [marker(20)]).diagnostic?.message).toBe("U1 pin 15 (V+) is a power input on no net; connect it.");
});
test("stacked pins prefer any connected pin", () => {
  expect(powerPinDiagnostic(netlist(["2"]), pins(pin("1", 10), pin("2", 10)), [marker(10)]).diagnostic?.message).toStartWith("Nets GND have");
});
test("pins and nets are capped independently at eight", () => {
  const values = Array.from({ length: 20 }, (_, i) => pin(String(i), i));
  const nl = netlist();
  nl.nets = values.slice(10).map((p) => ({ name: `N${p.number}`, nodes: [{ ref: p.ref, pin: p.number }] }));
  const text = powerPinDiagnostic(nl, pins(...values), values.map((p) => marker(p.position.x))).diagnostic!.message;
  expect(text.match(/\+2 more/g)).toHaveLength(2);
  expect(text).toContain("are power inputs on no net; connect them.");
  expect(text).not.toContain("pin 8 (");
  expect(text).not.toContain("N18");
});
test("normalized references use the author's reference", () => {
  const p = { ...pin("1", 10, "VCC", "#PWR1"), sourceRef: "PWR_A" };
  expect(powerPinDiagnostic(netlist(), pins(p), [marker(10)]).diagnostic?.message).toStartWith("PWR_A pin 1 (VCC)");
});
test("unmatched markers remain errors; warnings and exclusions are ignored", () => {
  const unknown = marker(99);
  const warning = marker(10, { severity: RuleSeverity.RS_WARNING });
  const excluded = marker(10, { excluded: true });
  const other = marker(10, { errorType: ErcErrorType.ERCET_PIN_NOT_CONNECTED, description: "other error" });
  const result = powerPinDiagnostic(netlist(), pins(pin("1", 10)), [unknown, warning, excluded, other]);
  expect(result.diagnostic).toBeUndefined();
  expect(result.unexplained).toEqual([unknown, other]);
  expect(ercDiagnostics(netlist(), pins(pin("1", 10)), [unknown, warning, excluded, other], 2)).toEqual([{
    severity: "error", stage: "schematic", code: "erc_errors", message: "Generated schematic has 2 ERC error(s) after save/reload: power failure; other error",
  }]);
  expect(ercDiagnostics(netlist(), pins(pin("1", 10)), [marker(10), warning], 1).map((d) => d.code)).toEqual(["power_pin_not_driven"]);
});

test("explained power failures leave other errors in erc_errors, with warnings outside the cap", () => {
  const errors = Array.from({ length: 11 }, (_, i) => marker(99, {
    errorType: ErcErrorType.ERCET_PIN_NOT_CONNECTED, description: `other ${i}`,
  }));
  const diagnostics = ercDiagnostics(netlist(), pins(pin("1", 10)), [
    marker(10, { severity: RuleSeverity.RS_WARNING, description: "library warning" }),
    ...errors, marker(10),
  ], 12);
  expect(diagnostics.map((d) => d.code)).toEqual(["power_pin_not_driven", "erc_errors"]);
  expect(diagnostics[1]!.message).toBe(`Generated schematic has 11 ERC error(s) after save/reload: ${errors.slice(0, 10).map((e) => e.description).join("; ")}`);
});

test("nonzero ERC count still rejects when markers are missing or filtered out", () => {
  for (const markers of [[], [marker(10, { severity: RuleSeverity.RS_WARNING })], [marker(10, { excluded: true })]]) {
    expect(ercDiagnostics(netlist(), pins(pin("1", 10)), markers, 2)).toEqual([{
      severity: "error", stage: "schematic", code: "erc_errors",
      message: "Generated schematic has 2 ERC error(s) after save/reload.",
    }]);
  }
  expect(ercDiagnostics(netlist(), pins(pin("1", 10)), [], 0)).toEqual([]);
});

test("only duplicate pin-not-connected errors at on-no-net positions are explained, in either order", () => {
  const power = marker(10);
  const duplicate = marker(10, { errorType: ErcErrorType.ERCET_PIN_NOT_CONNECTED, description: "arbitrary wording" });
  const elsewhere = marker(20, { errorType: ErcErrorType.ERCET_PIN_NOT_CONNECTED, description: "Pin not connected" });
  const label = marker(10, { errorType: ErcErrorType.ERCET_LABEL_NOT_CONNECTED, description: "Label not connected" });
  for (const markers of [[duplicate, power, elsewhere, label], [power, duplicate, elsewhere, label]]) {
    const result = powerPinDiagnostic(netlist(), pins(pin("8", 10), pin("1", 20)), markers);
    expect(result.unexplained).toEqual([elsewhere, label]);
    expect(ercDiagnostics(netlist(), pins(pin("8", 10), pin("1", 20)), markers, 4)).toEqual([
      { severity: "error", stage: "schematic", code: "power_pin_not_driven", message: "U1 pin 8 (VCC) is a power input on no net; connect it." },
      { severity: "error", stage: "schematic", code: "erc_errors", message: "Generated schematic has 2 ERC error(s) after save/reload: Pin not connected; Label not connected" },
    ]);
    expect(ercDiagnostics(netlist(), pins(pin("8", 10)), [duplicate, power], 2).map((d) => d.code)).toEqual(["power_pin_not_driven"]);
  }
});

test("pin-not-connected at a net-level power failure remains unexplained", () => {
  const other = marker(10, { errorType: ErcErrorType.ERCET_PIN_NOT_CONNECTED });
  expect(powerPinDiagnostic(netlist(["8"]), pins(pin("8", 10)), [marker(10), other]).unexplained).toEqual([other]);
});
