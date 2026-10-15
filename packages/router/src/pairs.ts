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
      const pc = classes.get(p)?.board,
        nc = classes.get(n)?.board;
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
