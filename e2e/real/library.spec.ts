/**
 * Real KiCad through the bridge: place a footprint chosen in the library browser, and annotate the
 * schematic through the Annotate dialog. Skipped unless KICAD_CLI is set.
 */
import { clickWorld, countType, expect, haveKicad, openBoard, revision, runCommand, test, waitRevisionAbove } from "./fixtures";

test.describe("real KiCad: library browser and annotate", () => {
  test.skip(!haveKicad, "set KICAD_CLI to run against a real kicad-cli api-server");

  test("place a footprint picked in the library browser", async ({ page, project }) => {
    await openBoard(page, project.pro);
    const fps0 = await countType(page, "KOT_PCB_FOOTPRINT");
    const r0 = await revision(page);

    await test.step("the browser lists the project's fp-lib-table and previews the entry", async () => {
      await runCommand(page, "board.placeFootprint");
      await expect(page.locator(".library-browser")).toBeVisible({ timeout: 60_000 });
      // the project table row, then one of its entries
      await page.locator(".lib-col.libs .lib-row", { hasText: "Resistor_SMD" }).first().click();
      const entry = page.locator('.lib-col.entries .lib-row[data-libid="Resistor_SMD:R_0603_1608Metric"]');
      await expect(entry).toBeVisible({ timeout: 60_000 });
      await entry.click();
      // the preview is rendered by the real canvas host in the library session
      await expect(page.locator(".lib-preview canvas")).toBeVisible({ timeout: 90_000 });
      await expect(page.locator(".lib-meta")).toContainText("Resistor_SMD:R_0603_1608Metric");
      // searching filters the cached list without another server round trip
      await page.getByTestId("library-search").fill("0402");
      await expect(page.locator(".lib-col.entries .lib-row")).toHaveCount(2);
      await page.getByTestId("library-search").fill("");
      await entry.click();
    });

    await test.step("placing it commits a footprint with the library's pads", async () => {
      await page.getByTestId("library-confirm").click();
      await expect(page.getByTestId("prompt-ok")).toBeVisible({ timeout: 20_000 });
      const reference = await page.locator('[data-prompt="reference"]').inputValue();
      await page.locator('[data-prompt="value"]').fill("4k7");
      await page.getByTestId("prompt-ok").click();
      await expect(page.getByTestId("tool-hint")).toContainText("Footprint", { timeout: 30_000 });
      await clickWorld(page, "board", "board canvas", 140_000_000, 100_000_000);
      await waitRevisionAbove(page, r0);
      expect(await countType(page, "KOT_PCB_FOOTPRINT")).toBe(fps0 + 1);
      const placed = await page.evaluate((reference) => {
        const f = [...(window as any).__fpPcb.services.documents.board().byType("KOT_PCB_FOOTPRINT")].find((x: any) => x.proto.referenceField?.text?.text?.text === reference);
        return f ? { lib: `${f.proto.definition?.id?.libraryNickname}:${f.proto.definition?.id?.entryName}`, items: f.proto.definition?.items?.length ?? 0 } : null;
      }, reference);
      expect(placed?.lib).toBe("Resistor_SMD:R_0603_1608Metric");
      expect(placed?.items).toBeGreaterThan(1);
    });

    await test.step("typing a LIB_ID still works as the fallback", async () => {
      await page.keyboard.press("Escape");
      await runCommand(page, "board.placeFootprint");
      await expect(page.locator(".library-browser")).toBeVisible({ timeout: 60_000 });
      await page.getByTestId("library-libid").fill("Resistor_SMD:R_0402_1005Metric");
      await page.getByTestId("library-confirm").click();
      await expect(page.getByTestId("prompt-ok")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".dialog-title")).toContainText("R_0402_1005Metric");
      await page.keyboard.press("Escape");
    });
  });

  test("annotate the schematic and read the report", async ({ page, project }) => {
    await openBoard(page, project.pro);
    await runCommand(page, "window.schematic");
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 60_000 });

    const before = await page.evaluate(() => {
      const d = (window as any).__fpPcb.services.documents;
      const sheet = d.sheet(d.sheets()[0].path);
      return [...sheet.byType("KOT_SCH_SYMBOL")].map((s: any) => s.proto.referenceField?.text?.text).filter(Boolean).sort();
    });

    await runCommand(page, "schematic.annotate");
    await expect(page.getByTestId("annotate-run")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("annotate-scope").selectOption("all");
    await page.getByTestId("annotate-start").fill("1");
    await page.getByTestId("annotate-reset").setChecked(true);
    await page.getByTestId("annotate-run").click();

    const report = page.getByTestId("annotate-report");
    await expect(report).toBeVisible({ timeout: 90_000 });
    await expect(report).toContainText("symbols annotated");

    // KiCad re-numbered the placements and the store was re-read
    const after = await page.evaluate(() => {
      const d = (window as any).__fpPcb.services.documents;
      const sheet = d.sheet(d.sheets()[0].path);
      return [...sheet.byType("KOT_SCH_SYMBOL")].map((s: any) => s.proto.referenceField?.text?.text).filter(Boolean).sort();
    });
    expect(after.length).toBe(before.length);
    expect(after.every((r: string) => /^[A-Za-z#_]+\d+$/.test(r))).toBe(true);
    expect(after).not.toEqual(before);
  });
});
