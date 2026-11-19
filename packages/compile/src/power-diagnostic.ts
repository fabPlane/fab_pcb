/** Explain KiCad's actual power failures using the generated sheet's absolute pin positions. */
import { ErcErrorType, RuleSeverity, type ErcMarker } from "@fp-pcb/proto";
import { vec2 } from "@fp-pcb/client";
import type { PlacedPin } from "./schematic";
import type { Diagnostic, Netlist } from "./types";

const positionKey = (p: { x: number; y: number }) => `${p.x}:${p.y}`;
const capped = (values: string[]) => values.slice(0, 8).join(", ") + (values.length > 8 ? `, +${values.length - 8} more` : "");

export function powerPinDiagnostic(
  netlist: Netlist,
  pins: ReadonlyMap<string, readonly PlacedPin[]>,
  markers: readonly ErcMarker[],
): { diagnostic?: Diagnostic; unexplained: ErcMarker[] } {
  const atPosition = new Map<string, PlacedPin[]>();
  for (const placed of pins.values()) for (const pin of placed) {
    const key = positionKey(pin.position);
    const group = atPosition.get(key) ?? [];
    group.push(pin);
    atPosition.set(key, group);
  }
  const pinNets = new Map(netlist.nets.flatMap((net) => net.nodes.map((node) => [`${node.ref}:${node.pin}`, net.name] as const)));
  const nets = new Set<string>();
  const unconnected = new Map<string, string>();
  const unconnectedPositions = new Set<string>();
  const unexplained: ErcMarker[] = [];
  for (const marker of markers) {
    if (marker.excluded || marker.severity !== RuleSeverity.RS_ERROR) continue;
    const matched = marker.errorType === ErcErrorType.ERCET_POWERPIN_NOT_DRIVEN && marker.position
      ? atPosition.get(positionKey(vec2(marker.position))) : undefined;
    if (!matched?.length) {
      unexplained.push(marker);
      continue;
    }
    const connected = matched.map((pin) => pinNets.get(`${pin.ref}:${pin.number}`)).filter((net) => net !== undefined);
    if (connected.length) for (const net of connected) nets.add(net);
    else {
      unconnectedPositions.add(positionKey(vec2(marker.position!)));
      for (const pin of matched) unconnected.set(`${pin.ref}:${pin.number}`, `${pin.sourceRef} pin ${pin.number}${pin.name ? ` (${pin.name})` : ""}`);
    }
  }
  const lines: string[] = [];
  if (unconnected.size) lines.push(`${capped([...unconnected.values()])} ${unconnected.size === 1 ? "is a power input on no net; connect it." : "are power inputs on no net; connect them."}`);
  if (nets.size) {
    let index = 1;
    const used = new Set(netlist.components.map((component) => component.ref));
    const flagRef = () => `#FLG${String(index).padStart(2, "0")}`;
    while (used.has(flagRef())) index++;
    const ref = flagRef();
    lines.push(
      `Nets ${capped([...nets].sort())} have power-input pins but nothing KiCad counts as a power source.`,
      "If they really are supplied (a connector, or a part whose output pin is passive), add one PWR_FLAG per net:",
      `${JSON.stringify({ ref, value: "PWR_FLAG", footprint: "", libSource: { lib: "power", part: "PWR_FLAG" } })} and net node ${JSON.stringify({ ref, pin: "1" })}`,
      "If nothing supplies them, fix the circuit instead.",
    );
  }
  const diagnostic: Diagnostic | undefined = lines.length
    ? { severity: "error", stage: "schematic", code: "power_pin_not_driven", message: lines.join("\n") }
    : undefined;
  // Resolve duplicates after collecting all power markers, regardless of marker order.
  const remaining = unexplained.filter((marker) => !(marker.errorType === ErcErrorType.ERCET_PIN_NOT_CONNECTED
    && marker.position && unconnectedPositions.has(positionKey(vec2(marker.position)))));
  return { unexplained: remaining, ...(diagnostic ? { diagnostic } : {}) };
}

/** Explain error markers, retaining a count-only failure when KiCad provides none usable. */
export function ercDiagnostics(netlist: Netlist, pins: ReadonlyMap<string, readonly PlacedPin[]>, markers: readonly ErcMarker[], errorCount: number): Diagnostic[] {
  const { diagnostic, unexplained } = powerPinDiagnostic(netlist, pins, markers);
  const diagnostics = diagnostic ? [diagnostic] : [];
  if (unexplained.length) {
    const detail = unexplained.slice(0, 10).map((marker) => marker.description).join("; ");
    diagnostics.push({ severity: "error", stage: "schematic", code: "erc_errors", message: `Generated schematic has ${unexplained.length} ERC error(s) after save/reload${detail ? `: ${detail}` : "."}` });
  }
  // Preserve the ERC gate even when KiCad supplies no usable error markers.
  if (errorCount > 0 && !diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    diagnostics.push({ severity: "error", stage: "schematic", code: "erc_errors", message: `Generated schematic has ${errorCount} ERC error(s) after save/reload.` });
  }
  return diagnostics;
}
