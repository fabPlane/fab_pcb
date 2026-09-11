import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ArcSchema, BoardLayer, NetSchema, PadSchema, PolygonWithHolesSchema, RuleSeverity, ViaType } from "@fp-pcb/proto";
import {
  Arc,
  Pad,
  createBoardGraphic,
  createBoardText,
  createTrack,
  createVia,
  createZone,
  inspectBoardGeometry,
  type Board,
} from "../src/model";
import { mm } from "../src/units";

describe("board authoring", () => {
  test("constructs native track, via, copper zone, keepout, text, and graphic messages", () => {
    const track = createTrack({
      id: "track-1",
      start: { x: mm(1), y: mm(2) },
      end: { x: mm(3), y: mm(4) },
      width: mm(0.25),
      layer: BoardLayer.BL_F_Cu,
      net: { name: "GND", code: 1 },
    });
    expect(track).toMatchObject({ id: "track-1", start: { x: mm(1), y: mm(2) }, end: { x: mm(3), y: mm(4) }, width: mm(0.25), net: "GND" });

    const via = createVia({
      id: "via-1",
      position: { x: mm(3), y: mm(4) },
      diameter: mm(0.8),
      drill: mm(0.4),
      layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_In1_Cu],
      net: { name: "GND", code: 1 },
    });
    expect(via.position).toEqual({ x: mm(3), y: mm(4) });
    expect(via.layers).toEqual([BoardLayer.BL_F_Cu, BoardLayer.BL_In1_Cu]);
    expect(via.viaType).toBe(ViaType.VT_BLIND_BURIED);
    expect(via.diameter).toBe(mm(0.8));
    expect(via.drillDiameter).toBe(mm(0.4));

    const polygon = {
      outline: [
        { x: 0, y: 0 },
        { x: mm(10), y: 0 },
        { x: mm(10), y: mm(5) },
      ],
      holes: [
        [
          { x: mm(1), y: mm(1) },
          { x: mm(2), y: mm(1) },
          { x: mm(1), y: mm(2) },
        ],
      ],
    };
    const copper = createZone({
      id: "zone-1",
      kind: "copper",
      polygons: [polygon],
      layers: [BoardLayer.BL_F_Cu],
      net: { name: "GND", code: 1 },
      clearance: mm(0.22),
      minThickness: mm(0.18),
      priority: 2,
    });
    expect(copper.isRuleArea).toBe(false);
    expect(copper.clearance).toBe(mm(0.22));
    expect(copper.proto.outline?.polygons[0]?.holes).toHaveLength(1);

    const keepout = createZone({
      id: "keepout-1",
      kind: "keepout",
      polygons: [polygon],
      layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu],
      copper: false,
      tracks: true,
      vias: false,
      pads: true,
      footprints: true,
    });
    expect(keepout.isRuleArea).toBe(true);
    expect(keepout.proto.settings).toMatchObject({
      case: "ruleAreaSettings",
      value: { keepoutCopper: false, keepoutTracks: true, keepoutVias: false, keepoutPads: true, keepoutFootprints: true },
    });

    const text = createBoardText({
      id: "text-1",
      text: "REV A",
      position: { x: mm(5), y: mm(6) },
      layer: BoardLayer.BL_F_SilkS,
      size: { x: mm(1.2), y: mm(1) },
      thickness: mm(0.15),
      angle: 90,
    });
    expect(text).toMatchObject({ id: "text-1", text: "REV A", position: { x: mm(5), y: mm(6) }, angle: 90, thickness: mm(0.15) });

    const graphic = createBoardGraphic({
      id: "shape-1",
      geometry: { kind: "circle", center: { x: mm(2), y: mm(2) }, radiusPoint: { x: mm(3), y: mm(2) } },
      layer: BoardLayer.BL_Dwgs_User,
      strokeWidth: mm(0.1),
      filled: true,
    });
    expect(graphic).toMatchObject({
      id: "shape-1",
      kind: "circle",
      start: { x: mm(2), y: mm(2) },
      end: { x: mm(3), y: mm(2) },
      strokeWidth: mm(0.1),
    });
  });

  test("returns revision-bounded canonical geometry, transformed pad shapes, nets, and rules", async () => {
    const pad = new Pad(
      create(PadSchema, {
        id: { value: "pad-1" },
        parent: { value: "fp-1" },
        number: "1",
        position: { xNm: BigInt(mm(12)), yNm: BigInt(mm(9)) },
        net: { name: "GND", code: { value: 1 } },
        padStack: {
          layers: [BoardLayer.BL_F_Cu],
          angle: { valueDegrees: 90 },
          copperLayers: [{ layer: BoardLayer.BL_F_Cu, size: { xNm: BigInt(mm(2)), yNm: BigInt(mm(1)) } }],
          drill: { diameter: { xNm: BigInt(mm(0.8)), yNm: BigInt(mm(0.8)) } },
        },
      }),
    );
    const track = createTrack({
      id: "track-1",
      start: { x: 1, y: 2 },
      end: { x: 3, y: 4 },
      width: 5,
      layer: BoardLayer.BL_F_Cu,
      net: { name: "GND", code: 1 },
    });
    const via = createVia({ id: "via-1", position: { x: 3, y: 4 }, diameter: 8, drill: 4, net: { name: "GND", code: 1 } });
    const arc = new Arc(
      create(ArcSchema, {
        id: { value: "arc-1" },
        start: { xNm: 1n, yNm: 2n },
        mid: { xNm: 2n, yNm: 3n },
        end: { xNm: 3n, yNm: 4n },
        width: { valueNm: 5n },
        layer: BoardLayer.BL_B_Cu,
        net: { name: "GND", code: { value: 1 } },
      }),
    );
    const zone = createZone({
      id: "zone-1",
      kind: "copper",
      polygons: [
        {
          outline: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 0, y: 10 },
          ],
        },
      ],
      layers: [BoardLayer.BL_F_Cu],
      net: { name: "GND", code: 1 },
    });
    const text = createBoardText({ id: "text-1", text: "A", position: { x: 1, y: 2 }, layer: BoardLayer.BL_F_SilkS });
    const graphic = createBoardGraphic({
      id: "graphic-1",
      geometry: { kind: "segment", start: { x: 1, y: 2 }, end: { x: 3, y: 4 } },
      layer: BoardLayer.BL_Edge_Cuts,
      strokeWidth: 10,
    });
    const polygon = create(PolygonWithHolesSchema, {
      outline: { closed: true, nodes: [{ geometry: { case: "point", value: { xNm: 11n, yNm: 22n } } }] },
    });
    let revisionReads = 0;
    const board = {
      revision: async () => (++revisionReads, 7n),
      enabledLayers: async () => ({ copperLayerCount: 2, layers: [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu] }),
      getPads: async () => [pad],
      getFootprints: async () => [{ id: "fp-1", reference: "U1" }],
      getTracks: async () => [track, arc, via],
      getZones: async () => [zone],
      getTexts: async () => [text],
      getShapes: async () => [graphic],
      nets: async () => [create(NetSchema, { name: "GND", code: { value: 1 } })],
      designRules: async () => ({
        rules: { constraints: { minClearance: { valueNm: 100n }, minTrackWidth: { valueNm: 125n } } },
        customRulesStatus: 0,
      }),
      customRules: async () => ({
        status: 1,
        errorText: "",
        rules: [
          {
            name: "USB gap",
            condition: "A.NetName == 'USB_D+'",
            constraints: [],
            layerCondition: { case: undefined },
            severity: RuleSeverity.RS_ERROR,
            constituents: [],
          },
        ],
      }),
      padShapesAsPolygons: async () => new Map([["pad-1", polygon]]),
      netClassForNets: async () =>
        new Map([
          [
            "GND",
            {
              name: "Power",
              board: {
                clearance: { valueNm: 200n },
                trackWidth: { valueNm: 250n },
                viaStack: { copperLayers: [{ size: { xNm: 800n } }], drill: { diameter: { xNm: 400n } } },
              },
            },
          ],
        ]),
    } as unknown as Board;

    const snapshot = await inspectBoardGeometry(board);
    expect(revisionReads).toBe(2);
    expect(snapshot).toMatchObject({
      revisionStart: 7n,
      revisionEnd: 7n,
      revisionStable: true,
      pads: [
        {
          id: "pad-1",
          reference: "U1",
          position: { x: mm(12), y: mm(9) },
          orientation: 90,
          net: "GND",
          polygons: [{ layer: BoardLayer.BL_F_Cu }],
        },
      ],
      tracks: [{ id: "track-1", net: "GND" }],
      arcs: [{ id: "arc-1" }],
      vias: [{ id: "via-1" }],
      zones: [{ id: "zone-1", kind: "copper" }],
      texts: [{ id: "text-1" }],
      graphics: [{ id: "graphic-1" }],
      nets: [{ name: "GND", code: 1, netClass: "Power", clearance: 200, trackWidth: 250, viaDiameter: 800, viaDrill: 400 }],
      rules: { minimums: { minClearance: 100, minTrackWidth: 125 }, customStatus: 1, customErrorText: "" },
    });
    expect(snapshot.pads[0]!.polygons[0]!.shape).toBe(polygon);
    expect(snapshot.zones[0]!.polygons).toHaveLength(1);
    expect(snapshot.graphics[0]!.geometry).toMatchObject({ case: "segment" });
  });
});
