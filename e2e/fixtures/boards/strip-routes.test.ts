/**
 * strip-routes.ts: the "placed but unrouted" variant keeps everything except routing.
 *   bun test e2e/fixtures/boards        (not part of `bun run test:unit`, which skips e2e/)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stripRoutes } from "./strip-routes";

const SAMPLE = `(kicad_pcb
\t(version 20240108)
\t(general (thickness 1.6))
\t(net 0 "")
\t(net 1 "GND")
\t(footprint "Lib:R" (layer "F.Cu") (at 10 10)
\t\t(fp_line (start 0 0) (end 1 1) (layer "F.SilkS"))
\t\t(pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "GND"))
\t)
\t(gr_arc (start 0 0) (mid 1 1) (end 2 0) (layer "Edge.Cuts"))
\t(segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 1))
\t(arc (start 20 10) (mid 21 11) (end 22 10) (width 0.25) (layer "F.Cu") (net 1))
\t(via (at 22 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
\t(segment (start 22 10) (end 30 10) (width 0.25) (layer "B.Cu") (net 1) (tstamp "a \\"quoted) paren\\""))
\t(zone (net 1) (net_name "GND") (layer "B.Cu") (name "gnd")
\t\t(connect_pads (clearance 0.5))
\t\t(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
\t\t(polygon (pts (xy 0 0) (xy 40 0) (arc (start 40 30) (mid 20 35) (end 0 30)) (xy 0 30)))
\t\t(filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 39 1) (xy 39 29) (xy 1 29)))
\t\t(fill_segments (layer "B.Cu") (pts (xy 1 1) (xy 2 2)))
\t)
)
`;

describe("strip-routes", () => {
  test("removes segments, track arcs, vias and zone fills; keeps outlines, footprints and graphics", () => {
    const { text, removed } = stripRoutes(SAMPLE);
    expect(removed).toEqual({ segment: 2, arc: 1, via: 1, filled_polygon: 1, fill_segments: 1 });
    expect(text).not.toMatch(/\(segment|\(via|\(filled_polygon|\(fill_segments/);
    expect(text).not.toMatch(/\(arc \(start 20 10\)/); // the track arc
    expect(text).toMatch(/\(gr_arc /); // board graphics stay
    expect(text).toMatch(/\(polygon \(pts \(xy 0 0\) \(xy 40 0\) \(arc \(start 40 30\)/); // the zone outline arc stays
    expect(text).toMatch(/\(fill yes/); // fill settings stay so RefillZones can fill again
    expect(text).toMatch(/\(pad "1" thru_hole/);
    expect(text).toMatch(/\(fp_line/);
    // structure intact and byte-deterministic
    expect(() => parse(text)).not.toThrow();
    expect(stripRoutes(text).text).toBe(text);
    expect(stripRoutes(SAMPLE).text).toBe(text);
  });

  test("leaves a board without routing untouched", () => {
    const { text } = stripRoutes(SAMPLE);
    const again = stripRoutes(text);
    expect(again.removed).toEqual({});
    expect(again.text).toBe(text);
  });

  test("parser respects quoted strings and reports unbalanced input", () => {
    const root = parse('(a "b ) (" (c))');
    expect(root.children[0]!.children.map((n) => n.head)).toEqual(["c"]);
    expect(() => parse("(a (b)")).toThrow(/unbalanced/);
  });

  test("checked-in variants are up to date with their boards", () => {
    const dir = import.meta.dir;
    for (const [d, name] of [
      ["ecc83", "ecc83-pp"],
      ["ecc83", "ecc83-pp_v2"],
      ["sonde_xilinx", "sonde xilinx"],
      ["interf_u", "interf_u"],
      ["pic_programmer", "pic_programmer"],
      ["stickhub", "StickHub"],
    ]) {
      const src = readFileSync(join(dir, d!, `${name}.kicad_pcb`), "utf8");
      const variant = readFileSync(join(dir, d!, `${name}.unrouted.kicad_pcb`), "utf8");
      const { text, removed } = stripRoutes(src);
      expect(text).toBe(variant);
      expect(removed.segment ?? 0).toBeGreaterThan(0);
      expect(variant).not.toMatch(/\n\t\(segment|\n\t\(via/);
    }
  });
});
