/** Overlay explicit rules on KiCad-exported DSN, preserving network pins and geometry. */
import type { RouteInput } from "../types";
import { viaPadstackName } from "./dsn";
import { parseSExpr, child, children, atoms, quote, type SExpr } from "./sexpr";

export function overlayDsnRules(text: string, input: RouteInput): string {
  const tree = parseSExpr(text),
    pcb = tree.find((n) => Array.isArray(n) && n[0] === "pcb") as SExpr[] | undefined;
  if (!pcb) throw new Error("DSN has no pcb");
  const network = child(pcb, "network"),
    library = child(pcb, "library"),
    structure = child(pcb, "structure");
  if (!network || !library || !structure) throw new Error("DSN lacks network/library/structure for rule overlay");
  const unit = String(child(pcb, "unit")?.[1] ?? child(pcb, "resolution")?.[1] ?? "um");
  const nmPerUnit: Record<string, number> = { um: 1000, mm: 1e6, mil: 25400, inch: 25400000 };
  const scale = nmPerUnit[unit];
  if (!scale) throw new Error(`unsupported DSN unit ${unit}`);
  const value = (nm: number) => String(nm / scale);
  const known = new Set(children(network, "net").map((n) => String(n[1])));
  const overridden = new Set([...input.rules.perNet.keys()].filter((n) => known.has(n)));
  // Remove overridden memberships from old classes so no exporter class competes with ours.
  for (const cls of children(network, "class")) {
    for (let i = cls.length - 1; i >= 2; i--) if (typeof cls[i] === "string" && overridden.has(String(cls[i]))) cls.splice(i, 1);
  }
  const layers = children(structure, "layer").map((n) => String(n[1]));
  const viaList = child(structure, "via");
  if (!viaList) throw new Error("DSN has no via declaration for rule overlay");
  let i = 0;
  const existingClasses = new Set(children(network, "class").map((n) => String(n[1])));
  const existingStacks = new Set(children(library, "padstack").map((n) => String(n[1])));
  for (const [net, r] of input.rules.perNet) {
    if (!known.has(net)) continue;
    let name: string;
    const viaName = viaPadstackName(r.viaDiameter, r.viaDrill, layers.length);
    do {
      name = `fabdesk_rule_${i++}`;
    } while (existingClasses.has(name) || existingStacks.has(name));
    if (!existingStacks.has(viaName))
      library.push([
        "padstack",
        viaName,
        ...layers.map((l) => ["shape", ["circle", l, value(r.viaDiameter)]] as SExpr[]),
        ["attach", "off"],
      ]);
    existingStacks.add(viaName);
    if (!viaList.includes(viaName)) viaList.push(viaName);
    network.push([
      "class",
      name,
      net,
      ["circuit", ["use_via", viaName]],
      ["rule", ["width", value(r.trackWidth)], ["clearance", value(r.clearance)]],
    ]);
  }
  const emit = (n: SExpr): string =>
    typeof n === "string" ? quote(n) : n[0] === "string_quote" ? '(string_quote ")' : `(${n.map(emit).join(" ")})`;
  return tree.map(emit).join("\n");
}
