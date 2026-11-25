import { RuleSeverity } from "@fp-pcb/proto";

type Marker = { severity: RuleSeverity; excluded: boolean; description: string };

/**
 * The marker descriptions quoted in an "N ERC error(s)" diagnostic. `errorCount` counts error
 * severity only, so the quoted markers must too: a warning listed here (a library mismatch, a
 * footprint link) reads as a reason the build was rejected when it is not one.
 */
export function ercErrorDetail(markers: readonly Marker[], limit = 10): string {
  const errors = markers.filter((marker) => !marker.excluded && marker.severity === RuleSeverity.RS_ERROR);
  const shown = errors
    .slice(0, limit)
    .map((marker) => marker.description)
    .join("; ");
  return errors.length > limit ? `${shown}; and ${errors.length - limit} more` : shown;
}
