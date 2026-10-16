/** KiCad identifies members by net name; dimensions come from their native netclass first. */
import { nm } from "@fp-pcb/client";
import type { NetClass } from "@fp-pcb/proto";
import type { DifferentialPair } from "./types";
export function detectDifferentialPairs(names: readonly string[], classes: ReadonlyMap<string, NetClass> = new Map()): DifferentialPair[] {
  const known = new Set(names),
    used = new Set<string>(),
    pairs: DifferentialPair[] = [];
  for (const p of names) {
    if (used.has(p)) continue;
    for (const [positive, negative] of [
      ["_P", "_N"],
      ["+", "-"],
      ["DP", "DN"],
    ]) {
      if (!p.endsWith(positive!)) continue;
      const n = p.slice(0, -positive!.length) + negative!;
      if (!known.has(n) || used.has(n)) continue;
      // KiCad serializes these fields on every class. Only a name targeting this pair
      // or explicitly describing differential/pair signals supplies native pair dimensions.
      const pairClass = (net: string) => {
        const c = classes.get(net);
        if (!c) return undefined;
        const key = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
        const stem = p
          .replace(/(?:_P|\+|P)$/, "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        return /(?:^|[^a-z])(?:diff(?:erential)?|pairs?)(?:$|[^a-z])/i.test(c.name) ||
          (!["default", "power", "signal", "signals"].includes(key) && key.length >= 2 && stem.includes(key))
          ? c.board
          : undefined;
      };
      const pc = pairClass(p),
        nc = pairClass(n);
      const width = pc?.diffPairTrackWidth ?? nc?.diffPairTrackWidth;
      const gap = pc?.diffPairGap ?? nc?.diffPairGap;
      pairs.push({ p, n, ...(width && nm(width) > 0 ? { widthMm: nm(width) / 1e6 } : {}), ...(gap ? { gapMm: nm(gap) / 1e6 } : {}) });
      used.add(p);
      used.add(n);
      break;
    }
  }
  return pairs;
}
