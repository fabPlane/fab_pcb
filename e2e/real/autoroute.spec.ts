/**
 * Real KiCad through the bridge: Route -> Autoroute... on the unrouted ecc83 fixture. The JS
 * router runs in the tab through the dialog (progress, summary, the result as one undo entry,
 * the status bar's unrouted count, Refill + DRC from the dialog, undo), then on the bridge; a
 * Freerouting run (a few passes) is added when FREEROUTING_JAR is set. Skipped without KICAD_CLI.
 */
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  BRIDGE_URL,
  countType,
  deleteBridgeSessions,
  expect,
  haveKicad,
  openBoard,
  revision,
  runCommand,
  test,
  waitRevisionAbove,
} from "./fixtures";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures", "boards");

async function copyBoard(name: string): Promise<{ root: string; cleanup(): void }> {
  const health = (await (await fetch(`${BRIDGE_URL}/health`)).json()) as { workspaceRoot: string };
  const root = `${health.workspaceRoot.replace(/\/$/, "")}/.fp-pcb-e2e-autoroute-${name}`;
  rmSync(root, { recursive: true, force: true });
  cpSync(`${FIXTURES}/${name}`, root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Run = {
  state: string;
  error?: string;
  summary?: { routed: number; total: number; tracks: number; vias: number; message: string; unrouted: unknown[] };
};
const currentRun = (page: import("@playwright/test").Page): Promise<Run | null> =>
  page.evaluate(() => {
    const r = (window as any).__fpPcb.services.autoroute?.current();
    return r ? { state: r.state, error: r.error, summary: r.summary } : null;
  });
const historyTop = (page: import("@playwright/test").Page): Promise<string | null> =>
  page.evaluate(async () => {
    const s = await (window as any).__fpPcb.services.undo.stacks();
    return s.undo[s.undo.length - 1]?.description ?? null;
  });

async function routeThroughDialog(
  page: import("@playwright/test").Page,
  router: string,
  opts: { passes?: number; timeLimitS?: number } = {},
): Promise<Run> {
  await runCommand(page, "board.autoroute");
  await expect(page.getByTestId("autoroute-router")).toBeVisible();
  await page.getByTestId("autoroute-router").selectOption(router);
  if (opts.passes !== undefined) await page.getByTestId("autoroute-passes").fill(String(opts.passes));
  if (opts.timeLimitS !== undefined) await page.getByTestId("autoroute-time").fill(String(opts.timeLimitS));
  await page.getByTestId("autoroute-run").click();
  await expect(page.getByTestId("autoroute-progress")).toBeVisible();
  await page.waitForFunction(
    () =>
      ["done", "failed", "cancelled"].includes(
        document.querySelector('[data-testid="autoroute-progress"]')?.getAttribute("data-state") ?? "",
      ),
    null,
    { timeout: 300_000 },
  );
  const run = (await currentRun(page))!;
  return run;
}

test.describe("real KiCad: autoroute", () => {
  test.skip(!haveKicad, "set KICAD_CLI to run against a real kicad-cli api-server");

  test("ecc83: the JS router in the tab, then on the bridge, through Route -> Autoroute...", async ({ page }) => {
    const copy = await copyBoard("ecc83");
    try {
      await openBoard(page, `${copy.root}/ecc83-pp.unrouted.kicad_pro`);
      const tracks0 = await countType(page, "KOT_PCB_TRACE");
      expect(tracks0).toBe(0);
      await expect(page.getByTestId("unrouted-count")).toContainText(/unrouted\s*(14|20)/);

      await test.step("JS router in the tab: summary, one undo entry, status bar", async () => {
        const run = await routeThroughDialog(page, "js-tab", { timeLimitS: 120 });
        expect(run.state).toBe("done");
        expect(run.summary).toMatchObject({ routed: 14, total: 14, message: "Autoroute (js): 14 connections" });
        await expect(page.getByTestId("autoroute-summary")).toContainText("14");
        await expect(page.getByTestId("autoroute-routed")).toHaveText("14");
        expect(await countType(page, "KOT_PCB_TRACE")).toBe(run.summary!.tracks);
        await expect(page.getByTestId("unrouted-count")).toContainText(/unrouted\s*0\b/, { timeout: 20_000 });
        expect(await historyTop(page)).toBe("Autoroute (js): 14 connections");
      });

      await test.step("Refill zones + run DRC from the dialog", async () => {
        await page.getByTestId("autoroute-drc").click();
        await expect(page.getByTestId("autoroute-summary")).toContainText(/DRC: \d+ errors?, \d+ unconnected/, { timeout: 180_000 });
        await expect(page.getByTestId("autoroute-summary")).toContainText("0 unconnected");
      });

      await test.step("undo removes the whole pass in one step", async () => {
        await page.keyboard.press("Escape");
        await page.locator(".statusbar").click();
        const r = await revision(page);
        await page.keyboard.press("ControlOrMeta+z");
        await waitRevisionAbove(page, r);
        await expect.poll(() => countType(page, "KOT_PCB_TRACE"), { timeout: 20_000 }).toBe(0);
      });

      await test.step("JS router on the bridge: the job's result lands in the store and the history", async () => {
        const run = await routeThroughDialog(page, "js-server", { timeLimitS: 120 });
        expect(run.state).toBe("done");
        expect(run.summary).toMatchObject({ routed: 14, total: 14, message: "Autoroute (js): 14 connections" });
        await expect.poll(() => countType(page, "KOT_PCB_TRACE"), { timeout: 20_000 }).toBe(run.summary!.tracks);
        expect(await historyTop(page)).toBe("Autoroute (js): 14 connections");
        await page.keyboard.press("Escape");
      });

      await test.step("Freerouting on the bridge (FREEROUTING_JAR)", async () => {
        test.skip(!process.env.FREEROUTING_JAR, "set FREEROUTING_JAR to run Freerouting");
        await page.locator(".statusbar").click();
        const r = await revision(page);
        await page.keyboard.press("ControlOrMeta+z");
        await waitRevisionAbove(page, r);
        await expect.poll(() => countType(page, "KOT_PCB_TRACE"), { timeout: 20_000 }).toBe(0);
        const run = await routeThroughDialog(page, "freerouting", { passes: 10, timeLimitS: 0 });
        expect(run.state).toBe("done");
        expect(run.summary!.total).toBe(14);
        expect(run.summary!.routed).toBeGreaterThanOrEqual(12);
        expect(run.summary!.message).toBe(`Autoroute (freerouting): ${run.summary!.routed} connections`);
        expect(await historyTop(page)).toBe(run.summary!.message);
        await page.keyboard.press("Escape");
      });
    } finally {
      await deleteBridgeSessions().catch(() => undefined);
      copy.cleanup();
    }
  });

  test("cancelling an in-tab run leaves the board untouched and reports it", async ({ page }) => {
    const copy = await copyBoard("pic_programmer");
    try {
      await openBoard(page, `${copy.root}/pic_programmer.unrouted.kicad_pro`);
      const tracks0 = await countType(page, "KOT_PCB_TRACE");
      await runCommand(page, "board.autoroute");
      await page.getByTestId("autoroute-router").selectOption("js-tab");
      await page.getByTestId("autoroute-run").click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="autoroute-progress"]')?.getAttribute("data-state") === "routing",
        null,
        { timeout: 60_000 },
      );
      await page.getByTestId("autoroute-cancel").click();
      await page.waitForFunction(
        () =>
          ["done", "failed", "cancelled"].includes(
            document.querySelector('[data-testid="autoroute-progress"]')?.getAttribute("data-state") ?? "",
          ),
        null,
        { timeout: 60_000 },
      );
      const run = (await currentRun(page))!;
      // a very fast solver may have finished before the click landed; otherwise it must be cancelled
      if (run.state === "cancelled") {
        await expect(page.getByTestId("autoroute-error")).toContainText(/Cancelled/);
        expect(await countType(page, "KOT_PCB_TRACE")).toBe(tracks0);
      } else expect(run.state).toBe("done");
    } finally {
      await deleteBridgeSessions().catch(() => undefined);
      copy.cleanup();
    }
  });
});
