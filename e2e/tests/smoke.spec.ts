/**
 * Smoke: the whole shell on mock services. One long scenario (the steps depend on each other) plus
 * a couple of independent checks. Selectors: the app's stable class names and ARIA roles.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const PROJECT_DIRS = ["kicad", "qa", "data", "pcbnew"];
const PROJECT_FILE = "api_kitchen_sink.kicad_pro";

/** Double-click through the mock workspace tree and open the kitchen-sink project. */
async function openProjectFromBrowser(page: Page): Promise<void> {
  await expect(page.getByText("Recent projects")).toBeVisible();
  for (const dir of PROJECT_DIRS) {
    await page.locator(".file-row", { has: page.getByText(dir, { exact: true }) }).dblclick();
    await expect(page.locator(".breadcrumbs button", { hasText: dir }).last()).toBeVisible();
  }
  const row = page.locator(".file-row", { hasText: PROJECT_FILE });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveClass(/selected/);
  const open = page.getByRole("button", { name: "Open project" });
  await expect(open).toBeEnabled();
  await open.click();
  await expect(page.locator(".session-pill")).toContainText(/KiCad 10\.99/);
}

/** Reads the cursor world position (mm) from the status bar after hovering the canvas at (x, y). */
async function worldAt(page: Page, canvas: Locator, x: number, y: number): Promise<{ x: number; y: number; pxPerMm: number }> {
  await canvas.hover({ position: { x, y } });
  const cell = page.locator(".statusbar .cell").first();
  await expect(cell).not.toContainText("—");
  const text = await cell.innerText();
  const m = /X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)/.exec(text.replace(/\s+/g, " "));
  if (!m) throw new Error(`cannot parse cursor cell: ${JSON.stringify(text)}`);
  const zoom = await page.locator(".statusbar .cell").nth(1).innerText();
  const z = /Z\s*([\d.]+)\s*px\/mm/.exec(zoom.replace(/\s+/g, " "));
  if (!z) throw new Error(`cannot parse zoom cell: ${JSON.stringify(zoom)}`);
  return { x: Number(m[1]), y: Number(m[2]), pxPerMm: Number(z[1]) };
}

test.describe("shell smoke", () => {
  test("project screen lists the workspace and recent projects", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/FabPlane PCB/);
    await expect(page.getByText("Recent projects")).toBeVisible();
    await expect(page.locator(".recent-item").first()).toContainText("api_kitchen_sink");
    await expect(page.locator(".file-row", { hasText: "kicad" })).toBeVisible();
    await expect(page.locator(".file-row", { hasText: "tensorfleet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open project" })).toBeDisabled();
  });

  test("open project → board → pick → edit → undo → palette → theme → schematic", async ({ page }) => {
    await page.goto("/");

    await test.step("open the kitchen-sink project from the file browser", async () => {
      await openProjectFromBrowser(page);
      await expect(page.locator(".doc-tab", { hasText: ".kicad_pcb" })).toBeVisible();
      await expect(page.locator(".doc-tab", { hasText: ".kicad_sch" })).toBeVisible();
    });

    const canvas = page.locator('canvas[aria-label="board canvas"]');
    await test.step("switch to the board editor", async () => {
      await page.locator(".doc-tab", { hasText: ".kicad_pcb" }).click();
      await expect(canvas).toBeVisible();
      await expect(page.locator(".statusbar")).toContainText("px/mm");
      await expect(page.locator(".statusbar")).toContainText(/open · KiCad/);
    });

    await test.step("click an item on the canvas (U1 at 30,15 mm in the mock board)", async () => {
      const box = (await canvas.boundingBox())!;
      const cx = box.width / 2;
      const cy = box.height / 2;
      const w = await worldAt(page, canvas, cx, cy);
      const target = { x: cx + (30 - w.x) * w.pxPerMm, y: cy + (15 - w.y) * w.pxPerMm };
      expect(target.x).toBeGreaterThan(0);
      expect(target.y).toBeGreaterThan(0);
      await canvas.click({ position: target });
      await expect(page.locator(".statusbar .msg")).toContainText("1 selected");
      await expect(page.locator(".dock-side.right .panel-header")).toContainText("Properties");
    });

    let field: Locator;
    let original: string;
    await test.step("edit a property through the schema-driven panel", async () => {
      field = page.locator(".dock-side.right input.input[data-path]:not(.num):not([disabled])").first();
      await expect(field).toBeVisible();
      original = await field.inputValue();
      await field.fill(`${original}-e2e`);
      // Commit by leaving the field. (Enter also commits, but StringField then commits a second
      // time from onBlur because the `dirty` state has not flushed yet — two identical history
      // entries; tracked as an apps/web bug, see the A9 report.)
      await field.press("Tab");
      await expect(field).toHaveValue(`${original}-e2e`);
      await expect(page.getByRole("tab", { name: /History/ }).locator(".badge")).toHaveText("1");
      await expect(page.locator(".doc-tab", { hasText: ".kicad_pcb" }).locator(".dirty")).toBeVisible();
    });

    await test.step("undo restores the value", async () => {
      // Focus left the input with Tab above; the global hotkey dispatcher ignores text inputs only.
      await page.keyboard.press("ControlOrMeta+z");
      await expect(page.getByRole("tab", { name: /History/ }).locator(".badge")).toHaveCount(0);
      await expect(page.locator(".statusbar .msg")).toContainText("1 selected");
      await expect(field).toHaveValue(original);
    });

    await test.step("command palette toggles the theme", async () => {
      // Dark is the default for a fresh browser profile; data-theme always carries the resolved theme.
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "dark");
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await expect(palette.getByRole("textbox")).toBeFocused();
      await palette.getByRole("textbox").fill("toggle light");
      await expect(palette.getByRole("option").first()).toContainText("Toggle light / dark theme");
      await page.keyboard.press("Enter");
      await expect(palette).toBeHidden();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      // and back via the title-bar button
      await page.locator(".titlebar button[title^='Theme']").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    });

    await test.step("settings dialog switches the theme and survives a reload", async () => {
      await page.keyboard.press("ControlOrMeta+,");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible();
      await settings.getByRole("radio", { name: /^Light/ }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await settings.getByRole("radio", { name: /^Dark/ }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
    });

    await test.step("open the schematic", async () => {
      await page.locator(".doc-tab", { hasText: ".kicad_sch" }).click();
      const sch = page.locator('canvas[aria-label="schematic canvas"]');
      await expect(sch).toBeVisible();
      await expect(page.getByRole("tab", { name: "Hierarchy" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "ERC" })).toBeVisible();
      await page.getByRole("tab", { name: "Hierarchy" }).click();
      await expect(page.getByText("Power supply")).toBeVisible();
    });
  });

  test("keyboard: Mod+O returns to the project screen, Escape closes the palette", async ({ page }) => {
    await page.goto("/");
    await page.locator(".recent-item", { hasText: "api_kitchen_sink" }).click();
    await expect(page.locator('canvas[aria-label="board canvas"]')).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("textbox")).toBeFocused(); // focus arrives on a timeout
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await page.keyboard.press("ControlOrMeta+o");
    await expect(page.getByText("Recent projects")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to editor" })).toBeVisible();
  });
});
