/** DSN writer, SES reader and the s-expression helpers, on the synthetic two-net board. */
import { describe, expect, test } from "bun:test";
import { BoardLayer } from "@fp-pcb/proto";
import { mm } from "@fp-pcb/client";
import { parseSExpr, quote, child, children, head } from "../src/specctra/sexpr";
import { writeDsn, viaPadstackName, extraViasFromRouteOptions } from "../src/specctra/dsn";
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

  test("extraViasFromRouteOptions reads millimetre leftover-run rules", () => {
    expect(extraViasFromRouteOptions({ viaDiameterMm: 0.36, viaDrillMm: 0.2 })).toEqual([{ diameter: mm(0.36), drill: mm(0.2) }]);
    expect(extraViasFromRouteOptions({ viaDiameterNm: mm(0.5), viaDrillNm: mm(0.2) })).toEqual([{ diameter: mm(0.5), drill: mm(0.2) }]);
    expect(extraViasFromRouteOptions({})).toEqual([]);
  });

  test("existing vias of a non-class size are in the library before wiring names them", () => {
    const withVia = twoNetBoard();
    withVia.vias.push({
      id: "v-small",
      net: "A",
      netCode: 1,
      position: { x: mm(2), y: mm(2) },
      diameter: mm(0.36),
      drill: mm(0.2),
      layers: [F, B],
    });
    const text = writeDsn(withVia);
    const name = viaPadstackName(mm(0.36), mm(0.2), 2);
    expect(name).toBe("Via[0-1]_360:200_um");
    const library = child(parseSExpr(text)[0] as never, "library")!;
    const stacks = children(library, "padstack").map((p) => p[1] as string);
    expect(stacks).toContain(name);
    expect(text).toContain(`(via ${name} `);
  });

  test("extra via sizes and leftover nets round-trip through the DSN library", () => {
    const leftover = twoNetBoard();
    leftover.vias.push({
      id: "v-class",
      net: "A",
      netCode: 1,
      position: { x: mm(3), y: mm(3) },
      diameter: mm(0.8),
      drill: mm(0.4),
      layers: [F, B],
    });
    const text = writeDsn(leftover, {
      extraVias: [{ diameter: mm(0.5), drill: mm(0.2) }],
      routableNets: ["A"],
    });
    const library = child(parseSExpr(text)[0] as never, "library")!;
    const stacks = children(library, "padstack").map((p) => p[1] as string);
    expect(stacks).toContain("Via[0-1]_800:400_um");
    expect(stacks).toContain("Via[0-1]_500:200_um");
    const network = child(parseSExpr(text)[0] as never, "network")!;
    const nets = children(network, "net").map((n) => n[1]);
    expect(nets).toEqual(["A"]);
    expect(text).toContain("R3_1");
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
    // The DSN coordinate quantum is 100 nm; nearby distinct copper is not an echo.
    input.tracks.push({
      id: "t-a",
      net: "A",
      netCode: 1,
      start: { x: 5_000_000, y: 5_000_050 },
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

  test("sesToItems: an existing via whose drill the padstack name rounds to whole micrometres is an echo", () => {
    const via = (id: string, drill: number) => ({
      id,
      net: "A",
      netCode: 1,
      position: { x: 10_000_000, y: 10_000_000 },
      diameter: 800_000,
      drill,
      layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
    });
    // 0.3998 mm is named `400` um, 200 nm away; an imperial drill rounds the same way.
    const rounded = twoNetBoard();
    rounded.vias.push(via("v-rounded", 399_800));
    expect(sesToItems(parseSes(SES), rounded).echoed.vias).toBe(1);
    // A genuinely different drill at the same spot is still not an echo.
    const different = twoNetBoard();
    different.vias.push(via("v-different", 300_000));
    expect(sesToItems(parseSes(SES), different).echoed.vias).toBe(0);
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


function session(resolution: string, placement = false): string {
  return `(session sample
    ${placement ? `(placement (resolution ${resolution}))` : ""}
    (routes ${placement ? "" : `(resolution ${resolution})`}
      (network_out (net A (wire (path F.Cu 2 0 0 10 20))))))`;
}

for (const resolution of ["unknown 10", "toString 10", "um 0", "um -10", "um NaN", "um Infinity", "um 1e-320"]) {
  for (const placement of [false, true]) {
    test(`session resolution rejects ${resolution} in ${placement ? "placement fallback" : "routes"}`, () => {
      expect(() => parseSes(session(resolution, placement))).toThrow(SyntaxError);
    });
  }
}

for (const [unit, scale] of [["um", 100], ["mm", 100000], ["cm", 1000000], ["inch", 2540000], ["mil", 2540]] as const) {
  test(`session resolution preserves ${unit} geometry`, () => {
    const parsed = parseSes(session(`${unit} 10`));
    expect(parsed.nmPerUnit).toBe(scale);
    expect(parsed.wires[0]?.width).toBe(2 * scale);
    expect(parsed.wires[0]?.points).toEqual([{ x: 0, y: -0 }, { x: 10 * scale, y: -20 * scale }]);
  });
}

test("session resolution preserves omitted resolution defaults", () => {
  expect(parseSes("(session sample (routes))").nmPerUnit).toBe(1000);
});

for (const path of [
  "F.Cu 2 0 0 NaN 20", "F.Cu 2 0 0 Infinity 20",
  "F.Cu 2 0 0 1e308 20", "F.Cu NaN 0 0 10 20",
  "F.Cu -2 0 0 10 20", "F.Cu 0 0 0 10 20",
  "F.Cu 2 0 0 10", "F.Cu 2 0 0 (unexpected 10) 20",
  "F.Cu 2 0 0", "F.Cu 0.0001 0 0 10 20",
]) {
  test(`session path rejects malformed geometry: ${path}`, () => {
    expect(() => parseSes(`(session sample (routes (resolution um 10)
      (network_out (net A (wire (path ${path}))))))`)).toThrow(SyntaxError);
  });
}

test("session path retains signed fractional coordinates and positive widths", () => {
  const parsed = parseSes(`(session sample (routes (resolution um 10)
    (network_out (net A (wire (path F.Cu 2.5 -1.5 2.5 3.5 -4.5))))))`);
  expect(parsed.wires[0]).toMatchObject({width: 250, points: [{x: -150, y: -250}, {x: 350, y: 450}]});
});

for (const via of ["V NaN 20", "V 10 Infinity", "V 1e308 20", "V 10", "V (unexpected 10) 20", "(unexpected V) 10 20"]) {
  test(`session via rejects malformed coordinates: ${via}`, () => {
    expect(() => parseSes(`(session sample (routes (resolution um 10)
      (network_out (net A (via ${via})))))`)).toThrow(SyntaxError);
  });
}

test("session via preserves signed fractional coordinates and trailing attributes", () => {
  const parsed = parseSes(`(session sample (routes (resolution um 10)
    (network_out (net A (via V -1.5 2.5 (type normal))))))`);
  expect(parsed.vias).toEqual([{net: "A", padstack: "V", x: -150, y: -250}]);
});

for (const diameter of ["NaN", "Infinity", "1e308", "-2", "0", "0.0001", "(unexpected 2)", ""]) {
  test(`session circle rejects malformed diameter: ${diameter || "missing"}`, () => {
    expect(() => parseSes(`(session sample (routes (resolution um 10)
      (library_out (padstack V (shape (circle F.Cu ${diameter}))))
      (network_out (net A (via V 10 20)))))`)).toThrow(SyntaxError);
  });
}

test("session circle preserves fractional diameters on both copper layers", () => {
  const parsed = parseSes(`(session sample (routes (resolution um 10)
    (library_out (padstack V (shape (circle F.Cu 6000.5)) (shape (circle B.Cu 6000.5))))
    (network_out (net A (via V 10 20)))))`);
  expect(parsed.padstacks.get("V")).toEqual({name: "V", layers: ["F.Cu", "B.Cu"], diameter: 600050});
  expect(sesToItems(parsed, twoNetBoard()).vias[0]?.diameter).toBe(600050);
});

for (const name of ["V_0:300_um", "V_600:0_um", "V_600:600_um", "V_600:700_um", "V_99999999999999999999:300_um", "V_600:99999999999999999999_um"]) {
  test(`session via sizes reject invalid name dimensions: ${name}`, () => {
    const parsed = parseSes(`(session sample (routes (network_out (net A (via ${name} 10 20)))))`);
    expect(() => sesToItems(parsed, twoNetBoard())).toThrow(SyntaxError);
  });
}

test("session via sizes validate explicit circle against name drill", () => {
  const parsed = parseSes(`(session sample (routes
    (library_out (padstack V_800:400_um (shape (circle F.Cu 300))))
    (network_out (net A (via V_800:400_um 10 20)))))`);
  expect(() => sesToItems(parsed, twoNetBoard())).toThrow(SyntaxError);
});

test("session via sizes retain valid name fallback", () => {
  const parsed = parseSes(`(session sample (routes (network_out (net A (via V_600:300_um 10 20)))))`);
  expect(sesToItems(parsed, twoNetBoard()).vias[0]).toMatchObject({diameter: 600000, drill: 300000});
});


describe("session net identity", () => {
  for (const [kind, copper] of [
    ["wire", "(wire (path F.Cu 250 1000 -1000 2000 -1000))"],
    ["via", "(via Via_800:400_um 1000 -1000)"],
  ]) {
    test(`rejects unknown ${kind} net before assigning unconnected copper`, () => {
      const session = parseSes(`(session s (routes (resolution um 1) (network_out (net MISSING ${copper}))))`);
      expect(() => sesToItems(session, twoNetBoard())).toThrow(SyntaxError);
    });
    test(`preserves known ${kind} net code`, () => {
      const input = twoNetBoard();
      const session = parseSes(`(session s (routes (resolution um 1) (network_out (net A ${copper}))))`);
      const items = sesToItems(session, input);
      const item = kind === "wire" ? items.tracks[0]! : items.vias[0]!;
      expect(item.net).toBe("A");
      expect(item.netCode).toBe(input.nets.find(n => n.name === "A")!.code);
    });
  }
});

describe("session via layer identity", () => {
  for (const layers of [["F.Cu", "MISSING"], ["MISSING", "ALSO_MISSING"]]) {
    test(`rejects unknown via layers: ${layers.join(",")}`, () => {
      const shapes = layers.map(layer => `(shape (circle ${layer} 800))`).join(" ");
      const session = parseSes(`(session s (routes (library_out (padstack V ${shapes}))
        (network_out (net A (via V 1000 -1000)))))`);
      expect(() => sesToItems(session, twoNetBoard())).toThrow(SyntaxError);
    });
  }
  test("preserves supported via layer aliases", () => {
    const session = parseSes(`(session s (routes (library_out (padstack V
      (shape (circle BL_F_Cu 800)) (shape (circle BL_B_Cu 800))))
      (network_out (net A (via V 1000 -1000)))))`);
    expect(sesToItems(session, twoNetBoard()).vias[0]!.layers).toEqual(twoNetBoard().copperLayers.map(l => l.id));
  });
  test("retains absent padstack through via fallback", () => {
    const session = parseSes(`(session s (routes (network_out (net A (via V 1000 -1000)))))`);
    expect(sesToItems(session, twoNetBoard()).vias[0]!.layers).toEqual(twoNetBoard().copperLayers.map(l => l.id));
  });
});

describe("session via distinct layer span", () => {
  for (const layers of [["F.Cu"], ["F.Cu", "F.Cu"], ["F.Cu", "BL_F_Cu"]]) {
    test(`rejects one distinct via layer: ${layers.join(",")}`, () => {
      const shapes = layers.map(layer => `(shape (circle ${layer} 800))`).join(" ");
      const session = parseSes(`(session s (routes (library_out (padstack V ${shapes}))
        (network_out (net A (via V 1000 -1000)))))`);
      expect(() => sesToItems(session, twoNetBoard())).toThrow(SyntaxError);
    });
  }
  test("normalizes repeated aliases in a valid via span", () => {
    const session = parseSes(`(session s (routes (library_out (padstack V
      (shape (circle F.Cu 800)) (shape (circle BL_F_Cu 800)) (shape (circle B.Cu 800))))
      (network_out (net A (via V 1000 -1000)))))`);
    expect(sesToItems(session, twoNetBoard()).vias[0]!.layers).toEqual(twoNetBoard().copperLayers.map(l => l.id));
  });
  test("retains via fallback when layer metadata is absent", () => {
    const session = parseSes(`(session s (routes (network_out (net A (via V 1000 -1000)))))`);
    expect(sesToItems(session, twoNetBoard()).vias[0]!.layers).toEqual(twoNetBoard().copperLayers.map(l => l.id));
  });
});

describe("session via layer diameters", () => {
  for (const diameters of [[600, 800], [800, 600]]) {
    test(`rejects nonuniform session via layer diameters ${diameters.join("/")}`, () => {
      const session = `(session s (routes (library_out (padstack V
        (shape (circle F.Cu ${diameters[0]})) (shape (circle B.Cu ${diameters[1]}))))
        (network_out (net A (via V 1000 -1000)))))`;
      expect(() => sesToItems(parseSes(session), twoNetBoard())).toThrow(SyntaxError);
    });
  }
  for (const diameter of [600, 800]) {
    test(`preserves uniform session via layer diameter ${diameter}`, () => {
      const session = parseSes(`(session s (routes (library_out (padstack V
        (shape (circle F.Cu ${diameter})) (shape (circle B.Cu ${diameter}))))
        (network_out (net A (via V 1000 -1000)))))`);
      expect(sesToItems(session, twoNetBoard()).vias[0]!.diameter).toBe(diameter * 1000);
    });
  }
});


describe("session via shape representability", () => {
  for (const shapes of [
    "(shape (rect F.Cu -400 -300 400 300)) (shape (rect B.Cu -400 -300 400 300))",
    "(shape (circle F.Cu 800)) (shape (rect B.Cu -400 -300 400 300))",
    "(shape (polygon F.Cu 0 -400 -300 400 -300 400 300)) (shape (circle B.Cu 800))",
  ]) {
    test(`rejects unrepresentable session via shape ${shapes}`, () => {
      const session = `(session s (routes (library_out (padstack V_800:300_um ${shapes}))
        (network_out (net A (via V_800:300_um 1000 -1000)))))`;
      expect(() => sesToItems(parseSes(session), twoNetBoard())).toThrow(SyntaxError);
    });
  }
  test("preserves representable circular session via shapes", () => {
    const session = parseSes(`(session s (routes (library_out (padstack V_800:300_um
      (shape (circle F.Cu 800)) (shape (circle B.Cu 800))))
      (network_out (net A (via V_800:300_um 1000 -1000)))))`);
    const via = sesToItems(session, twoNetBoard()).vias[0]!;
    expect(via.diameter).toBe(800000);
    expect(via.drill).toBe(300000);
  });
  test("preserves missing session via shape fallback", () => {
    const session = parseSes(`(session s (routes
      (network_out (net A (via V_800:300_um 1000 -1000)))))`);
    const via = sesToItems(session, twoNetBoard()).vias[0]!;
    expect(via.diameter).toBe(800000);
    expect(via.drill).toBe(300000);
  });
});

describe("session via circle centers", () => {
  for (const center of ["100 0", "0 -100", "100", "NaN 0", "0 (bad)"]) {
    test(`rejects unsupported session circle center ${center}`, () => {
      const session = `(session s (routes (library_out (padstack V
        (shape (circle F.Cu 800 ${center})) (shape (circle B.Cu 800))))
        (network_out (net A (via V 1000 -1000)))))`;
      expect(() => sesToItems(parseSes(session), twoNetBoard())).toThrow(SyntaxError);
    });
  }
  for (const center of ["", "0 0"]) {
    test(`preserves concentric session circle center '${center}'`, () => {
      const session = parseSes(`(session s (routes (library_out (padstack V
        (shape (circle F.Cu 800 ${center})) (shape (circle B.Cu 800 ${center}))))
        (network_out (net A (via V 1000 -1000)))))`);
      const via = sesToItems(session, twoNetBoard()).vias[0]!;
      expect(via.position).toEqual({ x: 1000000, y: 1000000 });
      expect(via.diameter).toBe(800000);
    });
  }
});

describe("session circle layer operands", () => {
  for (const shapes of [
    "(shape (circle (F.Cu) 800)) (shape (circle (B.Cu) 800))",
    "(shape (circle F.Cu 800)) (shape (circle B.Cu 800)) (shape (circle (In1.Cu) 800))",
  ]) {
    test(`rejects nested circle layer operands ${shapes}`, () => {
      const session = `(session s (routes (library_out (padstack V_800:300_um ${shapes}))
        (network_out (net A (via V_800:300_um 1000 -1000)))))`;
      expect(() => sesToItems(parseSes(session), twoNetBoard())).toThrow(SyntaxError);
    });
  }
  for (const layers of [["F.Cu", "B.Cu"], ['"F.Cu"', '"B.Cu"']]) {
    test(`preserves atomic circle layer operands ${layers.join("/")}`, () => {
      const shapes = layers.map(layer => `(shape (circle ${layer} 800))`).join(" ");
      const session = parseSes(`(session s (routes (library_out (padstack V_800:300_um ${shapes}))
        (network_out (net A (via V_800:300_um 1000 -1000)))))`);
      expect(sesToItems(session, twoNetBoard()).vias[0]!.layers).toEqual(twoNetBoard().copperLayers.map(l => l.id));
    });
  }
});


describe("session path layer operands", () => {
  for (const layer of ["(F.Cu)", '\"\"']) {
    test(`rejects invalid path layer ${layer}`, () => {
      expect(() => parseSes(`(session s (routes (network_out (net A
        (wire (path ${layer} 250 0 0 1000 1000))))))`)).toThrow(SyntaxError);
    });
  }
  for (const layer of ["F.Cu", '\"F.Cu\"']) {
    test(`preserves valid path layer ${layer}`, () => {
      const result = sesToItems(parseSes(`(session s (routes (network_out (net A
        (wire (path ${layer} 250 0 0 1000 1000))))))`), twoNetBoard());
      expect(result.tracks).toHaveLength(1);
      expect(result.tracks[0]!.width).toBe(250000);
      expect(result.tracks[0]!.end).toEqual({ x: 1000000, y: -1000000 });
    });
  }
});
