import { expect, test } from "bun:test";
import { filterSessionCopper } from "../src/specctra/session-filter";
import { parseSes, sesToItems } from "../src/specctra/ses";
import { writeDsn } from "../src/specctra/dsn";
import { child, children, parseSExpr, type SExpr } from "../src/specctra/sexpr";
import { twoNetBoard, F, B } from "./fixtures";

const session = `(session board (placement (component x (place R1 0 0 front 0)))
  (routes (resolution um 10) (library_out
    (padstack Via[0-1]_800:400_um (shape (circle F.Cu 8000)) (shape (circle B.Cu 8000))))
    (network_out
      (net A (wire (path F.Cu 2500 10000 -10000 0 0 20000 0) (type protect))
        (via Via[0-1]_800:400_um 0 0))
      (net B (wire (path F.Cu 2500 0 0 10000 -10000))
        (via Via[0-1]_800:400_um 10000 -10000)))))`;

function fixture() {
  const input = twoNetBoard();
  for (const [net, netCode] of [
    ["A", 1],
    ["B", 2],
  ] as const) {
    input.tracks.push({
      id: `track-${net}`,
      net,
      netCode,
      layer: F,
      width: 250_000,
      start: { x: 0, y: 0 },
      end: { x: 1_000_000, y: 1_000_000 },
    });
    input.vias.push({
      id: `via-${net}`,
      net,
      netCode,
      position: net === "A" ? { x: 0, y: 0 } : { x: 1_000_000, y: 1_000_000 },
      diameter: 800_000,
      drill: 400_000,
      layers: [F, B],
    });
  }
  return input;
}

test("additive native session excludes outside scope and reversed protected segments/vias", () => {
  const input = fixture();
  const filtered = parseSes(filterSessionCopper(session, input, ["A"]));
  expect(filtered.nets).toEqual(["A"]);
  expect(filtered.placements).toEqual([]);
  expect(filtered.padstacks.get("Via[0-1]_800:400_um")).toBeDefined();
  expect(filtered.vias).toHaveLength(0);
  expect(filtered.wires).toHaveLength(1);
  expect(filtered.wires[0]!.points).toEqual([
    { x: 0, y: -0 },
    { x: 2_000_000, y: -0 },
  ]);
  // Builtin path sees exactly the same new copper as native additive import.
  expect(sesToItems(filtered, input).tracks).toHaveLength(1);
  expect(parseSes(filterSessionCopper(session, input)).nets).toEqual(["A"]);
});

test("different width, nearby track, drill and via span are legitimate new items", () => {
  const input = fixture();
  input.tracks[0]!.width = 200_000;
  input.tracks[1]!.start.y += 5000;
  input.vias[0]!.drill = 300_000;
  input.vias[1]!.layers = [F];
  const filtered = parseSes(filterSessionCopper(session, input));
  expect(sesToItems(filtered, input).tracks).toHaveLength(3);
  expect(sesToItems(filtered, input).vias).toHaveLength(2);
});

test("an all-echo or empty session adds nothing; metadata remains usable", () => {
  const input = fixture();
  const filtered = filterSessionCopper(session, input, ["B"]);
  expect(parseSes(filtered).nets).toEqual([]);
  expect(sesToItems(parseSes(filtered), input).tracks).toEqual([]);
  expect(filterSessionCopper(filtered, input)).toBe(filtered);
  expect(() => filterSessionCopper("broken", input)).toThrow("session lacks");
});

test("scoped DSN retains protected net identities without routing their pads", () => {
  const pcb = parseSExpr(writeDsn(fixture(), { routableNets: ["A"] }))[0] as SExpr[];
  const nets = children(child(pcb, "network"), "net");
  expect(child(nets.find((n) => n[1] === "A"), "pins")!.length).toBeGreaterThan(1);
  expect(child(nets.find((n) => n[1] === "B"), "pins")).toEqual(["pins"]);
});
