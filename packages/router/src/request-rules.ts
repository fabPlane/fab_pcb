/** Explicit request overlays. No widths are inferred from existing copper. */
import type { RouteInput, RouteOptions, RouteNetRules } from "./types";
import { rulesForNet } from "./extract";

export function applyRequestRules(input: RouteInput, opts: RouteOptions): string[] {
  if (
    !opts.perNet?.length &&
    !opts.differentialPairs?.length &&
    [opts.trackWidthMm, opts.clearanceMm, opts.viaDiameterMm, opts.viaDrillMm, opts.viaDiameterNm, opts.viaDrillNm].every(
      (v) => v === undefined,
    )
  )
    return [];
  const known = new Set(input.nets.map((n) => n.name));
  const perNet = opts.perNet ?? [];
  const pairs = opts.differentialPairs ?? [];
  const bad = [...perNet.map((r) => r.net), ...pairs.flatMap((p) => [p.p, p.n])].filter((n) => !known.has(n));
  if (bad.length) throw new Error(`unknown routing rule nets: ${[...new Set(bad)].join(", ")}`);
  if (new Set(perNet.map((r) => r.net)).size !== perNet.length) throw new Error("duplicate per-net routing rules");
  const members = new Set<string>();
  for (const p of pairs) {
    if (p.p === p.n || members.has(p.p) || members.has(p.n)) throw new Error(`invalid or overlapping pair ${p.p}/${p.n}`);
    members.add(p.p);
    members.add(p.n);
    for (const n of [p.p, p.n]) {
      const w = perNet.find((r) => r.net === n)?.widthMm;
      if (w !== undefined && p.widthMm !== undefined && w !== p.widthMm) throw new Error(`conflicting pair width for ${n}`);
    }
    for (const v of [p.gapMm, p.skewToleranceMm])
      if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new Error(`invalid pair dimensions ${p.p}/${p.n}`);
  }
  const logs: string[] = [];
  const positive = (v: number | undefined) => v === undefined || (Number.isFinite(v) && v > 0);
  for (const n of input.nets) {
    const own = perNet.find((r) => r.net === n.name);
    const pair = pairs.find((p) => p.p === n.name || p.n === n.name);
    const width = own?.widthMm ?? pair?.widthMm ?? opts.trackWidthMm;
    const diameter = own?.viaDiameterMm ?? opts.viaDiameterMm ?? (opts.viaDiameterNm === undefined ? undefined : opts.viaDiameterNm / 1e6);
    const drill = own?.viaDrillMm ?? opts.viaDrillMm ?? (opts.viaDrillNm === undefined ? undefined : opts.viaDrillNm / 1e6);
    if (![width, diameter, drill].every(positive)) throw new Error(`invalid routing dimensions for ${n.name}`);
    if (opts.clearanceMm !== undefined && (!Number.isFinite(opts.clearanceMm) || opts.clearanceMm < 0))
      throw new Error("invalid routing clearance");
    if ([width, diameter, drill, opts.clearanceMm].every((v) => v === undefined)) continue;
    const r: RouteNetRules = { ...rulesForNet(input, n.name), netClass: `fabdesk_net_${n.code}` };
    const set = (key: "trackWidth" | "viaDiameter" | "viaDrill" | "clearance", v: number | undefined, min: number) => {
      if (v === undefined) return;
      const requested = Math.round(v * 1e6),
        effective = Math.max(requested, min);
      r[key] = effective;
      if (effective !== requested) logs.push(`rule ${n.name}.${key}: requested ${requested} nm → ${effective} nm (board minimum)`);
    };
    set("trackWidth", width, input.rules.minTrackWidth);
    set("viaDiameter", diameter, input.rules.minViaDiameter);
    set("viaDrill", drill, input.rules.minViaDrill);
    set("clearance", opts.clearanceMm, input.rules.minClearance);
    if (r.viaDrill >= r.viaDiameter) throw new Error(`via drill must be smaller than diameter for ${n.name}`);
    input.rules.perNet.set(n.name, r);
    logs.push(`effective rule ${n.name}: ${JSON.stringify(r)} (nm)`);
  }
  input.differentialPairs = pairs;
  for (const p of pairs) logs.push(`pair ${JSON.stringify(p)}: declared request metadata`);
  return logs;
}
