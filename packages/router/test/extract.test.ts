/**
 * `extractRouteInput` on a fake transport: a two-layer board with an outline of four segments, two
 * footprints with through-hole pads, a rule area, a copper text and one ratsnest edge.
 */
import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  BoardDesignRulesResponseSchema,
  BoardEnabledLayersResponseSchema,
  BoardGraphicShapeSchema,
  BoardLayer,
  BoardLayerNameResponseSchema,
  BoardTextSchema,
  DocumentSpecifierSchema,
  DocumentType,
  FootprintInstanceSchema,
  GetBoardDesignRulesSchema,
  GetBoardEnabledLayersSchema,
  GetBoardLayerNameSchema,
  GetBoundingBoxResponseSchema,
  GetBoundingBoxSchema,
  GetItemsResponseSchema,
  GetItemsSchema,
  GetNetClassForNetsSchema,
  GetNetsSchema,
  GetRatsnestSchema,
  ItemRequestStatus,
  KiCadObjectType,
  NetClassForNetsResponseSchema,
  NetsResponseSchema,
  PadSchema,
  PadStackShape,
  PadStackType,
  PadType,
  RatsnestResponseSchema,
  ZoneSchema,
  ZoneType,
  packAny,
  type Vector2,
} from "@fp-pcb/proto";
import { KiCad, KiCadClient, mm, toDistance, toVector2 } from "@fp-pcb/client";
import { FakeTransport, reply } from "../../client/test/fake-transport";
import { extractRouteInput, rulesForNet } from "../src/extract";

const DOC = create(DocumentSpecifierSchema, {
  type: DocumentType.DOCTYPE_PCB,
  identifier: { case: "boardFilename", value: "fake.kicad_pcb" },
});
const v = (x: number, y: number): Vector2 => toVector2({ x: mm(x), y: mm(y) });

function segment(id: string, x1: number, y1: number, x2: number, y2: number, layer = BoardLayer.BL_Edge_Cuts) {
  return packAny(
    BoardGraphicShapeSchema,
    create(BoardGraphicShapeSchema, {
      id: { value: id },
      layer,
      shape: { geometry: { case: "segment", value: { start: v(x1, y1), end: v(x2, y2) } } },
    }),
  );
}

function pad(
  id: string,
  parent: string,
  number: string,
  net: string,
  x: number,
  y: number,
  opts: { smd?: boolean; shape?: PadStackShape; angle?: number } = {},
) {
  return packAny(
    PadSchema,
    create(PadSchema, {
      id: { value: id },
      parent: { value: parent },
      number,
      net: net ? { name: net } : undefined,
      type: opts.smd ? PadType.PT_SMD : PadType.PT_PTH,
      position: v(x, y),
      padStack: {
        type: PadStackType.PST_NORMAL,
        layers: opts.smd ? [BoardLayer.BL_F_Cu] : [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
        drill: opts.smd ? undefined : { diameter: v(0.8, 0.8) },
        copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: opts.shape ?? PadStackShape.PSS_CIRCLE, size: v(1.6, 1.2) }],
        angle: { valueDegrees: opts.angle ?? 0 },
      },
    }),
  );
}

function footprint(id: string, reference: string) {
  return packAny(
    FootprintInstanceSchema,
    create(FootprintInstanceSchema, { id: { value: id }, referenceField: { text: { text: { text: reference } } } }),
  );
}

function boardServer(): FakeTransport {
  const t = new FakeTransport();
  t.on(GetBoardEnabledLayersSchema, () =>
    reply(BoardEnabledLayersResponseSchema, {
      copperLayerCount: 2,
      layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu, BoardLayer.BL_Edge_Cuts, BoardLayer.BL_F_SilkS],
    }),
  );
  t.on(GetBoardLayerNameSchema, (req) =>
    reply(BoardLayerNameResponseSchema, { name: req.layer === BoardLayer.BL_F_Cu ? "Top" : "Bottom" }),
  );
  t.on(GetItemsSchema, (req) => {
    const items = [];
    if (req.types.includes(KiCadObjectType.KOT_PCB_SHAPE)) {
      items.push(segment("e1", 0, 0, 40, 0), segment("e2", 40, 0, 40, 30), segment("e3", 40, 30, 0, 30), segment("e4", 0, 30, 0, 0));
      items.push(segment("s1", 1, 1, 2, 2, BoardLayer.BL_F_SilkS)); // silk: ignored
    }
    if (req.types.includes(KiCadObjectType.KOT_PCB_FOOTPRINT)) items.push(footprint("fp1", "R1"), footprint("fp2", "R2"));
    if (req.types.includes(KiCadObjectType.KOT_PCB_PAD)) {
      items.push(pad("p1", "fp1", "1", "N1", 5, 5, { angle: 90 }), pad("p2", "fp1", "2", "GND", 5, 15));
      items.push(pad("p3", "fp2", "1", "N1", 35, 25, { smd: true, shape: PadStackShape.PSS_RECTANGLE }), pad("p4", "fp2", "2", "", 35, 5));
    }
    if (req.types.includes(KiCadObjectType.KOT_PCB_ZONE)) {
      items.push(
        packAny(
          ZoneSchema,
          create(ZoneSchema, {
            id: { value: "z1" },
            name: "nokeep",
            type: ZoneType.ZT_RULE_AREA,
            layers: [BoardLayer.BL_F_Cu],
            outline: {
              polygons: [
                {
                  outline: {
                    nodes: [
                      { geometry: { case: "point", value: v(10, 10) } },
                      { geometry: { case: "point", value: v(20, 10) } },
                      { geometry: { case: "point", value: v(20, 20) } },
                    ],
                    closed: true,
                  },
                },
              ],
            },
            settings: { case: "ruleAreaSettings", value: { keepoutTracks: true, keepoutVias: false, keepoutCopper: false } },
          }),
        ),
      );
    }
    if (req.types.includes(KiCadObjectType.KOT_PCB_TEXT)) {
      items.push(
        packAny(
          BoardTextSchema,
          create(BoardTextSchema, { id: { value: "t1" }, layer: BoardLayer.BL_B_Cu, text: { text: "GND", position: v(30, 15) } }),
        ),
      );
    }
    return reply(GetItemsResponseSchema, { status: ItemRequestStatus.IRS_OK, items, total: items.length });
  });
  t.on(GetBoundingBoxSchema, (req) =>
    reply(GetBoundingBoxResponseSchema, {
      items: req.items,
      boxes: req.items.map(() => ({ position: v(28, 14), size: v(4, 2) })),
    }),
  );
  t.on(GetNetsSchema, () =>
    reply(NetsResponseSchema, {
      nets: [
        { name: "N1", code: { value: 1 } },
        { name: "GND", code: { value: 2 } },
      ],
    }),
  );
  t.on(GetNetClassForNetsSchema, () =>
    reply(NetClassForNetsResponseSchema, {
      classes: {
        N1: {
          name: "Default",
          board: {
            clearance: toDistance(mm(0.2)),
            trackWidth: toDistance(mm(0.25)),
            viaStack: { drill: { diameter: v(0.4, 0.4) }, copperLayers: [{ size: v(0.8, 0.8) }] },
          },
        },
        GND: {
          name: "Power",
          board: {
            clearance: toDistance(mm(0.3)),
            trackWidth: toDistance(mm(0.5)),
            viaStack: { drill: { diameter: v(0.5, 0.5) }, copperLayers: [{ size: v(1.0, 1.0) }] },
          },
        },
      },
    }),
  );
  t.on(GetBoardDesignRulesSchema, () =>
    reply(BoardDesignRulesResponseSchema, {
      rules: {
        constraints: {
          minClearance: toDistance(mm(0.1)),
          minTrackWidth: toDistance(mm(0.15)),
          minViaSize: toDistance(mm(0.5)),
          minThroughDrill: toDistance(mm(0.3)),
          copperEdgeClearance: toDistance(mm(0.25)),
        },
      },
    }),
  );
  t.on(GetRatsnestSchema, () =>
    reply(RatsnestResponseSchema, {
      unroutedCount: 1,
      edges: [
        {
          net: { name: "N1", code: { value: 1 } },
          source: { value: "p1" },
          target: { value: "p3" },
          sourcePosition: v(5, 5),
          targetPosition: v(35, 25),
          length: toDistance(Math.hypot(mm(30), mm(20))),
        },
      ],
    }),
  );
  return t;
}

describe("extractRouteInput", () => {
  test("builds the full RouteInput from the fake board", async () => {
    const t = boardServer();
    const kicad = new KiCad(await KiCadClient.connect(t, { clientName: "extract-test" }));
    const board = kicad.boardFrom(DOC);
    const warnings: string[] = [];
    const input = await extractRouteInput(board, { warn: (m) => warnings.push(m) });

    expect(input.boardName).toBe("fake.kicad_pcb");
    expect(input.copperLayers).toEqual([
      { id: BoardLayer.BL_F_Cu, name: "BL_F_Cu", userName: "Top", index: 0 },
      { id: BoardLayer.BL_B_Cu, name: "BL_B_Cu", userName: "Bottom", index: 1 },
    ]);

    // outline: the four Edge.Cuts segments chained into one 4-point polygon; silk ignored
    expect(input.outline.length).toBe(1);
    expect(input.outline[0]!.length).toBe(4);
    expect(input.bounds).toEqual({ x: 0, y: 0, w: mm(40), h: mm(30) });

    // pads: absolute positions, footprint references, layers, drills, net codes filled from GetNets
    expect(input.pads.length).toBe(4);
    const p1 = input.pads.find((p) => p.id === "p1")!;
    expect(p1).toMatchObject({
      footprint: "R1",
      number: "1",
      net: "N1",
      netCode: 1,
      shape: "circle",
      rotation: 90,
      through: true,
      drill: mm(0.8),
    });
    expect(p1.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu]);
    expect(p1.size).toEqual({ x: mm(1.6), y: mm(1.2) });
    const p3 = input.pads.find((p) => p.id === "p3")!;
    expect(p3).toMatchObject({ footprint: "R2", shape: "rect", through: false, drill: 0, layers: [BoardLayer.BL_F_Cu] });
    expect(input.pads.find((p) => p.id === "p4")!.net).toBe("");

    // rule area -> keepout; copper text -> obstacle with KiCad's bounding box
    expect(input.keepouts).toEqual([
      {
        id: "z1",
        name: "nokeep",
        layers: [BoardLayer.BL_F_Cu],
        polygon: [
          { x: mm(10), y: mm(10) },
          { x: mm(20), y: mm(10) },
          { x: mm(20), y: mm(20) },
        ],
        tracks: true,
        vias: false,
        copper: false,
      },
    ]);
    expect(input.zones).toEqual([]);
    expect(input.obstacles).toEqual([
      { id: "t1", kind: "text", layers: [BoardLayer.BL_B_Cu], bounds: { x: mm(28), y: mm(14), w: mm(4), h: mm(2) }, net: "" },
    ]);

    // nets & rules: per-class values, board minimums, default = the "Default" class
    expect(input.nets).toEqual([
      { name: "N1", code: 1, netClass: "Default" },
      { name: "GND", code: 2, netClass: "Power" },
    ]);
    expect(input.rules.default).toEqual({
      netClass: "Default",
      clearance: mm(0.2),
      trackWidth: mm(0.25),
      viaDiameter: mm(0.8),
      viaDrill: mm(0.4),
    });
    expect(rulesForNet(input, "GND")).toEqual({
      netClass: "Power",
      clearance: mm(0.3),
      trackWidth: mm(0.5),
      viaDiameter: mm(1.0),
      viaDrill: mm(0.5),
    });
    expect(rulesForNet(input, "unknown")).toBe(input.rules.default);
    expect(input.rules).toMatchObject({
      minClearance: mm(0.1),
      minTrackWidth: mm(0.15),
      minViaDiameter: mm(0.5),
      minViaDrill: mm(0.3),
      edgeClearance: mm(0.25),
    });

    // connections from the ratsnest, endpoints carrying the items' layers
    expect(input.connections.length).toBe(1);
    expect(input.connections[0]).toMatchObject({ net: "N1", netCode: 1 });
    expect(input.connections[0]!.from).toEqual({
      itemId: "p1",
      position: { x: mm(5), y: mm(5) },
      layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
    });
    expect(input.connections[0]!.to).toEqual({ itemId: "p3", position: { x: mm(35), y: mm(25) }, layers: [BoardLayer.BL_F_Cu] });
    expect(warnings).toEqual([]);

    // one GetItems per item group, one GetRatsnest, one GetNetClassForNets
    expect(t.countOf(GetRatsnestSchema)).toBe(1);
    expect(t.countOf(GetNetClassForNetsSchema)).toBe(1);
    expect(t.countOf(GetBoundingBoxSchema)).toBe(1);
  });

  test("net filter restricts connections; an outline that does not close is reported", async () => {
    const t = boardServer();
    t.on(GetItemsSchema, (req) => {
      const items = req.types.includes(KiCadObjectType.KOT_PCB_SHAPE) ? [segment("e1", 0, 0, 40, 0), segment("e2", 40, 0, 40, 30)] : [];
      return reply(GetItemsResponseSchema, { status: ItemRequestStatus.IRS_OK, items, total: items.length });
    });
    const kicad = new KiCad(await KiCadClient.connect(t, { clientName: "extract-test" }));
    const warnings: string[] = [];
    const input = await extractRouteInput(kicad.boardFrom(DOC), { nets: ["GND"], warn: (m) => warnings.push(m) });
    expect(input.outline).toEqual([]);
    expect(warnings.some((w) => /do not close/.test(w))).toBe(true);
    expect(input.connections).toEqual([]);
    expect(t.requestsOf(GetRatsnestSchema)[0]!.nets.map((n) => n.name)).toEqual(["GND"]);
  });
});
