/** Real-fork regression: a translated footprint survives UpdateItems with its children moved. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BoardShape, KiCad, mm } from "../src";
import { haveKicad, startKiCad, tempProject, type RunningKiCad, type TempProject } from "./kicad-server";

describe.skipIf(!haveKicad())("Footprint.translate against kicad-cli", () => {
  let project: TempProject;
  let server: RunningKiCad;
  let kicad: KiCad;

  beforeAll(async () => {
    project = await tempProject("fp-pcb-translate-");
    server = await startKiCad(project.pcb, "translate");
    kicad = server.kicad;
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await project?.cleanup();
  });

  test("UpdateItems keeps pads, fields, text, and graphics at the translated coordinates", async () => {
    const board = (await kicad.currentBoard())!;
    const footprint = (await board.getFootprints()).find(
      (candidate) => candidate.pads.length && candidate.referenceField && candidate.items.some((item) => item instanceof BoardShape),
    );
    expect(footprint).toBeDefined();

    const delta = { x: mm(2), y: mm(3) };
    const original = {
      position: footprint!.position,
      reference: footprint!.referenceField!.position,
      pad: footprint!.pads[0]!.position,
      shape: (footprint!.items.find((item) => item instanceof BoardShape) as BoardShape).start,
      orientation: footprint!.orientation,
      layer: footprint!.layerId,
      id: footprint!.id,
    };
    footprint!.translate(delta);
    await board.commit("test: translate footprint", (tx) => tx.update([footprint!]));

    const saved = (await board.getItem(footprint!.id))!;
    expect(saved).toBeInstanceOf(footprint!.constructor);
    const roundTrip = saved as typeof footprint;
    expect(roundTrip!.position).toEqual({ x: original.position.x + delta.x, y: original.position.y + delta.y });
    expect(roundTrip!.referenceField!.position).toEqual({ x: original.reference.x + delta.x, y: original.reference.y + delta.y });
    expect(roundTrip!.pads[0]!.position).toEqual({ x: original.pad.x + delta.x, y: original.pad.y + delta.y });
    expect((roundTrip!.items.find((item) => item instanceof BoardShape) as BoardShape).start).toEqual({
      x: original.shape.x + delta.x,
      y: original.shape.y + delta.y,
    });
    expect(roundTrip!.id).toBe(original.id);
    expect(roundTrip!.orientation).toBe(original.orientation);
    expect(roundTrip!.layerId).toBe(original.layer);
  }, 30_000);
});
