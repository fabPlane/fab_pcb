import type { RouteInput } from "../types";
import { child, children, parseSExpr, quote, type SExpr } from "./sexpr";

/** Freerouting pin = multilayer pad, smd = single-layer pad. Spacing is measured
 * from copper envelopes, so using the hole floor on drilled copper is conservative.
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
  const pairs = ["wire_pin", "wire_via", "smd_pin", "smd_via", "area_pin", "area_via", "pin_pin", "pin_via", "via_via"];
  const rules = (copper: number): SExpr[][] => pairs.map(pair => ["clearance", String(Math.max(copper, hole, pair.startsWith("pin_") || pair === "via_via" ? holes : 0) / scale), ["type", pair]]);
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
  const names = [...new Set(["kicad_default", ...classes.map(c => String(c[1]))])];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
    network.push(["class_class", ["classes", names[i]!, names[j]!], ["rule", ...rules(input.rules.default.clearance)]]);
  const emit = (n: SExpr): string => typeof n === "string" ? quote(n) : n[0] === "string_quote" ? '(string_quote ")' : `(${n.map(emit).join(" ")})`;
  return tree.map(emit).join("\n") + "\n";
}
