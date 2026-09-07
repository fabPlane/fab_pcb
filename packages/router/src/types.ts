/**
 * The router contract (docs/06-routing.md): every autorouter — the JS one, Freerouting, anything
 * added later — takes a `RouteInput` built from a `Board` by `extractRouteInput()` and returns a
 * `RouteResult` that `applyRouteResult()` turns into one `CreateItems` commit. Nothing in this
 * file knows about protobuf; lengths are plain `number` nanometres (the client's convention) and
 * angles are degrees, so a router can be unit-tested on hand-written inputs.
 */
import type { BoardLayer } from "@fp-pcb/proto";
import type { Box, Vec2 } from "@fp-pcb/client";

/** One copper layer the router may use. `index` counts from the top (F.Cu = 0, B.Cu = last). */
export interface RouteLayer {
  id: BoardLayer;
  /** Enum name, e.g. `BL_F_Cu`. */
  name: string;
  /** User-visible name, e.g. `F.Cu` (renamed layers keep their user name). */
  userName: string;
  index: number;
}

export interface RouteNet {
  name: string;
  code: number;
  netClass: string;
}

export type RoutePadShape = "circle" | "rect" | "oval" | "roundrect" | "trapezoid" | "chamferedrect" | "custom";

/** A pad as an obstacle and a connection target. Position and size are absolute (footprint transform applied). */
export interface RoutePad {
  id: string;
  /** Reference of the footprint the pad belongs to (`R1`). */
  footprint: string;
  number: string;
  net: string;
  netCode: number;
  position: Vec2;
  /** Size on the first copper layer entry of the pad stack. */
  size: Vec2;
  shape: RoutePadShape;
  /** Absolute rotation, degrees. */
  rotation: number;
  /** Copper layers with copper for this pad (through-hole pads list every copper layer). */
  layers: BoardLayer[];
  /** Plated through hole: connects on every copper layer. */
  through: boolean;
  /** Drill diameter in nm (0 for SMD). */
  drill: number;
  /** Pad-level clearance override in nm, when set. */
  clearance?: number;
  /**
   * Absolute bounding box of the copper, nm. Set for custom-shaped pads (whose `size` is only the
   * anchor); routers should prefer it over `size`/`rotation` when present.
   */
  bounds?: Box;
}

export interface RouteTrack {
  id: string;
  net: string;
  netCode: number;
  start: Vec2;
  end: Vec2;
  width: number;
  layer: BoardLayer;
}

export interface RouteVia {
  id: string;
  net: string;
  netCode: number;
  position: Vec2;
  diameter: number;
  drill: number;
  /** Copper layers the via spans (start layer first). */
  layers: BoardLayer[];
}

/** A closed polygon in nm; arcs of the source shape are approximated by their end points. */
export type RoutePolygon = Vec2[];

export interface RouteKeepout {
  id: string;
  name: string;
  layers: BoardLayer[];
  polygon: RoutePolygon;
  tracks: boolean;
  vias: boolean;
  copper: boolean;
}

/** A copper zone: same-net items may cross it, other nets must clear its filled copper. */
export interface RouteZone {
  id: string;
  name: string;
  net: string;
  netCode: number;
  layers: BoardLayer[];
  polygon: RoutePolygon;
  /** Filled polygons per layer, when the zone has been filled (empty on an unrouted board). */
  fills: { layer: BoardLayer; polygons: RoutePolygon[] }[];
}

/** Other copper that is not a pad, track or via: text, graphic shapes, footprint graphics on copper layers. */
export interface RouteObstacle {
  id: string;
  kind: "text" | "shape" | "other";
  layers: BoardLayer[];
  /** Axis-aligned bounding box, nm. */
  bounds: Box;
  net: string;
}

/** One end of an unrouted connection: the copper item the ratsnest edge touches. */
export interface RouteEndpoint {
  itemId: string;
  position: Vec2;
  /** Copper layers the item can be reached on (all copper layers for through-hole pads / vias / zones). */
  layers: BoardLayer[];
}

/** One ratsnest edge (`GetRatsnest`): what the router has to connect. */
export interface RouteConnection {
  net: string;
  netCode: number;
  from: RouteEndpoint;
  to: RouteEndpoint;
  /** Straight-line length, nm. */
  length: number;
}

/** Per-net-class routing rules, nm. */
export interface RouteNetRules {
  netClass: string;
  clearance: number;
  trackWidth: number;
  viaDiameter: number;
  viaDrill: number;
}

export interface RouteRules {
  /** Board minimums (`GetBoardDesignRules.constraints`). */
  minClearance: number;
  minTrackWidth: number;
  minViaDiameter: number;
  minViaDrill: number;
  /** Copper-to-board-edge clearance, nm. */
  edgeClearance: number;
  holeToHole: number;
  /** The default net class: what nets without a class of their own get. */
  default: RouteNetRules;
  /** Rules per net name (only nets whose class differs from `default` need an entry, but every net may have one). */
  perNet: Map<string, RouteNetRules>;
}

/** Everything a router needs, extracted once from the board. */
export interface RouteInput {
  boardName: string;
  /** Board outline polygons from Edge.Cuts (first = outer boundary). Empty when the board has none. */
  outline: RoutePolygon[];
  /** Bounding box of the outline, or of every copper item when there is no outline. */
  bounds: Box;
  /** Copper layers enabled on the board, top to bottom. */
  copperLayers: RouteLayer[];
  nets: RouteNet[];
  pads: RoutePad[];
  tracks: RouteTrack[];
  vias: RouteVia[];
  keepouts: RouteKeepout[];
  zones: RouteZone[];
  /** Copper text and graphics (bounding boxes) that tracks must clear. */
  obstacles: RouteObstacle[];
  connections: RouteConnection[];
  rules: RouteRules;
}

export interface RouteOptions {
  /** Copper layers the router may route on; default: every enabled copper layer. */
  layers?: BoardLayer[];
  /** Relative cost of a via versus 1 mm of track (router-specific scale; 1 = neutral). */
  viaCost?: number;
  /** Give up after this long and return what has been routed so far. */
  maxTimeMs?: number;
  /** Only route these nets (names); others stay as they are and act as obstacles. */
  nets?: string[];
  /** Seed for routers that randomise; the same seed gives the same result. */
  seed?: number;
  /** Router effort / passes (JS router: `effort`, Freerouting: `-mp` max passes). */
  effort?: number;
  /** Anything router-specific; each adapter documents what it reads. */
  extra?: Record<string, unknown>;
  /**
   * Cancels the run: the JS router stops at its next step, Freerouting's process is killed. The
   * adapter rejects with a `RouteCancelled` error and nothing is applied.
   */
  signal?: AbortSignal;
}

/** Thrown by `Autorouter.route` when `RouteOptions.signal` fires. */
export class RouteCancelled extends Error {
  constructor(message = "routing cancelled") {
    super(message);
    this.name = "RouteCancelled";
  }
  static is(e: unknown): e is RouteCancelled {
    return e instanceof Error && e.name === "RouteCancelled";
  }
}

export interface RouteProgress {
  /** Router-defined phase name (`"mesh"`, `"pass 3"`, `"import"`, ...). */
  phase: string;
  /** 0..100 when known. */
  percent?: number;
  /** Connections routed so far / total, when the router reports it. */
  routed?: number;
  total?: number;
  message?: string;
}

/** A track to create. */
export interface NewTrack {
  net: string;
  netCode: number;
  start: Vec2;
  end: Vec2;
  width: number;
  layer: BoardLayer;
}

/** A via to create (through via from `layers[0]` to `layers[layers.length-1]`). */
export interface NewVia {
  net: string;
  netCode: number;
  position: Vec2;
  diameter: number;
  drill: number;
  layers: BoardLayer[];
}

export interface RouteResult {
  router: string;
  tracks: NewTrack[];
  vias: NewVia[];
  /** Connections the router did not route (as it reports them; the bench re-measures with `GetRatsnest`). */
  unrouted: RouteConnection[];
  /** Connections given to the router (after the `nets` filter). */
  totalConnections: number;
  /** True when the router stopped because of `maxTimeMs`. */
  timedOut: boolean;
  elapsedMs: number;
  /** The router's own log lines (Freerouting stdout, solver phases, warnings about approximations). */
  log: string[];
}

/** The binding interface from docs/06-routing.md. */
export interface Autorouter {
  name: string;
  route(input: RouteInput, opts: RouteOptions, progress?: (p: RouteProgress) => void): Promise<RouteResult>;
  /** Whether this router can run here (Java + jar present, API commands available, ...). */
  available?(): Promise<{ ok: boolean; reason?: string }>;
}
