import { test, expect } from "bun:test";
import { twoNetBoard } from "./fixtures";
import { applyRequestRules } from "../src/request-rules";
import { rulesForNet } from "../src/extract";
import { writeDsn } from "../src/specctra/dsn";
import { overlayDsnRules } from "../src/specctra/rule-overlay";
import { parseSExpr, child, children } from "../src/specctra/sexpr";

test("explicit precedence, clamp reporting, widths and vias reach builtin DSN", () => {
  const input = twoNetBoard();
  const logs = applyRequestRules(input, {
    trackWidthMm: 0.3,
    perNet: [{ net: "A", widthMm: 0.15, viaDiameterMm: 0.6, viaDrillMm: 0.3 }],
    differentialPairs: [{ p: "A", n: "B", gapMm: 0.25 }],
  });
  expect(rulesForNet(input, "A").trackWidth).toBe(150000);
  expect(rulesForNet(input, "B").trackWidth).toBe(300000);
  expect(writeDsn(input)).toContain("(width 150)");
  expect(writeDsn(input)).toContain("600:300_um");
  expect(logs.join("\n")).toContain("declared request metadata");
  expect(applyRequestRules(twoNetBoard(), { perNet: [{ net: "A", widthMm: 0.01 }] }).join("\n")).toContain("board minimum");
});
test("unknown, overlapping and contradictory declarations fail before routing", () => {
  expect(() => applyRequestRules(twoNetBoard(), { perNet: [{ net: "missing", widthMm: 0.3 }] })).toThrow("missing");
  expect(() => applyRequestRules(twoNetBoard(), { differentialPairs: [{ p: "A", n: "A" }] })).toThrow("pair");
  expect(() =>
    applyRequestRules(twoNetBoard(), { perNet: [{ net: "A", widthMm: 0.15 }], differentialPairs: [{ p: "A", n: "B", widthMm: 0.2 }] }),
  ).toThrow("conflicting");
});
test("KiCad-export DSN overlay preserves pins/copper and replaces class membership", () => {
  const input = twoNetBoard(),
    original = writeDsn(input);
  applyRequestRules(input, { perNet: [{ net: "A", widthMm: 0.3, viaDiameterMm: 0.7, viaDrillMm: 0.35 }] });
  const tree = parseSExpr(overlayDsnRules(original, input))[0] as import("../src/specctra/sexpr").SExpr[];
  const before = parseSExpr(original)[0] as import("../src/specctra/sexpr").SExpr[];
  expect(children(child(tree, "network"), "net")).toEqual(children(child(before, "network"), "net"));
  expect(child(tree, "wiring")).toEqual(child(before, "wiring"));
  expect(child(tree, "placement")).toEqual(child(before, "placement"));
  expect(overlayDsnRules(original, input)).toContain("(width 300)");
  expect(children(child(tree, "network"), "class").filter((c) => c.slice(2).includes("A"))).toHaveLength(1);
});
