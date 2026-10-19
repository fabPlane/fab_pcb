/**
 * Specctra session (.ses) reader: the wires and vias Freerouting writes under `routes/network_out`,
 * converted to `NewTrack`/`NewVia` in nm on the board's layers. Used by the Freerouting adapter's
 * built-in import path (servers without `ImportSpecctraSession`) and for statistics on any session.
 */
import type { BoardLayer } from "@fp-pcb/proto";
import type { NewTrack, NewVia, RouteInput } from "../types";
import { atoms, child, children, head, isList, numbers, parseSExpr, type SExpr } from "./sexpr";

export interface SesVia {
  net: string;
  padstack: string;
  x: number;
  y: number;
}

export interface SesWire {
  net: string;
  layer: string;
  /** Width in nm. */
  width: number;
  /** Points in nm, board coordinates (y down). */
  points: { x: number; y: number }[];
}

export interface SesPadstack {
  name: string;
  /** Layer user names carrying a shape. */
  layers: string[];
  /** Circle diameter in nm (0 when the shape is not a circle). */
  diameter: number;
}

export interface Session {
  /** nm per session coordinate unit. */
  nmPerUnit: number;
  padstacks: Map<string, SesPadstack>;
  wires: SesWire[];
  vias: SesVia[];
  /** Nets named in `network_out`. */
  nets: string[];
  /** `(component ... (place REF x y side rot))` entries, when the router moved parts (rare). */
  placements: { component: string; reference: string; x: number; y: number; side: string; rotation: number }[];
}

const UNIT_NM: Record<string, number> = { um: 1_000, mm: 1_000_000, cm: 10_000_000, inch: 25_400_000, mil: 25_400 };

/** `(resolution um 10)` -> 100 nm per unit. */
export function resolutionToNm(res: SExpr[] | undefined): number {
  const [unit, count] = atoms(res);
  const name = unit ?? "um";
  if (!Object.hasOwn(UNIT_NM, name)) throw new SyntaxError(`unsupported session resolution unit: ${name}`);
  const n = Number(count ?? "1");
  const scale = UNIT_NM[name]! / n;
  // Invalid scales can mirror, collapse or mis-scale every imported copper item.
  // Keep the historical defaults only for omitted values, never malformed ones.
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(scale) || scale <= 0)
    throw new SyntaxError(`invalid session resolution count: ${count}`);
  return scale;
}

function pathOf(list: SExpr[], nmPerUnit: number): { layer: string; width: number; points: { x: number; y: number }[] } | undefined {
  // (path <layer> <aperture_width> x0 y0 x1 y1 ...)
  const layer = list[1];
  if (typeof layer !== "string") return undefined;
  const values = list.slice(2);
  // A path requires a width and at least two complete coordinate pairs.
  // Never drop nested values or a trailing coordinate: that silently changes copper.
  if (values.length < 5 || values.length % 2 !== 1 || values.some((v) => typeof v !== "string"))
    throw new SyntaxError("invalid session path coordinates");
  const nums = values.map(Number);
  const scaled = nums.map((v) => Math.round(v * nmPerUnit));
  if (nums.some((v) => !Number.isFinite(v)) || scaled.some((v) => !Number.isSafeInteger(v)) || scaled[0]! <= 0)
    throw new SyntaxError("invalid session path dimensions");
  const width = nums.shift()!;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < nums.length; i += 2)
    points.push({ x: Math.round(nums[i]! * nmPerUnit), y: Math.round(-nums[i + 1]! * nmPerUnit) });
  return { layer, width: Math.round(width * nmPerUnit), points };
}

export function parseSes(text: string): Session {
  const root = parseSExpr(text);
  const session = root.find((x) => head(x) === "session") as SExpr[] | undefined;
  if (!session) throw new SyntaxError("not a Specctra session: no (session ...) form");
  const routes = child(session, "routes");
  const nmPerUnit = resolutionToNm(child(routes, "resolution") ?? child(child(session, "placement"), "resolution"));

  const padstacks = new Map<string, SesPadstack>();
  for (const ps of children(child(routes, "library_out"), "padstack")) {
    const name = typeof ps[1] === "string" ? ps[1] : "";
    const layers: string[] = [];
    let diameter = 0;
    for (const shape of children(ps, "shape")) {
      const geom = shape[1];
      if (!isList(geom)) continue;
      const layer = geom[1];
      if (typeof layer === "string") layers.push(layer);
      if (geom[0] === "circle") {
        // A malformed explicit circle must never become an invalid via size or
        // silently select the name/net-class fallback reserved for absent circles.
        // Optional circle centers describe copper relative to the barrel. NewVia
        // cannot represent eccentric pads; moving the barrel would move its drill.
        const center = geom.slice(3);
        if (center.length !== 0 && (center.length !== 2 || center.some((v) => typeof v !== "string" || Number(v) !== 0)))
          throw new SyntaxError("unsupported session circle center");
        const value = typeof geom[2] === "string" ? Number(geom[2]) : NaN;
        const scaled = Math.round(value * nmPerUnit);
        if (!Number.isFinite(value) || !Number.isSafeInteger(scaled) || scaled <= 0)
          throw new SyntaxError("invalid session circle diameter");
        // NewVia has one diameter for the entire barrel. Taking the last
        // layer shape would silently enlarge or shrink copper on other layers.
        if (diameter !== 0 && diameter !== scaled)
          throw new SyntaxError("unsupported session via layer diameters");
        diameter = scaled;
      }
    }
    padstacks.set(name, { name, layers, diameter });
  }

  const wires: SesWire[] = [];
  const vias: SesVia[] = [];
  const nets: string[] = [];
  for (const net of children(child(routes, "network_out"), "net")) {
    const netName = typeof net[1] === "string" ? net[1] : "";
    nets.push(netName);
    for (const w of children(net, "wire")) {
      const path = child(w, "path");
      if (!path) continue; // (wire (polygon ...)) = plane echo; ignored
      const p = pathOf(path, nmPerUnit);
      if (p && p.points.length >= 2) wires.push({ net: netName, ...p });
    }
    for (const v of children(net, "via")) {
      // Read positional operands directly: filtering nested lists shifts coordinates.
      // Later attributes such as (type normal) do not affect the via position.
      const [, padstack, x, y] = v;
      if (typeof padstack !== "string" || !padstack || typeof x !== "string" || typeof y !== "string")
        throw new SyntaxError("invalid session via coordinates");
      const px = Math.round(Number(x) * nmPerUnit);
      const py = Math.round(-Number(y) * nmPerUnit);
      if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py))
        throw new SyntaxError("invalid session via dimensions");
      vias.push({ net: netName, padstack, x: px, y: py });
    }
  }

  const placements: Session["placements"] = [];
  const placement = child(session, "placement");
  const placeNm = resolutionToNm(child(placement, "resolution") ?? child(routes, "resolution"));
  for (const comp of children(placement, "component")) {
    const component = typeof comp[1] === "string" ? comp[1] : "";
    for (const place of children(comp, "place")) {
      const [reference, x, y, side, rot] = atoms(place);
      if (!reference) continue;
      placements.push({
        component,
        reference,
        x: Math.round(Number(x) * placeNm),
        y: Math.round(-Number(y) * placeNm),
        side: side ?? "front",
        rotation: Number(rot ?? 0),
      });
    }
  }
  return { nmPerUnit, padstacks, wires, vias, nets, placements };
}

export interface SesItems {
  tracks: NewTrack[];
  vias: NewVia[];
  /** Layer or padstack names the board does not have; the items were skipped. */
  warnings: string[];
  /** Nets that received at least one wire or via. */
  routedNets: Set<string>;
  /** Wires and vias the session echoed back from the board's existing copper (not created again). */
  echoed: { tracks: number; vias: number };
}

/** Existing copper is matched to the session's echo of it within this distance, nm. */
const ECHO_TOLERANCE = 100; // One KiCad/Freerouting DSN coordinate quantum, not a geometric proximity test.
const NAME_SIZE_TOLERANCE = 500; // Half of the whole-micrometre rounding in via padstack names.

/**
 * Turns a parsed session into board items for `input`'s layers and nets. Layer names are matched
 * by user name (`F.Cu`), then enum name (`BL_F_Cu`); via sizes come from the session's padstack
 * (`Via[0-1]_1200:600_um`), falling back to the net class. Freerouting writes the board's existing
 * (fixed) wires and vias into the session as well; those are recognised by layer, net and end
 * points against `input.tracks` / `input.vias` and skipped, so a partially routed board does not
 * get its tracks doubled.
 */
export function sesToItems(session: Session, input: RouteInput): SesItems {
  const layerByName = new Map<string, BoardLayer>();
  for (const l of input.copperLayers) {
    layerByName.set(l.userName, l.id);
    layerByName.set(l.name, l.id);
  }
  const codes = new Map(input.nets.map((n) => [n.name, n.code]));
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (m: string) => {
    if (!warned.has(m)) {
      warned.add(m);
      warnings.push(m);
    }
  };
  const tracks: NewTrack[] = [];
  const vias: NewVia[] = [];
  const routedNets = new Set<string>();
  const codeFor = (net: string): number => {
    const code = codes.get(net);
    if (code === undefined) throw new SyntaxError(`unknown session net: ${net}`);
    return code;
  };
  const rulesFor = (net: string) => input.rules.perNet.get(net) ?? input.rules.default;
  const echoed = { tracks: 0, vias: 0 };
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) <= ECHO_TOLERANCE && Math.abs(a.y - b.y) <= ECHO_TOLERANCE;
  const existingTracks = new Map<string, RouteInput["tracks"]>();
  for (const t of input.tracks) {
    const key = `${t.layer}\u0000${t.net}`;
    let list = existingTracks.get(key);
    if (!list) existingTracks.set(key, (list = []));
    if (!t.collisionGeometryUnsupported) list.push(t);
  }
  const isEchoedTrack = (layer: BoardLayer, net: string, start: { x: number; y: number }, end: { x: number; y: number }, width: number) =>
    (existingTracks.get(`${layer}\u0000${net}`) ?? []).some(
      (t) =>
        Math.abs(t.width - width) <= ECHO_TOLERANCE &&
        ((near(t.start, start) && near(t.end, end)) || (near(t.start, end) && near(t.end, start))),
    );
  const isEchoedVia = (
    net: string,
    position: { x: number; y: number },
    diameter: number,
    drill: number,
    layers: BoardLayer[],
    sizeTolerance = { diameter: ECHO_TOLERANCE, drill: ECHO_TOLERANCE },
  ) =>
    input.vias.some(
      (v) =>
        v.net === net &&
        near(v.position, position) &&
        Math.abs(v.diameter - diameter) <= sizeTolerance.diameter &&
        Math.abs(v.drill - drill) <= sizeTolerance.drill &&
        v.layers.length === layers.length &&
        v.layers.every((l) => layers.includes(l)),
    );

  for (const w of session.wires) {
    const layer = layerByName.get(w.layer);
    if (layer === undefined) {
      warnOnce(`unknown layer "${w.layer}"`);
      continue;
    }
    const netCode = codeFor(w.net);
    const width = w.width || rulesFor(w.net).trackWidth;
    for (let i = 1; i < w.points.length; i++) {
      const start = w.points[i - 1]!;
      const end = w.points[i]!;
      if (start.x === end.x && start.y === end.y) continue;
      if (isEchoedTrack(layer, w.net, start, end, width)) {
        echoed.tracks++;
        continue;
      }
      tracks.push({ net: w.net, netCode, start, end, width, layer });
      routedNets.add(w.net);
    }
  }
  const allLayers = input.copperLayers.map((l) => l.id);
  for (const v of session.vias) {
    const netCode = codeFor(v.net);
    const ps = session.padstacks.get(v.padstack);
    const rules = rulesFor(v.net);
    const m = /_(\d+):(\d+)_um$/.exec(v.padstack);
    const diameter = ps?.diameter || (m ? Number(m[1]) * 1000 : rules.viaDiameter);
    const drill = m ? Number(m[2]) * 1000 : rules.viaDrill;
    // Validate every dimension source, including encoded names and net-class fallback,
    // before echo matching or creation can accept physically impossible barrels.
    if (!Number.isSafeInteger(diameter) || !Number.isSafeInteger(drill) || drill <= 0 || diameter <= drill)
      throw new SyntaxError("invalid session via diameter or drill");
    // Never discard a declared layer and then broaden the barrel to all layers.
    // Missing padstack metadata may use the legacy fallback; unsupported metadata cannot.
    if (ps?.layers.some((name) => !layerByName.has(name)))
      throw new SyntaxError("unknown session via layer");
    let layers = [...new Set((ps?.layers ?? []).map((name) => layerByName.get(name)!))];
    // Repeated shapes and aliases do not create a barrel between distinct layers.
    // A declared single-layer padstack must not become a through via.
    if (layers.length === 1) throw new SyntaxError("session via requires two distinct layers");
    if (layers.length === 0) layers = allLayers;
    // Padstack names carry whole micrometres (`viaPadstackName`), so a size read from the name can
    // be up to 500 nm off the native via (e.g. a 0.3048 mm drill is named 305 um).
    const sizeTolerance = {
      diameter: !ps?.diameter && m ? NAME_SIZE_TOLERANCE : ECHO_TOLERANCE,
      drill: m ? NAME_SIZE_TOLERANCE : ECHO_TOLERANCE,
    };
    if (isEchoedVia(v.net, { x: v.x, y: v.y }, diameter, drill, layers, sizeTolerance)) {
      echoed.vias++;
      continue;
    }
    if (!ps) warnOnce(`via padstack "${v.padstack}" is not in library_out; using its name and the net class`);
    vias.push({ net: v.net, netCode, position: { x: v.x, y: v.y }, diameter, drill, layers });
    routedNets.add(v.net);
  }
  if (echoed.tracks || echoed.vias)
    warnings.push(`${echoed.tracks} existing track(s) and ${echoed.vias} via(s) echoed by the session were not created again`);
  return { tracks, vias, warnings, routedNets, echoed };
}
