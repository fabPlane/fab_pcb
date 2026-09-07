/**
 * Specctra session (.ses) reader: the wires and vias Freerouting writes under `routes/network_out`,
 * converted to `NewTrack`/`NewVia` in nm on the board's layers. Used by the Freerouting adapter's
 * built-in import path (servers without `ImportSpecctraSession`) and for statistics on any session.
 */
import type { BoardLayer } from "@kicad-web/proto";
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
  const perUnit = UNIT_NM[unit ?? "um"] ?? 1_000;
  const n = Number(count ?? "1") || 1;
  return perUnit / n;
}

function pathOf(list: SExpr[], nmPerUnit: number): { layer: string; width: number; points: { x: number; y: number }[] } | undefined {
  // (path <layer> <aperture_width> x0 y0 x1 y1 ...)
  const layer = list[1];
  if (typeof layer !== "string") return undefined;
  const nums = list
    .slice(2)
    .filter((c): c is string => typeof c === "string")
    .map(Number);
  const width = nums.shift() ?? 0;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2)
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
      if (geom[0] === "circle") diameter = Math.round((Number(geom[2]) || 0) * nmPerUnit);
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
      const [padstack, x, y] = atoms(v);
      if (!padstack || x === undefined || y === undefined) continue;
      vias.push({ net: netName, padstack, x: Math.round(Number(x) * nmPerUnit), y: Math.round(-Number(y) * nmPerUnit) });
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
const ECHO_TOLERANCE = 10_000;

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
  const rulesFor = (net: string) => input.rules.perNet.get(net) ?? input.rules.default;
  const echoed = { tracks: 0, vias: 0 };
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.abs(a.x - b.x) <= ECHO_TOLERANCE && Math.abs(a.y - b.y) <= ECHO_TOLERANCE;
  const existingTracks = new Map<string, { start: { x: number; y: number }; end: { x: number; y: number } }[]>();
  for (const t of input.tracks) {
    const key = `${t.layer}\u0000${t.net}`;
    let list = existingTracks.get(key);
    if (!list) existingTracks.set(key, (list = []));
    list.push({ start: t.start, end: t.end });
  }
  const isEchoedTrack = (layer: BoardLayer, net: string, start: { x: number; y: number }, end: { x: number; y: number }) =>
    (existingTracks.get(`${layer}\u0000${net}`) ?? []).some(
      (t) => (near(t.start, start) && near(t.end, end)) || (near(t.start, end) && near(t.end, start)),
    );
  const isEchoedVia = (net: string, position: { x: number; y: number }) =>
    input.vias.some((v) => v.net === net && near(v.position, position));

  for (const w of session.wires) {
    const layer = layerByName.get(w.layer);
    if (layer === undefined) {
      warnOnce(`unknown layer "${w.layer}"`);
      continue;
    }
    const netCode = codes.get(w.net) ?? 0;
    const width = w.width || rulesFor(w.net).trackWidth;
    for (let i = 1; i < w.points.length; i++) {
      const start = w.points[i - 1]!;
      const end = w.points[i]!;
      if (start.x === end.x && start.y === end.y) continue;
      if (isEchoedTrack(layer, w.net, start, end)) {
        echoed.tracks++;
        continue;
      }
      tracks.push({ net: w.net, netCode, start, end, width, layer });
      routedNets.add(w.net);
    }
  }
  const allLayers = input.copperLayers.map((l) => l.id);
  for (const v of session.vias) {
    if (isEchoedVia(v.net, { x: v.x, y: v.y })) {
      echoed.vias++;
      continue;
    }
    const ps = session.padstacks.get(v.padstack);
    const rules = rulesFor(v.net);
    const m = /_(\d+):(\d+)_um$/.exec(v.padstack);
    const diameter = ps?.diameter || (m ? Number(m[1]) * 1000 : rules.viaDiameter);
    const drill = m ? Number(m[2]) * 1000 : rules.viaDrill;
    let layers = (ps?.layers ?? []).map((n) => layerByName.get(n)).filter((l): l is BoardLayer => l !== undefined);
    if (layers.length < 2) layers = allLayers;
    if (!ps) warnOnce(`via padstack "${v.padstack}" is not in library_out; using its name and the net class`);
    vias.push({ net: v.net, netCode: codes.get(v.net) ?? 0, position: { x: v.x, y: v.y }, diameter, drill, layers });
    routedNets.add(v.net);
  }
  if (echoed.tracks || echoed.vias)
    warnings.push(`${echoed.tracks} existing track(s) and ${echoed.vias} via(s) echoed by the session were not created again`);
  return { tracks, vias, warnings, routedNets, echoed };
}
