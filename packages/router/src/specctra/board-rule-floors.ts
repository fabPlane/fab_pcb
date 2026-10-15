import type { RouteInput, RouteNetRules } from "../types";

/** Freerouting has copper item clearances, not KiCad's independent drill constraints.
 * Conservatively floor copper spacing at the drill clearances. Native pre-apply DRC remains
 * necessary for custom rules and geometry the DSN cannot represent.
 */
export function freeroutingRuleInput(input: RouteInput): RouteInput {
  const minimums = input.rules;
  const floor = (r: RouteNetRules): RouteNetRules => {
    const viaDrill = Math.max(r.viaDrill, minimums.minViaDrill);
    return {
      ...r,
      clearance: Math.max(r.clearance, minimums.minClearance, minimums.holeClearance ?? 0, minimums.holeToHole),
      trackWidth: Math.max(r.trackWidth, minimums.minTrackWidth),
      viaDrill,
      viaDiameter: Math.max(r.viaDiameter, minimums.minViaDiameter, viaDrill + 2 * (minimums.minViaAnnularWidth ?? 0)),
    };
  };
  return {
    ...input,
    rules: { ...minimums, default: floor(minimums.default), perNet: new Map([...minimums.perNet].map(([net, r]) => [net, floor(r)])) },
  };
}
