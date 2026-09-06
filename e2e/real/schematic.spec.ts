/**
 * Real KiCad through the bridge, schematic side: open the project, switch to the root sheet, draw
 * a wire with the wire tool, place a net label through the prompt dialog, undo, cross-probe the
 * board's R1 into the schematic, run ERC. Skipped unless KICAD_CLI is set.
 */
import { clickWorld, expect, haveKicad, openBoard, runCommand, test } from "./fixtures";

const schRevision = (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(async () => Number(await (window as any).__kicadWeb.services.documents.schematicDoc.revision()));
const waitSchRevisionAbove = (page: import("@playwright/test").Page, r: number) =>
  page.waitForFunction((r) => (window as any).__kicadWeb.services.documents.schematicDoc.revision().then((v: bigint) => Number(v) > r), r, { timeout: 30_000 });

test.describe("real KiCad: schematic", () => {
  test.skip(!haveKicad, "set KICAD_CLI to run against a real kicad-cli api-server");

  test("wire, net label, undo, cross-probe, ERC", async ({ page, project }) => {
    await openBoard(page, project.pro);
    await runCommand(page, "window.schematic");
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => (window as any).__kicadWeb.stores.ui.getState().setGrid(1_270_000));
    const rootKey: string = await page.evaluate(() => `schematic:${(window as any).__kicadWeb.stores.app.getState().activeSheet}`);
    // frame the region the clicks use; zoom-to-fit leaves y > ~137 mm under the bottom panel
    await page.evaluate((k) => (window as any).__kicadWeb.host(k).setCamera({ x: 80e6, y: 140e6, zoom: 4e-6 }), rootKey);
    await page.waitForTimeout(300);
    const sheetPath = rootKey.slice("schematic:".length);
    const count = (type: string) => page.evaluate(({ sheetPath, type }) => [...(window as any).__kicadWeb.services.documents.sheet(sheetPath).byType(type)].length, { sheetPath, type });

    await test.step("wire with a 90° bend", async () => {
      const lines0 = await count("KOT_SCH_LINE");
      const r0 = await schRevision(page);
      await page.locator(".statusbar").click();
      await page.keyboard.press("w");
      await expect(page.getByTestId("tool-hint")).toContainText("Wire");
      await clickWorld(page, rootKey, "schematic canvas", 38_100_000, 127_000_000);
      await clickWorld(page, rootKey, "schematic canvas", 63_500_000, 139_700_000);
      await page.keyboard.press("Enter");
      await waitSchRevisionAbove(page, r0);
      expect(await count("KOT_SCH_LINE")).toBe(lines0 + 2);
      const saved: string = await page.evaluate(() => (window as any).__kicadWeb.services.documents.schematicDoc.saveToString());
      expect(saved).toMatch(/\(wire[\s\S]{0,80}?\(pts[\s\S]{0,40}?\(xy 38\.1 127\)/);
    });

    await test.step("net label through the prompt, then undo", async () => {
      const labels0 = await count("KOT_SCH_LABEL");
      const r0 = await schRevision(page);
      await runCommand(page, "schematic.label");
      await page.locator('[data-prompt="text"]').fill("E2E_NET");
      await page.locator('[data-testid="prompt-ok"]').click();
      await expect(page.getByTestId("tool-hint")).toContainText("Label");
      await clickWorld(page, rootKey, "schematic canvas", 50_800_000, 139_700_000);
      await waitSchRevisionAbove(page, r0);
      expect(await count("KOT_SCH_LABEL")).toBe(labels0 + 1);
      await page.keyboard.press("Escape");
      const r1 = await schRevision(page);
      await page.locator(".statusbar").click();
      await page.keyboard.press("ControlOrMeta+z");
      await waitSchRevisionAbove(page, r1);
      expect(await count("KOT_SCH_LABEL")).toBe(labels0);
    });

    await test.step("cross-probe the board's R1 into the schematic", async () => {
      await runCommand(page, "window.board");
      await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 30_000 });
      await page.waitForTimeout(500);
      await clickWorld(page, "board", "board canvas", 125_200_000, 90_900_000);
      await page.waitForTimeout(300);
      const ref: string = await page.evaluate(() => {
        const s = (window as any).__kicadWeb.stores.editor.getState().docs.board.selection[0];
        return (window as any).__kicadWeb.services.documents.board().get(s)?.proto.referenceField?.text?.text?.text ?? "";
      });
      expect(ref).toBe("R1");
      await runCommand(page, "inspect.crossProbe");
      await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 30_000 });
      const symbolRefs: string[] = await page.evaluate((rootKey) => {
        const sel: string[] = (window as any).__kicadWeb.stores.editor.getState().docs[rootKey]?.selection ?? [];
        const store = (window as any).__kicadWeb.services.documents.sheet(rootKey.slice("schematic:".length));
        return sel.map((id) => store.get(id)?.proto.referenceField?.text?.text ?? "");
      }, rootKey);
      expect(symbolRefs).toContain("R1");
    });

    await test.step("run ERC", async () => {
      await page.getByRole("tab", { name: "ERC" }).click();
      await page.locator(".filter-bar button", { hasText: "Run ERC" }).click();
      await page.waitForFunction(() => document.querySelector("[role=alert]") || document.querySelector(".marker-row"), null, { timeout: 120_000 });
      expect(await page.locator(".marker-row").count()).toBeGreaterThan(0);
    });
  });
});
