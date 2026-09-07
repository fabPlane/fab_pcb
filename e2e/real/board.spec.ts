/**
 * Real KiCad through the bridge: open the kitchen-sink project, place a via, undo it, run DRC,
 * export an SVG. Skipped unless KICAD_CLI is set.
 */
import { clickWorld, countType, expect, haveKicad, openBoard, revision, runCommand, test, waitRevisionAbove } from "./fixtures";

test.describe("real KiCad: board", () => {
  test.skip(!haveKicad, "set KICAD_CLI to run against a real kicad-cli api-server");

  test("open project, place a via, undo, run DRC, export SVG", async ({ page, project }) => {
    await openBoard(page, project.pro);
    await expect(page.locator(".session-pill")).toContainText(/KiCad 1\d/);
    await expect(page.locator(".doc-tab", { hasText: ".kicad_pcb" })).toBeVisible();

    await test.step("place a via with the via tool", async () => {
      const vias0 = await countType(page, "KOT_PCB_VIA");
      const r0 = await revision(page);
      await runCommand(page, "board.placeVia");
      await expect(page.getByTestId("tool-hint")).toContainText("Via");
      await clickWorld(page, "board", "board canvas", 96_000_000, 112_000_000);
      await waitRevisionAbove(page, r0);
      await page.keyboard.press("Escape");
      expect(await countType(page, "KOT_PCB_VIA")).toBe(vias0 + 1);
      const via = await page.evaluate(() => {
        const v = [...(window as any).__fpPcb.services.documents.board().byType("KOT_PCB_VIA")].find((x: any) => Number(x.proto.position.xNm) === 96_000_000);
        return v ? { y: Number(v.proto.position.yNm), layers: v.proto.padStack.layers.length } : null;
      });
      expect(via).toEqual({ y: 112_000_000, layers: 2 });
      const saved: string = await page.evaluate(() => (window as any).__fpPcb.services.documents.boardDoc.saveToString());
      expect(saved).toMatch(/\(via[\s\S]{0,120}?\((?:at|translate) 96 112\)/);
    });

    await test.step("undo removes it through a new commit", async () => {
      const vias = await countType(page, "KOT_PCB_VIA");
      const r = await revision(page);
      await page.locator(".statusbar").click();
      await page.keyboard.press("ControlOrMeta+z");
      await waitRevisionAbove(page, r);
      expect(await countType(page, "KOT_PCB_VIA")).toBe(vias - 1);
    });

    await test.step("run DRC", async () => {
      await page.getByRole("tab", { name: "DRC" }).click();
      await page.locator(".filter-bar button", { hasText: "Run DRC" }).click();
      await expect(page.locator(".marker-row").first()).toBeVisible({ timeout: 120_000 });
      expect(await page.locator(".marker-row").count()).toBeGreaterThan(0);
    });

    await test.step("export SVG", async () => {
      await page.getByRole("tab", { name: "Jobs" }).click();
      await page.locator(".jobs-layout .row", { hasText: "SVG plot" }).click();
      await page.getByRole("button", { name: "Run SVG plot" }).click();
      await expect(page.locator(".run-item .state").first()).toHaveText(/done/, { timeout: 120_000 });
      await expect(page.locator(".output-row .name").first()).toContainText(".svg");
    });
  });

  test("route a track with a layer change", async ({ page, project }) => {
    await openBoard(page, project.pro);
    const tracks0 = await countType(page, "KOT_PCB_TRACE");
    const r0 = await revision(page);
    await page.locator(".statusbar").click();
    await page.keyboard.press("x");
    await expect(page.getByTestId("tool-hint")).toContainText("Route");
    await clickWorld(page, "board", "board canvas", 100_000_000, 100_000_000);
    await clickWorld(page, "board", "board canvas", 110_000_000, 100_000_000);
    await page.keyboard.press("v");
    await clickWorld(page, "board", "board canvas", 110_000_000, 108_000_000);
    await page.keyboard.press("Enter");
    await waitRevisionAbove(page, r0);
    expect(await countType(page, "KOT_PCB_TRACE")).toBe(tracks0 + 2);
    const layers = await page.evaluate(() => [...(window as any).__fpPcb.services.documents.board().byType("KOT_PCB_TRACE")].slice(-2).map((t: any) => t.layer));
    expect(layers.sort()).toEqual(["BL_B_Cu", "BL_F_Cu"]);
  });
});
