/**
 * `extractRouteInput(board)`: everything a router needs, read from a `Board` through the model layer
 * (outline from Edge.Cuts shapes, copper layers, pads, existing tracks and vias, rule areas as
 * keepouts, copper zones, net classes and board minimums, and the ratsnest as the connection list).
 */
import { BoardLayer, PadStackShape, PadType, ZoneType, type NetClass, type PolySet } from "@kicad-web/proto";
import {
  Arc,
  BoardField,
  BoardShape,
  BoardText,
  Pad,
  Track,
  Via,
  boxFromPoints,
  boxUnion,
  mm,
  nm,
  vec2,
  type Board,
  type Box,
  type Vec2,
} from "@kicad-web/client";
import { arcPoints, chainOutline, circlePoints, type OutlinePiece } from "./geometry";
import type {
  RouteConnection,
  RouteEndpoint,
  RouteInput,
  RouteKeepout,
  RouteLayer,
  RouteNetRules,
  RouteObstacle,
  RoutePad,
  RoutePadShape,
  RoutePolygon,
  RouteRules,
  RouteTrack,
  RouteVia,
  RouteZone,
} from "./types";

export interface ExtractOptions {
  /** Only these nets' connections (names); pads and copper of every net are still extracted as obstacles. */
  nets?: readonly string[];
  /** Tolerance for chaining Edge.Cuts segments into a polygon, nm (default 10 µm). */
  outlineTolerance?: number;
  /** Collects warnings (unclosed outline, pads without copper, ...). */
  warn?: (message: string) => void;
}

export const COPPER_LAYERS: readonly BoardLayer[] = Object.values(BoardLayer)
  .filter((v): v is BoardLayer => typeof v === "number" && v >= BoardLayer.BL_F_Cu && v <= BoardLayer.BL_B_Cu)
  .sort((a, b) => a - b);

export function isCopperLayer(l: BoardLayer): boolean {
  return l >= BoardLayer.BL_F_Cu && l <= BoardLayer.BL_B_Cu;
}

/** Copper layers in stack order: F.Cu, In1..InN, B.Cu (the enum already numbers them that way). */
export function copperLayersInOrder(layers: readonly BoardLayer[]): BoardLayer[] {
  return [...new Set(layers.filter(isCopperLayer))].sort((a, b) => a - b);
}

function padShape(shape: PadStackShape | undefined): RoutePadShape {
  switch (shape) {
    case PadStackShape.PSS_CIRCLE:
      return "circle";
    case PadStackShape.PSS_OVAL:
      return "oval";
    case PadStackShape.PSS_ROUNDRECT:
      return "roundrect";
    case PadStackShape.PSS_TRAPEZOID:
      return "trapezoid";
    case PadStackShape.PSS_CHAMFEREDRECT:
      return "chamferedrect";
    case PadStackShape.PSS_CUSTOM:
      return "custom";
    default:
      return "rect";
  }
}

function polygonsOf(set: PolySet | undefined): RoutePolygon[] {
  const out: RoutePolygon[] = [];
  for (const poly of set?.polygons ?? []) {
    const pts: Vec2[] = [];
    for (const n of poly.outline?.nodes ?? []) {
      if (n.geometry.case === "point") pts.push(vec2(n.geometry.value));
      else if (n.geometry.case === "arc") {
        const a = n.geometry.value;
        const arc = arcPoints(vec2(a.start), vec2(a.mid), vec2(a.end));
        pts.push(...(pts.length ? arc.slice(1) : arc));
      }
    }
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

function netRulesOf(cls: NetClass | undefined, fallback: RouteNetRules): RouteNetRules {
  const b = cls?.board;
  const via = b?.viaStack;
  return {
    netClass: cls?.name ?? fallback.netClass,
    clearance: b?.clearance ? nm(b.clearance) : fallback.clearance,
    trackWidth: b?.trackWidth ? nm(b.trackWidth) : fallback.trackWidth,
    viaDiameter: via?.copperLayers[0]?.size ? nm(via.copperLayers[0].size.xNm) : fallback.viaDiameter,
    viaDrill: via?.drill?.diameter ? nm(via.drill.diameter.xNm) : fallback.viaDrill,
  };
}

function toRoutePad(pad: Pad, footprintRef: string, copper: readonly BoardLayer[]): RoutePad {
  const stack = pad.padStack;
  const first = stack?.copperLayers[0];
  const through = pad.padType === PadType.PT_PTH || pad.padType === PadType.PT_NPTH;
  const layers = through ? [...copper] : copperLayersInOrder(pad.layers);
  return {
    id: pad.id,
    footprint: footprintRef,
    number: pad.number,
    net: pad.net ?? "",
    netCode: pad.netCode ?? 0,
    position: pad.position,
    size: vec2(first?.size),
    shape: padShape(first?.shape),
    rotation: pad.orientation,
    layers,
    through,
    drill: through ? nm(stack?.drill?.diameter?.xNm) : 0,
    clearance: pad.proto.copperClearanceOverride ? nm(pad.proto.copperClearanceOverride) : undefined,
  };
}

/** Reads the board and builds the router input. Several round trips; call once per routing run. */
export async function extractRouteInput(board: Board, opts: ExtractOptions = {}): Promise<RouteInput> {
  const warn = opts.warn ?? (() => {});

  const [enabled, shapes, footprints, pads, tracks, zones, nets, design, texts] = await Promise.all([
    board.enabledLayers(),
    board.getShapes(),
    board.getFootprints(),
    board.getPads(),
    board.getTracks(),
    board.getZones(),
    board.nets(),
    board.designRules(),
    board.getTexts(),
  ]);

  // --- copper layers ---------------------------------------------------------------------------
  const copperIds = copperLayersInOrder(enabled.layers);
  const copperLayers: RouteLayer[] = [];
  for (const [index, id] of copperIds.entries()) {
    let userName = BoardLayer[id] ?? String(id);
    try {
      userName = await board.layerName(id);
    } catch {
      /* servers without GetBoardLayerName: keep the enum name */
    }
    copperLayers.push({ id, name: BoardLayer[id] ?? String(id), userName, index });
  }

  // --- outline ---------------------------------------------------------------------------------
  const pieces: OutlinePiece[] = [];
  for (const s of shapes) {
    if (s.layerId !== BoardLayer.BL_Edge_Cuts) continue;
    const g = s.shape?.geometry;
    switch (g?.case) {
      case "segment":
        pieces.push({ points: [vec2(g.value.start), vec2(g.value.end)], closed: false });
        break;
      case "arc":
        pieces.push({ points: arcPoints(vec2(g.value.start), vec2(g.value.mid), vec2(g.value.end)), closed: false });
        break;
      case "circle": {
        const c = vec2(g.value.center);
        const r = vec2(g.value.radiusPoint);
        pieces.push({ points: circlePoints(c, Math.hypot(r.x - c.x, r.y - c.y)), closed: true });
        break;
      }
      case "rectangle": {
        const a = vec2(g.value.topLeft);
        const b = vec2(g.value.bottomRight);
        pieces.push({ points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], closed: true });
        break;
      }
      case "polygon":
        for (const p of polygonsOf(g.value)) pieces.push({ points: p, closed: true });
        break;
      case "bezier":
        pieces.push({ points: [vec2(g.value.start), vec2(g.value.end)], closed: false });
        warn(`outline bezier ${s.id} approximated by its chord`);
        break;
      default:
        break;
    }
  }
  const outline = chainOutline(pieces, opts.outlineTolerance);
  const openPieces = pieces.filter((p) => !p.closed).length;
  if (openPieces && outline.length === 0)
    warn(`board outline has ${openPieces} Edge.Cuts pieces that do not close; routing without an outline`);

  // --- pads, tracks, vias ----------------------------------------------------------------------
  const refById = new Map(footprints.map((f) => [f.id, f.reference]));
  // Items from GetItems carry the net name but not always its code; the net list has both.
  const codeByNet = new Map(nets.map((n) => [n.name, n.code?.value ?? 0]));
  const routePads = pads.map((p) => toRoutePad(p, refById.get(p.parent ?? "") ?? "", copperIds));
  for (const p of routePads) if (!p.netCode && p.net) p.netCode = codeByNet.get(p.net) ?? 0;
  // Custom pads: `size` is only the anchor; ask KiCad for the real outline and keep its bounding box.
  const custom = routePads.filter((p) => p.shape === "custom");
  if (custom.length) {
    const byLayer = new Map<BoardLayer, string[]>();
    for (const p of custom) for (const l of p.layers) byLayer.set(l, [...(byLayer.get(l) ?? []), p.id]);
    const boxes = new Map<string, Box>();
    for (const [layer, ids] of byLayer) {
      try {
        const polys = await board.padShapesAsPolygons(ids, layer);
        for (const [id, poly] of polys) {
          const pts: Vec2[] = [];
          for (const rp of polygonsOf({ polygons: [poly] } as PolySet)) pts.push(...rp);
          if (!pts.length) continue;
          const b = boxFromPoints(pts);
          const prev = boxes.get(id);
          boxes.set(id, prev ? boxUnion(prev, b) : b);
        }
      } catch (e) {
        warn(`GetPadShapeAsPolygon failed for custom pads on ${BoardLayer[layer]}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const p of custom) {
      const b = boxes.get(p.id);
      if (!b) continue;
      p.bounds = b;
      p.size = { x: b.w, y: b.h };
      p.rotation = 0;
    }
  }
  for (const p of routePads) if (p.layers.length === 0 && p.net) warn(`pad ${p.footprint}:${p.number} has no copper layer`);

  const routeTracks: RouteTrack[] = [];
  const routeVias: RouteVia[] = [];
  for (const t of tracks) {
    if (t instanceof Via) {
      const layers = copperLayersInOrder(t.layers);
      routeVias.push({
        id: t.id,
        net: t.net ?? "",
        netCode: t.netCode ?? 0,
        position: t.position,
        diameter: t.diameter,
        drill: t.drillDiameter,
        layers: layers.length ? layers : [...copperIds],
      });
    } else if (t instanceof Arc) {
      // Arcs become short chords (15° steps) so the obstacle model follows the sweep.
      const pts = arcPoints(t.start, t.mid, t.end, 15);
      for (let i = 1; i < pts.length; i++)
        routeTracks.push({
          id: t.id,
          net: t.net ?? "",
          netCode: t.netCode ?? 0,
          start: pts[i - 1]!,
          end: pts[i]!,
          width: t.width,
          layer: t.layerId,
        });
    } else if (t instanceof Track) {
      routeTracks.push({
        id: t.id,
        net: t.net ?? "",
        netCode: t.netCode ?? 0,
        start: t.start,
        end: t.end,
        width: t.width,
        layer: t.layerId,
      });
    }
  }
  for (const t of routeTracks) if (!t.netCode && t.net) t.netCode = codeByNet.get(t.net) ?? 0;
  for (const v of routeVias) if (!v.netCode && v.net) v.netCode = codeByNet.get(v.net) ?? 0;

  // --- zones -----------------------------------------------------------------------------------
  const keepouts: RouteKeepout[] = [];
  const routeZones: RouteZone[] = [];
  for (const z of zones) {
    const layers = copperLayersInOrder(z.layers);
    const polys = polygonsOf(z.outline);
    if (!polys.length) continue;
    if (z.zoneType === ZoneType.ZT_RULE_AREA || z.proto.settings.case === "ruleAreaSettings") {
      const ra = z.proto.settings.case === "ruleAreaSettings" ? z.proto.settings.value : undefined;
      if (!ra || (!ra.keepoutCopper && !ra.keepoutTracks && !ra.keepoutVias)) continue;
      for (const polygon of polys)
        keepouts.push({
          id: z.id,
          name: z.name,
          layers,
          polygon,
          tracks: ra.keepoutTracks,
          vias: ra.keepoutVias,
          copper: ra.keepoutCopper,
        });
    } else if (z.proto.settings.case === "copperSettings" && layers.length) {
      routeZones.push({
        id: z.id,
        name: z.name,
        net: z.net ?? "",
        netCode: z.netCode ?? 0,
        layers,
        polygon: polys[0]!,
        fills: z.filledPolygons.map((f) => ({ layer: f.layer, polygons: polygonsOf(f.shapes) })),
      });
    }
  }

  // --- copper text and graphics ----------------------------------------------------------------
  // Board-level texts/shapes and footprint graphics on copper layers block tracks; their exact
  // outlines are not needed, KiCad's bounding boxes are.
  const copperGraphics: { id: string; kind: RouteObstacle["kind"]; layer: BoardLayer; net: string }[] = [];
  for (const t of texts) if (isCopperLayer(t.layerId)) copperGraphics.push({ id: t.id, kind: "text", layer: t.layerId, net: "" });
  for (const s of shapes)
    if (isCopperLayer(s.layerId)) copperGraphics.push({ id: s.id, kind: "shape", layer: s.layerId, net: s.net ?? "" });
  for (const fp of footprints) {
    for (const item of fp.items) {
      const layer = item.layerId;
      if (layer === undefined || !isCopperLayer(layer) || !item.id || item instanceof Pad) continue;
      const kind = item instanceof BoardText || item instanceof BoardField ? "text" : item instanceof BoardShape ? "shape" : "other";
      copperGraphics.push({ id: item.id, kind, layer, net: "" });
    }
  }
  const obstacles: RouteObstacle[] = [];
  if (copperGraphics.length) {
    let boxes = new Map<string, Box>();
    try {
      boxes = await board.boundingBoxes(copperGraphics.map((g) => g.id));
    } catch (e) {
      warn(`GetBoundingBox failed for copper graphics: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const g of copperGraphics) {
      const b = boxes.get(g.id);
      if (!b || b.w <= 0 || b.h <= 0) continue;
      obstacles.push({ id: g.id, kind: g.kind, layers: [g.layer], bounds: b, net: g.net });
    }
  }

  // --- nets & rules ----------------------------------------------------------------------------
  const netNames = nets.map((n) => n.name).filter((n) => n.length > 0);
  const classes = netNames.length ? await board.netClassForNets(netNames) : new Map<string, NetClass>();
  const c = design.rules.constraints;
  const boardMin = {
    minClearance: nm(c?.minClearance),
    minTrackWidth: nm(c?.minTrackWidth),
    minViaDiameter: nm(c?.minViaSize),
    minViaDrill: nm(c?.minThroughDrill),
    edgeClearance: nm(c?.copperEdgeClearance),
    holeToHole: nm(c?.holeToHoleMin),
  };
  const hardFallback: RouteNetRules = {
    netClass: "Default",
    clearance: boardMin.minClearance || mm(0.2),
    trackWidth: boardMin.minTrackWidth || mm(0.2),
    viaDiameter: boardMin.minViaDiameter || mm(0.6),
    viaDrill: boardMin.minViaDrill || mm(0.3),
  };
  let defaultClass: NetClass | undefined;
  for (const cls of classes.values()) {
    if (cls.name === "Default") defaultClass = cls;
    defaultClass ??= cls;
  }
  const defaultRules = netRulesOf(defaultClass, hardFallback);
  const perNet = new Map<string, RouteNetRules>();
  for (const [name, cls] of classes) perNet.set(name, netRulesOf(cls, defaultRules));
  const rules: RouteRules = { ...boardMin, default: defaultRules, perNet };

  // --- connections (ratsnest) ------------------------------------------------------------------
  const layersById = new Map<string, BoardLayer[]>();
  for (const p of routePads) layersById.set(p.id, p.layers);
  for (const v of routeVias) layersById.set(v.id, v.layers);
  for (const t of routeTracks) layersById.set(t.id, [t.layer]);
  for (const z of routeZones) layersById.set(z.id, z.layers);
  const endpoint = (id: string, pos: Vec2): RouteEndpoint => ({ itemId: id, position: pos, layers: layersById.get(id) ?? [...copperIds] });
  const rats = await board.ratsnest(opts.nets ?? []);
  const wanted = opts.nets ? new Set(opts.nets) : undefined;
  const connections: RouteConnection[] = rats.edges
    .filter((e) => !wanted || wanted.has(e.net))
    .map((e) => ({
      net: e.net,
      netCode: e.netCode,
      from: endpoint(e.source, e.sourcePosition),
      to: endpoint(e.target, e.targetPosition),
      length: e.length,
    }));

  // --- bounds ----------------------------------------------------------------------------------
  let bounds: Box;
  if (outline.length) bounds = boxFromPoints(outline[0]!);
  else {
    const pts: Vec2[] = [];
    for (const p of routePads) pts.push(p.position);
    for (const t of routeTracks) pts.push(t.start, t.end);
    for (const v of routeVias) pts.push(v.position);
    bounds = pts.length ? boxFromPoints(pts) : { x: 0, y: 0, w: 0, h: 0 };
    if (routePads.length) {
      const maxPad = Math.max(...routePads.map((p) => Math.max(p.size.x, p.size.y)));
      bounds = boxUnion(bounds, { x: bounds.x - maxPad, y: bounds.y - maxPad, w: bounds.w + 2 * maxPad, h: bounds.h + 2 * maxPad });
    }
  }

  return {
    boardName: board.fileName,
    outline,
    bounds,
    copperLayers,
    nets: nets.map((n) => ({ name: n.name, code: n.code?.value ?? 0, netClass: classes.get(n.name)?.name ?? defaultRules.netClass })),
    pads: routePads,
    tracks: routeTracks,
    vias: routeVias,
    keepouts,
    zones: routeZones,
    obstacles,
    connections,
    rules,
  };
}

/** Rules for a net: its class's, or the default. */
export function rulesForNet(input: RouteInput, net: string): RouteNetRules {
  return input.rules.perNet.get(net) ?? input.rules.default;
}
