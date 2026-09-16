/** `persistNetClassFile` on a project file in a temp dir — no KiCad. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistNetClassFile } from "../src/rules";

const dirs: string[] = [];
async function proFile(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fp-pcb-rules-"));
  dirs.push(dir);
  const path = join(dir, "board.kicad_pro");
  await Bun.write(path, JSON.stringify(content));
  return path;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("persistNetClassFile", () => {
  test("adds the Default class to a project file the save left without one (G33)", async () => {
    const path = await proFile({
      board: { design_settings: { rules: { min_clearance: 0.15 } } },
      net_settings: { classes: [], meta: { version: 4 } },
    });
    expect(await persistNetClassFile(path, { clearanceMm: 0.15, trackWidthMm: 0.15, viaDiameterMm: 0.45, viaDrillMm: 0.25 })).toBe(true);
    const pro = await Bun.file(path).json();
    expect(pro.net_settings.classes).toEqual([
      { name: "Default", priority: 2147483647, clearance: 0.15, track_width: 0.15, via_diameter: 0.45, via_drill: 0.25 },
    ]);
    expect(pro.net_settings.meta).toEqual({ version: 4 });
    expect(pro.board.design_settings.rules.min_clearance).toBe(0.15);
  });

  test("merges into an existing Default class and leaves the rest alone", async () => {
    const path = await proFile({
      net_settings: {
        classes: [
          { name: "Default", clearance: 0.2, track_width: 0.25, diff_pair_gap: 0.25 },
          { name: "Power", track_width: 0.5 },
        ],
      },
    });
    await persistNetClassFile(path, { clearanceMm: 0.1 });
    const pro = await Bun.file(path).json();
    expect(pro.net_settings.classes).toEqual([
      { name: "Default", clearance: 0.1, track_width: 0.25, diff_pair_gap: 0.25 },
      { name: "Power", track_width: 0.5 },
    ]);
  });

  test("does nothing without a project file or with one that is not JSON", async () => {
    expect(await persistNetClassFile(join(tmpdir(), "nope", "board.kicad_pro"), { clearanceMm: 0.1 })).toBe(false);
    const path = await proFile("x");
    await Bun.write(path, "(not json");
    expect(await persistNetClassFile(path, { clearanceMm: 0.1 })).toBe(false);
    expect(await Bun.file(path).text()).toBe("(not json");
  });
});
