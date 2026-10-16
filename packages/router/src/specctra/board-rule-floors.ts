import type { RouteInput, RouteNetRules } from "../types";

/** Copper floors stay independent of drill constraints; DSN item classes carry drill spacing. */
export function freeroutingRuleInput(input: RouteInput): RouteInput {
  const minimums = input.rules;
  const floor = (r: RouteNetRules): RouteNetRules => {
    const viaDrill = Math.max(r.viaDrill, minimums.minViaDrill);
    return {
      ...r,
      clearance: Math.max(r.clearance, minimums.minClearance),
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
