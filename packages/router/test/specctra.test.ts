/** DSN writer, SES reader and the s-expression helpers, on the synthetic two-net board. */
import { describe, expect, test } from "bun:test";
import { BoardLayer } from "@fp-pcb/proto";
import { mm } from "@fp-pcb/client";
import { parseSExpr, quote, child, children, head } from "../src/specctra/sexpr";
import { writeDsn, viaPadstackName } from "../src/specctra/dsn";
import { parseSes, sesToItems, resolutionToNm } from "../src/specctra/ses";
import { twoNetBoard, F, B } from "./fixtures";

describe("sexpr", () => {
  test("parses nested lists, quoted strings and comments", () => {
    const tree = parseSExpr(`(a b "c d" (e 1 -2.5) ; not a comment\n)`);
    expect(tree).toEqual([["a", "b", "c d", ["e", "1", "-2.5"], ";", "not", "a", "comment"]]);
    expect(() => parseSExpr("(a (b)")).toThrow(SyntaxError);
    expect(() => parseSExpr("a)")).toThrow(SyntaxError);
  });
  test("quote() only quotes what the Specctra tokenizer would split", () => {
    expect(quote("GND")).toBe("GND");
    expect(quote("Net-(R1-Pad1)")).toBe('"Net-(R1-Pad1)"');
    expect(quote("a b")).toBe('"a b"');
    expect(quote("")).toBe('""');
  });
});

describe("writeDsn", () => {
  const input = twoNetBoard();
  const dsn = writeDsn(input);
  const tree = parseSExpr(dsn);
  const pcb = tree[0] as unknown[];

  test("is a well-formed (pcb ...) with parser, resolution, structure, placement, library, network, wiring", () => {
    expect(head(pcb as never)).toBe("pcb");
    for (const section of ["parser", "resolution", "structure", "placement", "library", "network", "wiring"]) {
      expect(child(pcb as never, section), section).toBeDefined();
    }
    expect(child(pcb as never, "resolution")).toEqual(["resolution", "um", "10"]);
  });

  test("structure: layers by user name, boundary in µm with y up, rules from the default class", () => {
    const structure = child(pcb as never, "structure")!;
    expect(children(structure, "layer").map((l) => l[1])).toEqual(["F.Cu", "B.Cu"]);
    const boundary = child(structure, "boundary")!;
    const path = child(boundary, "path")!;
    // (path pcb 0 x y ...) — 4 corners; (30 mm, 30 mm) -> 30000 -30000
    expect(path.slice(1, 3)).toEqual(["pcb", "0"]);
    expect(path).toContain("30000");
    expect(path).toContain("-30000");
    const rule = child(structure, "rule")!;
    expect(child(rule, "width")).toEqual(["width", "250"]);
    expect(child(rule, "clearance")).toEqual(["clearance", "200"]);
    expect(child(structure, "via")).toEqual(["via", viaPadstackName(mm(0.8), mm(0.4), 2)]);
    expect(viaPadstackName(mm(0.8), mm(0.4), 2)).toBe("Via[0-1]_800:400_um");
  });

  test("one component per pad, pins referenced as <component>-1 without hyphens in the component name", () => {
    const placement = child(pcb as never, "placement")!;
    const places = children(placement, "component").flatMap((c) => children(c, "place"));
    expect(places.length).toBe(5);
    const refs = places.map((p) => p[1] as string);
    expect(refs).toContain("R1_1");
    for (const r of refs) expect(r).not.toContain("-");
    const network = child(pcb as never, "network")!;
    const nets = children(network, "net");
    expect(nets.map((n) => n[1]).sort()).toEqual(["A", "B"]);
    const a = nets.find((n) => n[1] === "A")!;
    expect(child(a, "pins")).toEqual(["pins", "R1_1-1", "R2_1-1"]);
    // the unconnected middle pad is placed but in no net
    expect(dsn).toContain("J1_1");
    expect(children(network, "class").length).toBe(1);
  });

  test("padstacks: circle for round pads on both layers, rect for the square pad", () => {
    const library = child(pcb as never, "library")!;
    const stacks = children(library, "padstack").map((p) => p[1] as string);
    expect(stacks).toContain("Round[A]Pad_1600_um");
    expect(stacks).toContain("Rect[A]Pad_3000x3000_um");
    expect(stacks).toContain("Via[0-1]_800:400_um");
    const round = children(library, "padstack").find((p) => p[1] === "Round[A]Pad_1600_um")!;
    expect(children(round, "shape").length).toBe(2);
    expect(dsn).toContain("(circle F.Cu 1600)");
    expect(dsn).toContain("(rect F.Cu -1500 -1500 1500 1500)");
  });

  test("existing copper is exported as protected wiring; layer filter drops other layers", () => {
    const withCopper = twoNetBoard();
    withCopper.tracks.push({
      id: "t",
      net: "A",
      netCode: 1,
      start: { x: mm(1), y: mm(1) },
      end: { x: mm(2), y: mm(1) },
      width: mm(0.3),
      layer: B,
    });
    withCopper.vias.push({
      id: "v",
      net: "A",
      netCode: 1,
      position: { x: mm(2), y: mm(2) },
      diameter: mm(0.8),
      drill: mm(0.4),
      layers: [F, B],
    });
    const text = writeDsn(withCopper);
    expect(text).toContain("(wire (path B.Cu 300 1000 -1000 2000 -1000) (net A) (type protect))");
    expect(text).toContain("(via Via[0-1]_800:400_um 2000 -2000 (net A) (type protect))");
    const front = writeDsn(withCopper, { layers: [F] });
    expect(front).not.toContain("B.Cu");
    expect(front).toContain("Via[0-0]_800:400_um");
  });

  test("zones become planes, rule areas keepouts, copper graphics keepout rects", () => {
    const z = twoNetBoard();
    z.zones.push({ id: "z", name: "gnd", net: "A", netCode: 1, layers: [B], polygon: z.outline[0]!, fills: [] });
    z.keepouts.push({
      id: "k",
      name: "nokeep",
      layers: [F],
      polygon: [
        { x: 0, y: 0 },
        { x: mm(1), y: 0 },
        { x: mm(1), y: mm(1) },
      ],
      tracks: true,
      vias: true,
      copper: false,
    });
    z.obstacles.push({ id: "g", kind: "text", layers: [F], bounds: { x: mm(10), y: mm(10), w: mm(2), h: mm(1) }, net: "" });
    const text = writeDsn(z);
    expect(text).toContain("(plane A (polygon B.Cu 0 ");
    expect(text).toContain("(keepout nokeep (polygon F.Cu 0 ");
    expect(text).toContain("(keepout text-g (rect F.Cu 10000 -11000 12000 -10000))");
  });
});

const SES = `(session "board.ses"
  (base_design "board.dsn")
  (placement
    (resolution um 10)
    (component "Round[A]Pad_1600_um" (place "R1_1" 50000 -50000 front 0))
  )
  (was_is)
  (routes
    (resolution um 10)
    (parser (host_cad "KiCad's Pcbnew") (host_version "9.0.0"))
    (library_out
      (padstack "Via[0-1]_800:400_um" (shape (circle F.Cu 8000 0 0)) (shape (circle B.Cu 8000 0 0)) (attach off))
    )
    (network_out
      (net A
        (wire (path F.Cu 2500 50000 -50000 100000 -50000 100000 -100000))
        (via "Via[0-1]_800:400_um" 100000 -100000)
        (wire (path B.Cu 2500 100000 -100000 250000 -250000))
        (wire (polygon B.Cu 0 0 0 10 0 10 10))
      )
      (net "Net-(R3-Pad1)"
        (wire (path In1.Cu 2500 0 0 10000 0))
      )
    )
  )
)`;

describe("parseSes / sesToItems", () => {
  test("resolution: (resolution um 10) is 100 nm per unit", () => {
    expect(resolutionToNm(["resolution", "um", "10"])).toBe(100);
    expect(resolutionToNm(["resolution", "mil", "100"])).toBe(254);
    expect(resolutionToNm(undefined)).toBe(1000);
  });

  test("wires, vias and padstacks in nm with y flipped back down", () => {
    const s = parseSes(SES);
    expect(s.nmPerUnit).toBe(100);
    expect(s.nets).toEqual(["A", "Net-(R3-Pad1)"]);
    expect(s.wires.length).toBe(3); // the plane polygon echo is skipped
    expect(s.wires[0]).toEqual({
      net: "A",
      layer: "F.Cu",
      width: 250_000,
      points: [
        { x: 5_000_000, y: 5_000_000 },
        { x: 10_000_000, y: 5_000_000 },
        { x: 10_000_000, y: 10_000_000 },
      ],
    });
    expect(s.vias).toEqual([{ net: "A", padstack: "Via[0-1]_800:400_um", x: 10_000_000, y: 10_000_000 }]);
    expect(s.padstacks.get("Via[0-1]_800:400_um")).toEqual({ name: "Via[0-1]_800:400_um", layers: ["F.Cu", "B.Cu"], diameter: 800_000 });
    expect(s.placements[0]).toEqual({
      component: "Round[A]Pad_1600_um",
      reference: "R1_1",
      x: 5_000_000,
      y: 5_000_000,
      side: "front",
      rotation: 0,
    });
  });

  test("sesToItems: the session's echo of the board's existing tracks and vias is not created again", () => {
    const input = twoNetBoard();
    // net A's first segment already exists on the board (10 µm off, as KiCad's export/import rounding leaves it)
    input.tracks.push({
      id: "t-a",
      net: "A",
      netCode: 1,
      start: { x: 5_000_000, y: 5_005_000 },
      end: { x: 10_000_000, y: 5_000_000 },
      width: 250_000,
      layer: BoardLayer.BL_F_Cu,
    });
    const items = sesToItems(parseSes(SES), input);
    expect(items.tracks.length).toBe(2);
    expect(items.tracks.find((t) => t.start.x === 5_000_000 && t.end.x === 10_000_000)).toBeUndefined();
    expect(items.echoed).toEqual({ tracks: 1, vias: 0 });
    expect(items.warnings.some((w) => /1 existing track\(s\)/.test(w))).toBe(true);
    // the same net's other segments still count it as routed
    expect(items.routedNets.has("A")).toBe(true);
  });

  test("sesToItems: tracks per polyline segment, vias sized from the padstack, unknown layers warned and skipped", () => {
    const items = sesToItems(parseSes(SES), twoNetBoard());
    expect(items.tracks.length).toBe(3);
    expect(items.tracks[0]).toEqual({
      net: "A",
      netCode: 1,
      start: { x: 5_000_000, y: 5_000_000 },
      end: { x: 10_000_000, y: 5_000_000 },
      width: 250_000,
      layer: BoardLayer.BL_F_Cu,
    });
    expect(items.tracks[2]!.layer).toBe(BoardLayer.BL_B_Cu);
    expect(items.vias).toEqual([
      {
        net: "A",
        netCode: 1,
        position: { x: 10_000_000, y: 10_000_000 },
        diameter: 800_000,
        drill: 400_000,
        layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
      },
    ]);
    expect(items.warnings).toEqual(['unknown layer "In1.Cu"']);
    expect([...items.routedNets]).toEqual(["A"]);
  });

  test("rejects text that is not a session", () => {
    expect(() => parseSes("(pcb x)")).toThrow(SyntaxError);
  });
});
