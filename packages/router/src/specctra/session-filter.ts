/** Additive imports may create only new routing copper, never the protected input's echo. */
import type { RouteInput } from "../types";
import { parseSes, sesToItems } from "./ses";
import { child, children, head, parseSExpr, type SExpr } from "./sexpr";

/** Keep library/resolution metadata; split polylines so an echoed segment cannot be appended. */
export function filterSessionCopper(text: string, input: RouteInput, nets?: string[]): string {
  const tree = parseSExpr(text);
  const session = tree.find((n) => head(n) === "session") as SExpr[] | undefined;
  const routes = child(session, "routes");
  const network = child(routes, "network_out");
  if (!session || !routes || !network) throw new Error("session lacks routes/network_out");
  const parsed = parseSes(text);
  const wanted = nets?.length ? new Set(nets) : undefined;
  const scale = parsed.nmPerUnit;
  const coordinate = (n: number) => String(n / scale);
  const filtered: SExpr[] = ["network_out"];
  for (const net of children(network, "net")) {
    const name = String(net[1]);
    if (wanted && !wanted.has(name)) continue;
    const output: SExpr[] = ["net", name];
    for (const wire of children(net, "wire")) {
      const path = child(wire, "path");
      if (!path) {
        if (child(wire, "polygon") || child(wire, "poly")) continue; // Native zones already exist.
        throw new Error("unsupported session wire shape; cannot safely filter additive import");
      }
      const wires = parsed.wires.filter((w) => w.net === name);
      const index = children(net, "wire")
        .filter((w) => child(w, "path"))
        .indexOf(wire);
      const w = wires[index];
      if (!w) throw new Error("session wire cannot be decoded");
      const items = sesToItems({ ...parsed, wires: [w], vias: [] }, input);
      if (items.warnings.some((s) => s.startsWith("unknown layer"))) throw new Error(items.warnings.join("; "));
      for (const t of items.tracks) {
        output.push([
          "wire",
          ["path", w.layer, coordinate(t.width), coordinate(t.start.x), coordinate(-t.start.y), coordinate(t.end.x), coordinate(-t.end.y)],
          ...wire.slice(1).filter((n) => n !== path),
        ]);
      }
    }
    const vias = parsed.vias.filter((v) => v.net === name);
    for (const [i, via] of children(net, "via").entries()) {
      const v = vias[i];
      if (!v) throw new Error("session via cannot be decoded");
      if (sesToItems({ ...parsed, wires: [], vias: [v] }, input).vias.length) output.push(via);
    }
    if (output.length > 2) filtered.push(output);
  }
  routes[routes.indexOf(network)] = filtered;
  // Routing does not authorize placement changes; builtin exports use synthetic pad components.
  const placement = child(session, "placement");
  if (placement) session.splice(session.indexOf(placement), 1);
  const emit = (n: SExpr): string =>
    typeof n === "string" ? (/^[^\s()"\\]+$/.test(n) ? n : JSON.stringify(n)) : `(${n.map(emit).join(" ")})`;
  return tree.map(emit).join("\n") + "\n";
}
