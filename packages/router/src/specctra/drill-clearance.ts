import type { RouteInput } from "../types";
import { child, children, parseSExpr, quote, type SExpr } from "./sexpr";

/** Freerouting pin = multilayer pad, smd = single-layer pad. Spacing is measured
 * from copper envelopes; subtract conservative annular copper from drill floors.
 * Class-class rules are necessary: per-net classes otherwise lose global item typing.
 */
export function drillClearanceDsn(text: string, input: RouteInput): string {
  const hole = input.rules.holeClearance ?? 0;
  const holes = input.rules.holeToHole;
  if (!hole && !holes) return text;
  const tree = parseSExpr(text);
  const pcb = tree.find(n => Array.isArray(n) && n[0] === "pcb") as SExpr[];
  const structure = child(pcb, "structure")!;
  const network = child(pcb, "network")!;
  const unit = String(child(pcb, "unit")?.[1] ?? child(pcb, "resolution")?.[1] ?? "um");
  const scale = ({ um: 1000, mm: 1e6, mil: 25400, inch: 25400000 } as Record<string, number>)[unit];
  if (!scale) throw new Error(`unsupported DSN unit ${unit}`);
  // Subtract only copper known to surround the drill. Unsupported/asymmetric pad
  // geometry gets zero credit. Minima span all padstacks, including protected vias.
  const pinRings = input.pads.filter(p => p.through && !p.nonPlated).map(p =>
    p.collisionGeometryUnsupported || p.shape === "custom" ? 0 : Math.max(0,
      Math.min(p.size.x - (p.drillSize?.x ?? p.drill), p.size.y - (p.drillSize?.y ?? p.drill)) / 2));
  const viaRings = [...input.rules.perNet.values(), input.rules.default, ...input.vias].map(v =>
    Math.max(0, (("viaDiameter" in v ? v.viaDiameter : v.diameter) - ("viaDrill" in v ? v.viaDrill : v.drill)) / 2));
  const ring: Record<string, number> = { wire: 0, smd: 0, area: 0, pin: pinRings.length ? Math.min(...pinRings) : 0, via: Math.min(...viaRings) };
  // NPTH has no routing endpoint. Keepout geometry represents the drill independently
  // of any pad copper; a circumscribed circle conservatively covers oval drills.
  const copper = input.rules.default.clearance;
  for (const pad of input.pads.filter(p => p.nonPlated && p.drill > 0)) {
    const diameter = Math.max(pad.drillSize?.x ?? pad.drill, pad.drillSize?.y ?? pad.drill) + 2 * Math.max(0, Math.max(hole, holes) - copper);
    for (const layer of children(structure, "layer")) structure.push(["keepout", `fabdesk-drill-${pad.id}`, ["circle", String(layer[1]), String(diameter / scale), String(pad.position.x / scale), String(-pad.position.y / scale)]]);
  }
  const pairs = ["wire_pin", "wire_via", "smd_pin", "smd_via", "area_pin", "area_via", "pin_pin", "pin_via", "via_via"];
  const rules = (copper: number): SExpr[][] => pairs.map(pair => {
    const [a, b] = pair.split("_") as [string, string];
    const drilledA = a === "pin" || a === "via", drilledB = b === "pin" || b === "via";
    return ["clearance", String(Math.max(copper, hole - Math.min(...[...(drilledA ? [ring[a]!] : []), ...(drilledB ? [ring[b]!] : [])]), drilledA && drilledB ? holes - ring[a]! - ring[b]! : 0) / scale), ["type", pair]];
  });
  child(structure, "rule")!.push(...rules(input.rules.default.clearance));
  const classes = children(network, "class");
  for (const cls of classes) {
    const rule = child(cls, "rule");
    if (!rule) continue;
    const copper = Number(child(rule, "clearance")?.[1] ?? input.rules.default.clearance / scale) * scale;
    rule.push(...rules(copper));
  }
  // Include default for unassigned NPTH pads. Use two classes per entry because
  // the pinned parser consumes its class iterator while visiting pairs.
  const classCopper = new Map(classes.map(c => [String(c[1]), Number(child(child(c, "rule"), "clearance")?.[1] ?? copper / scale) * scale]));
  const names = [...new Set(["kicad_default", ...classes.map(c => String(c[1]))])];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
    network.push(["class_class", ["classes", names[i]!, names[j]!], ["rule", ...rules(Math.max(copper, classCopper.get(names[i]!) ?? copper, classCopper.get(names[j]!) ?? copper))]]);
  const emit = (n: SExpr): string => typeof n === "string" ? quote(n) : n[0] === "string_quote" ? '(string_quote ")' : `(${n.map(emit).join(" ")})`;
  return tree.map(emit).join("\n") + "\n";
}
