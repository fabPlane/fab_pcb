/** Optional constructors and inspection helpers for native board geometry. */
import { create } from "@bufbuild/protobuf";
import {
  BoardGraphicShapeSchema,
  BoardLayer,
  BoardTextSchema,
  DrillShape,
  GraphicFillType,
  HorizontalAlignment,
  LockedState,
  PadStackShape,
  PadStackType,
  TrackSchema,
  VerticalAlignment,
  ViaSchema,
  ViaType,
  ZoneBorderStyle,
  ZoneFillMode,
  ZoneSchema,
  ZoneType,
  type CustomRule,
  type PolygonWithHoles,
} from "@fp-pcb/proto";
import { nm, toAngle, toDistance, toVector2, type Vec2 } from "../units";
import type { Board } from "./board";
import { Arc, BoardShape, BoardText, Track, Via, Zone } from "./items";

export interface BoardNetInput {
  name: string;
  code?: number;
}

export interface TrackInput {
  id?: string;
  start: Vec2;
  end: Vec2;
  width: number;
  layer: BoardLayer;
  net?: BoardNetInput;
  locked?: boolean;
}

export interface ViaInput {
  id?: string;
  position: Vec2;
  diameter: number;
  drill: number;
  /** Ordered start/end copper layers. */
  layers?: readonly BoardLayer[];
  net?: BoardNetInput;
  type?: ViaType;
  locked?: boolean;
}

export interface PolygonInput {
  outline: readonly Vec2[];
  holes?: readonly (readonly Vec2[])[];
}

export interface CopperZoneInput {
  id?: string;
  kind: "copper";
  polygons: readonly PolygonInput[];
  layers: readonly BoardLayer[];
  net?: BoardNetInput;
  name?: string;
  clearance?: number;
  minThickness?: number;
  priority?: number;
  fillMode?: ZoneFillMode;
  locked?: boolean;
}

export interface KeepoutInput {
  id?: string;
  kind: "keepout";
  polygons: readonly PolygonInput[];
  layers: readonly BoardLayer[];
  name?: string;
  copper?: boolean;
  vias?: boolean;
  tracks?: boolean;
  pads?: boolean;
  footprints?: boolean;
  locked?: boolean;
}

export type ZoneInput = CopperZoneInput | KeepoutInput;

export interface BoardTextInput {
  id?: string;
  text: string;
  position: Vec2;
  layer: BoardLayer;
  size?: Vec2;
  thickness?: number;
  angle?: number;
  knockout?: boolean;
  locked?: boolean;
}

export type BoardGraphicGeometry =
  | { kind: "segment"; start: Vec2; end: Vec2 }
  | { kind: "rectangle"; topLeft: Vec2; bottomRight: Vec2 }
  | { kind: "arc"; start: Vec2; mid: Vec2; end: Vec2 }
  | { kind: "circle"; center: Vec2; radiusPoint: Vec2 }
  | { kind: "polygon"; polygons: readonly PolygonInput[] };

export interface BoardGraphicInput {
  id?: string;
  geometry: BoardGraphicGeometry;
  layer: BoardLayer;
  strokeWidth?: number;
  filled?: boolean;
  net?: BoardNetInput;
  locked?: boolean;
}

const id = (value: string | undefined) => (value ? { value } : undefined);
const net = (value: BoardNetInput | undefined) =>
  value ? { name: value.name, code: value.code === undefined ? undefined : { value: value.code } } : undefined;

function lineChain(points: readonly Vec2[]) {
  return {
    closed: true,
    nodes: points.map((point) => ({ geometry: { case: "point" as const, value: toVector2(point) } })),
  };
}

function polySet(polygons: readonly PolygonInput[]) {
  return {
    polygons: polygons.map((polygon) => ({
      outline: lineChain(polygon.outline),
      holes: (polygon.holes ?? []).map(lineChain),
    })),
  };
}

export function createTrack(input: TrackInput): Track {
  return new Track(
    create(TrackSchema, {
      id: id(input.id),
      start: toVector2(input.start),
      end: toVector2(input.end),
      width: toDistance(input.width),
      layer: input.layer,
      net: net(input.net),
      locked: input.locked ? LockedState.LS_LOCKED : LockedState.LS_UNLOCKED,
    }),
  );
}

export function createVia(input: ViaInput): Via {
  const layers = [...(input.layers?.length ? input.layers : [BoardLayer.BL_F_Cu, BoardLayer.BL_B_Cu])];
  const first = layers[0]!;
  const last = layers.at(-1)!;
  const diameter = toVector2({ x: input.diameter, y: input.diameter });
  const drill = toVector2({ x: input.drill, y: input.drill });
  return new Via(
    create(ViaSchema, {
      id: id(input.id),
      position: toVector2(input.position),
      type: input.type ?? (first === BoardLayer.BL_F_Cu && last === BoardLayer.BL_B_Cu ? ViaType.VT_THROUGH : ViaType.VT_BLIND_BURIED),
      net: net(input.net),
      locked: input.locked ? LockedState.LS_LOCKED : LockedState.LS_UNLOCKED,
      padStack: {
        type: PadStackType.PST_NORMAL,
        layers,
        drill: { startLayer: first, endLayer: last, diameter: drill, shape: DrillShape.DS_CIRCLE },
        // KiCad uses F.Cu as the all-copper-layers key for a normal via pad stack.
        copperLayers: [{ layer: BoardLayer.BL_F_Cu, shape: PadStackShape.PSS_CIRCLE, size: diameter }],
      },
    }),
  );
}

export function createZone(input: ZoneInput): Zone {
  return new Zone(
    create(ZoneSchema, {
      id: id(input.id),
      type: input.kind === "copper" ? ZoneType.ZT_COPPER : ZoneType.ZT_RULE_AREA,
      name: input.name ?? "",
      layers: [...input.layers],
      priority: input.kind === "copper" ? (input.priority ?? 0) : 0,
      outline: polySet(input.polygons),
      locked: input.locked ? LockedState.LS_LOCKED : LockedState.LS_UNLOCKED,
      border: { style: ZoneBorderStyle.ZBS_DIAGONAL_EDGE, pitch: toDistance(500_000) },
      settings:
        input.kind === "copper"
          ? {
              case: "copperSettings",
              value: {
                net: net(input.net),
                clearance: toDistance(input.clearance ?? 200_000),
                minThickness: toDistance(input.minThickness ?? 250_000),
                fillMode: input.fillMode ?? ZoneFillMode.ZFM_SOLID,
              },
            }
          : {
              case: "ruleAreaSettings",
              value: {
                keepoutCopper: input.copper ?? true,
                keepoutVias: input.vias ?? true,
                keepoutTracks: input.tracks ?? true,
                keepoutPads: input.pads ?? false,
                keepoutFootprints: input.footprints ?? false,
              },
            },
    }),
  );
}

export function createBoardText(input: BoardTextInput): BoardText {
  const size = input.size ?? { x: 1_000_000, y: 1_000_000 };
  return new BoardText(
    create(BoardTextSchema, {
      id: id(input.id),
      layer: input.layer,
      locked: input.locked ? LockedState.LS_LOCKED : LockedState.LS_UNLOCKED,
      knockout: input.knockout ?? false,
      text: {
        text: input.text,
        position: toVector2(input.position),
        attributes: {
          size: toVector2(size),
          strokeWidth: toDistance(input.thickness ?? Math.round(Math.min(size.x, size.y) * 0.15)),
          angle: toAngle(input.angle ?? 0),
          visible: true,
          horizontalAlignment: HorizontalAlignment.HA_CENTER,
          verticalAlignment: VerticalAlignment.VA_CENTER,
        },
      },
    }),
  );
}

export function createBoardGraphic(input: BoardGraphicInput): BoardShape {
  const g = input.geometry;
  const geometry =
    g.kind === "segment"
      ? { case: "segment" as const, value: { start: toVector2(g.start), end: toVector2(g.end) } }
      : g.kind === "rectangle"
        ? { case: "rectangle" as const, value: { topLeft: toVector2(g.topLeft), bottomRight: toVector2(g.bottomRight) } }
        : g.kind === "arc"
          ? { case: "arc" as const, value: { start: toVector2(g.start), mid: toVector2(g.mid), end: toVector2(g.end) } }
          : g.kind === "circle"
            ? { case: "circle" as const, value: { center: toVector2(g.center), radiusPoint: toVector2(g.radiusPoint) } }
            : { case: "polygon" as const, value: polySet(g.polygons) };
  return new BoardShape(
    create(BoardGraphicShapeSchema, {
      id: id(input.id),
      layer: input.layer,
      locked: input.locked ? LockedState.LS_LOCKED : LockedState.LS_UNLOCKED,
      net: net(input.net),
      shape: {
        geometry,
        attributes: {
          stroke: { width: toDistance(input.strokeWidth ?? 0) },
          fill: { fillType: input.filled ? GraphicFillType.GFT_FILLED : GraphicFillType.GFT_UNFILLED },
        },
      },
    }),
  );
}

export interface BoardGeometrySnapshot {
  revisionStart?: bigint;
  revisionEnd?: bigint;
  revisionStable: boolean;
  enabledLayers: { copperLayerCount: number; layers: BoardLayer[] };
  pads: Array<{
    id: string;
    parent?: string;
    reference?: string;
    number: string;
    position: Vec2;
    size: Vec2;
    orientation: number;
    drillDiameter: Vec2;
    layers: BoardLayer[];
    net?: string;
    netCode?: number;
    polygons: Array<{ layer: BoardLayer; shape: PolygonWithHoles }>;
  }>;
  tracks: Array<{ id: string; start: Vec2; end: Vec2; width: number; layer: BoardLayer; net?: string; netCode?: number; locked: boolean }>;
  arcs: Array<{
    id: string;
    start: Vec2;
    mid: Vec2;
    end: Vec2;
    width: number;
    layer: BoardLayer;
    net?: string;
    netCode?: number;
    locked: boolean;
  }>;
  vias: Array<{
    id: string;
    position: Vec2;
    diameter: number;
    drill: number;
    layers: BoardLayer[];
    net?: string;
    netCode?: number;
    locked: boolean;
  }>;
  zones: Array<{
    id: string;
    kind: "copper" | "keepout";
    name: string;
    layers: BoardLayer[];
    net?: string;
    netCode?: number;
    clearance: number;
    minThickness: number;
    outline: Vec2[];
    /** Complete native polygon set, including holes and non-point nodes. */
    polygons: PolygonWithHoles[];
    locked: boolean;
  }>;
  texts: Array<{
    id: string;
    text: string;
    position: Vec2;
    size: Vec2;
    thickness: number;
    angle: number;
    layer: BoardLayer;
    locked: boolean;
  }>;
  graphics: Array<{
    id: string;
    kind: string;
    start: Vec2;
    end: Vec2;
    /** Complete native geometry oneof for segments, rectangles, arcs, circles, and polygons. */
    geometry: unknown;
    strokeWidth: number;
    layer: BoardLayer;
    net?: string;
    locked: boolean;
  }>;
  nets: Array<{
    name: string;
    code: number;
    netClass?: string;
    clearance?: number;
    trackWidth?: number;
    viaDiameter?: number;
    viaDrill?: number;
  }>;
  rules: {
    minimums: Record<string, number>;
    customStatus: number;
    customErrorText: string;
    custom: CustomRule[];
  };
}

/** Reads canonical board geometry and the revision interval containing the read. */
export async function inspectBoardGeometry(board: Board): Promise<BoardGeometrySnapshot> {
  const revisionStart = await board.revision();
  const [enabledLayers, pads, footprints, routes, zones, texts, graphics, nets, rules, customRules] = await Promise.all([
    board.enabledLayers(),
    board.getPads(),
    board.getFootprints(),
    board.getTracks(),
    board.getZones(),
    board.getTexts(),
    board.getShapes(),
    board.nets(),
    board.designRules(),
    board.customRules(),
  ]);
  const padPolygons = new Map<BoardLayer, Map<string, PolygonWithHoles>>();
  for (const layer of new Set(pads.flatMap((pad) => pad.layers))) {
    padPolygons.set(
      layer,
      await board.padShapesAsPolygons(
        pads.filter((pad) => pad.layers.includes(layer)).map((pad) => pad.id),
        layer,
      ),
    );
  }
  const netClasses = await board.netClassForNets(nets.map((item) => item.name));
  const revisionEnd = await board.revision();
  const references = new Map(footprints.map((footprint) => [footprint.id, footprint.reference]));
  const minimums = rules.rules.constraints;
  const minimumValues: Record<string, number> = {};
  if (minimums) {
    for (const key of [
      "minClearance",
      "minGrooveWidth",
      "minConnectionWidth",
      "minTrackWidth",
      "minViaAnnularWidth",
      "minViaSize",
      "minThroughDrill",
      "minMicroviaSize",
      "minMicroviaDrill",
      "copperEdgeClearance",
      "holeClearance",
      "holeToHoleMin",
      "silkClearance",
      "minSilkTextHeight",
      "minSilkTextThickness",
    ] as const)
      minimumValues[key] = nm(minimums[key]);
  }
  return {
    revisionStart,
    revisionEnd,
    revisionStable: revisionStart === revisionEnd,
    enabledLayers,
    pads: pads.map((pad) => ({
      id: pad.id,
      ...(pad.parent ? { parent: pad.parent } : {}),
      ...(pad.parent && references.get(pad.parent) !== undefined ? { reference: references.get(pad.parent)! } : {}),
      number: pad.number,
      position: pad.position,
      size: pad.size,
      orientation: pad.orientation,
      drillDiameter: pad.drillDiameter,
      layers: pad.layers,
      ...(pad.net ? { net: pad.net } : {}),
      ...(pad.netCode !== undefined ? { netCode: pad.netCode } : {}),
      polygons: pad.layers.flatMap((layer) => {
        const shape = padPolygons.get(layer)?.get(pad.id);
        return shape ? [{ layer, shape }] : [];
      }),
    })),
    tracks: routes
      .filter((item): item is Track => item instanceof Track)
      .map((item) => ({
        id: item.id,
        start: item.start,
        end: item.end,
        width: item.width,
        layer: item.layerId,
        ...(item.net ? { net: item.net } : {}),
        ...(item.netCode !== undefined ? { netCode: item.netCode } : {}),
        locked: item.locked,
      })),
    arcs: routes
      .filter((item): item is Arc => item instanceof Arc)
      .map((item) => ({
        id: item.id,
        start: item.start,
        mid: item.mid,
        end: item.end,
        width: item.width,
        layer: item.layerId,
        ...(item.net ? { net: item.net } : {}),
        ...(item.netCode !== undefined ? { netCode: item.netCode } : {}),
        locked: item.locked,
      })),
    vias: routes
      .filter((item): item is Via => item instanceof Via)
      .map((item) => ({
        id: item.id,
        position: item.position,
        diameter: item.diameter,
        drill: item.drillDiameter,
        layers: item.layers,
        ...(item.net ? { net: item.net } : {}),
        ...(item.netCode !== undefined ? { netCode: item.netCode } : {}),
        locked: item.locked,
      })),
    zones: zones.map((item) => ({
      id: item.id,
      kind: item.isRuleArea ? ("keepout" as const) : ("copper" as const),
      name: item.name,
      layers: item.layers,
      ...(item.net ? { net: item.net } : {}),
      ...(item.netCode !== undefined ? { netCode: item.netCode } : {}),
      clearance: item.clearance,
      minThickness: item.minThickness,
      outline: item.outlinePoints,
      polygons: item.outline?.polygons ?? [],
      locked: item.locked,
    })),
    texts: texts.map((item) => ({
      id: item.id,
      text: item.text,
      position: item.position,
      size: item.size,
      thickness: item.thickness,
      angle: item.angle,
      layer: item.layerId,
      locked: item.locked,
    })),
    graphics: graphics.map((item) => ({
      id: item.id,
      kind: item.kind,
      start: item.start,
      end: item.end,
      geometry: item.shape?.geometry ?? { case: undefined },
      strokeWidth: item.strokeWidth,
      layer: item.layerId,
      ...(item.net ? { net: item.net } : {}),
      locked: item.locked,
    })),
    nets: nets.map((item) => {
      const netClass = netClasses.get(item.name);
      const boardRules = netClass?.board;
      return {
        name: item.name,
        code: item.code?.value ?? 0,
        ...(netClass?.name ? { netClass: netClass.name } : {}),
        ...(boardRules?.clearance ? { clearance: nm(boardRules.clearance) } : {}),
        ...(boardRules?.trackWidth ? { trackWidth: nm(boardRules.trackWidth) } : {}),
        ...(boardRules?.viaStack?.copperLayers[0]?.size?.xNm !== undefined
          ? { viaDiameter: nm(boardRules.viaStack.copperLayers[0].size?.xNm) }
          : {}),
        ...(boardRules?.viaStack?.drill?.diameter?.xNm !== undefined ? { viaDrill: nm(boardRules.viaStack.drill.diameter.xNm) } : {}),
      };
    }),
    rules: { minimums: minimumValues, customStatus: customRules.status, customErrorText: customRules.errorText, custom: customRules.rules },
  };
}
