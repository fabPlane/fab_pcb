/** Saved-file regression with an embedded footprint whose source library does not exist. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Footprint, BoardShape, mm } from "../src";
import { haveKicad, startKiCad } from "./kicad-server";
const pcb = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user "f.silkscreen") (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (footprint "Unavailable:Embedded" (layer "F.Cu") (at 10 20 -90)
    (uuid "00000000-0000-4000-8000-000000000001")
    (property "Reference" "J13" (at 0 -4 -90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "Embedded" (at 0 4 -90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start -2 -3) (end 2 -3) (stroke (width 0.15) (type default)) (layer "F.SilkS") (uuid "00000000-0000-4000-8000-000000000003"))
    (pad "1" smd rect (at 2 -1 -90) (size 0.3 1.3) (layers "F.Cu") (uuid "00000000-0000-4000-8000-000000000002"))
  ))`;
describe.skipIf(!haveKicad())("embedded footprint rotation against KiCad", () => {
  for (const degrees of [90, 180, 30])
    test(`physical ${degrees} degree rotation survives save and reopen`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "fp-pcb-rotate-"));
      const path = join(dir, "board.kicad_pcb");
      await writeFile(path, pcb);
      const server = await startKiCad(path, "rotate");
      try {
        const board = (await server.kicad.currentBoard())!;
        const f = (await board.getFootprints())[0]!;
        const original = f.clone();
        const pivot = original.position;
        const expectedPoint = (p: { x: number; y: number }) => {
          const angle = (degrees * Math.PI) / 180;
          return {
            x: Math.round(pivot.x + (p.x - pivot.x) * Math.cos(angle) + (p.y - pivot.y) * Math.sin(angle)),
            y: Math.round(pivot.y - (p.x - pivot.x) * Math.sin(angle) + (p.y - pivot.y) * Math.cos(angle)),
          };
        };
        f.rotate(degrees);
        await board.commit("rotate embedded geometry", (tx) => tx.update([f]));
        await board.save();
        await board.close();
        const reopened = await server.kicad.openBoard(path);
        const saved = (await reopened.getItem(f.id)) as Footprint;
        const closePoint = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
          expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(1);
        };
        expect(saved.id).toBe(original.id);
        expect(saved.orientation).toBe(original.orientation + degrees);
        expect(saved.position).toEqual(pivot);
        closePoint(saved.pads[0]!.position, expectedPoint(original.pads[0]!.position));
        closePoint(saved.referenceField!.position, expectedPoint(original.referenceField!.position));
        closePoint(
          (saved.items.find((i) => i instanceof BoardShape) as BoardShape).start,
          expectedPoint((original.items.find((i) => i instanceof BoardShape) as BoardShape).start),
        );
        expect((((saved.pads[0]!.orientation - original.pads[0]!.orientation - degrees) % 360) + 360) % 360).toBe(0);
        expect(saved.pads[0]!.size).toEqual({ x: mm(0.3), y: mm(1.3) });
        expect(saved.libraryId).toBe(original.libraryId);
      } finally {
        await server.stop();
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);
});
