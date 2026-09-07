/**
 * Real KiCad through the bridge on the five practice boards (e2e/fixtures/boards, see
 * docs/board-practice.md): each project opens in the app with the expected item counts, its
 * pads are drawn and pickable with their nets (the footprint-children regression), the unrouted
 * variant opens too, and DRC runs to completion. Skipped unless KICAD_CLI is set.
 *
 * Each board is copied into `<workspace root>/.kicad-web-e2e-board-<name>/` so the fixture is
 * never written (DRC leaves no files, but a later save would).
 */
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { BRIDGE_URL, deleteBridgeSessions, expect, haveKicad, openBoard, test } from "./fixtures";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures", "boards");

/** Expected counts from GetItemCounts on KiCad 10.99.0-3708 (the fixtures are checked in, so they are stable). */
const BOARDS = [
  { name: "ecc83", dir: "ecc83", project: "ecc83-pp", footprints: 15, pads: 33, tracks: 59, vias: 0 },
  { name: "sonde_xilinx", dir: "sonde_xilinx", project: "sonde xilinx", footprints: 25, pads: 108, tracks: 208, vias: 3 },
  { name: "interf_u", dir: "interf_u", project: "interf_u", footprints: 25, pads: 379, tracks: 731, vias: 84 },
  { name: "pic_programmer", dir: "pic_programmer", project: "pic_programmer", footprints: 63, pads: 247, tracks: 370, vias: 6 },
  { name: "stickhub", dir: "stickhub", project: "StickHub", footprints: 94, pads: 278, tracks: 1113, vias: 87 },
] as const;

async function copyBoard(dir: string, name: string): Promise<{ root: string; cleanup(): void }> {
  const health = (await (await fetch(`${BRIDGE_URL}/health`)).json()) as { workspaceRoot: string };
  const root = `${health.workspaceRoot.replace(/\/$/, "")}/.kicad-web-e2e-board-${name}`;
  rmSync(root, { recursive: true, force: true });
  cpSync(`${FIXTURES}/${dir}`, root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const countType = (page: import("@playwright/test").Page, type: string): Promise<number> =>
  page.evaluate((type) => [...(window as any).__kicadWeb.services.documents.board().byType(type)].length, type);

test.describe("real KiCad: practice boards", () => {
  test.skip(!haveKicad, "set KICAD_CLI to run against a real kicad-cli api-server");

  for (const b of BOARDS) {
    test(`${b.name}: open, counts, pads pickable, unrouted variant, DRC`, async ({ page }) => {
      const copy = await copyBoard(b.dir, b.name);
      try {
        await openBoard(page, `${copy.root}/${b.project}.kicad_pro`);
        await expect(page.locator(".session-pill")).toContainText(/KiCad 1\d/);

        await test.step("item counts match GetItemCounts", async () => {
          expect(await countType(page, "KOT_PCB_FOOTPRINT")).toBe(b.footprints);
          expect(await countType(page, "KOT_PCB_PAD")).toBe(b.pads);
          expect(await countType(page, "KOT_PCB_TRACE")).toBe(b.tracks);
          expect(await countType(page, "KOT_PCB_VIA")).toBe(b.vias);
          const counts = await page.evaluate(async () => {
            const c = await (window as any).__kicadWeb.services.documents.boardDoc.itemCounts();
            return { total: c.total, footprints: c.counts.get(1) ?? 0 };
          });
          expect(counts.footprints).toBe(b.footprints);
          expect(counts.total).toBeGreaterThanOrEqual(b.footprints + b.pads + b.tracks + b.vias);
        });

        await test.step("every footprint's pads are drawn from the store and pick with their net", async () => {
          const probe = await page.evaluate(() => {
            const d = (window as any).__kicadWeb.services.documents;
            const h = (window as any).__kicadWeb.host("board");
            const pads = [...d.board().byType("KOT_PCB_PAD")];
            let drawn = 0;
            const missing: string[] = [];
            const LAYERS = ["BL_F_Cu", "BL_B_Cu", "BL_F_Paste", "BL_B_Paste", "BL_F_Mask", "BL_B_Mask"];
            for (const p of pads) {
              // copper on either side, a paste-only aperture pad, or just the hole of an NPTH mounting pad
              if (LAYERS.some((l) => h.getRenderItem(`${p.id}@${l}`)) || h.getRenderItem(`${p.id}@hole`)) drawn++;
              else missing.push(`${p.id} (number "${p.proto.number}", layers ${JSON.stringify(p.proto.padStack?.layers)})`);
            }
            // pick the centre of a pad on an unrouted net (a track ending in a pad wins the pick, as in KiCad),
            // with the pad's own copper side active (KiCad's rule: exact hits on the active layer first)
            const routed = new Set([...d.board().byType("KOT_PCB_TRACE")].map((t: any) => t.net));
            const candidates = pads.filter((p: any) => p.net && !routed.has(p.net) && (p.proto.padStack?.layers ?? []).some((l: number) => l === 3 || l === 34));
            const pad = candidates.find((p: any) => p.proto.padStack.layers.includes(3)) ?? candidates[0] ?? pads.find((p: any) => p.net) ?? pads[0];
            const side = pad.proto.padStack?.layers?.includes(3) ? "BL_F_Cu" : "BL_B_Cu";
            (window as any).__kicadWeb.stores.editor.getState().setActiveLayer("board", side);
            h.setActiveLayer(side);
            h.setCamera({ x: Number(pad.proto.position.xNm), y: Number(pad.proto.position.yNm), zoom: 50e-6 });
            h.renderNow();
            const s = h.worldToScreen(Number(pad.proto.position.xNm), Number(pad.proto.position.yNm));
            const top = h.pick(s.x, s.y, 5)[0];
            return { total: pads.length, drawn, missing: missing.slice(0, 3), top: top ? { ref: top.ref, owner: top.owner, net: top.net, layer: top.layer } : null, pad: { id: pad.id, net: pad.net, parent: pad.parent } };
          });
          expect(probe.drawn, `pads without render items: ${probe.missing.join(", ")}`).toBe(probe.total);
          expect(probe.top?.ref).toBe(probe.pad.id);
          expect(probe.top?.owner).toBe(probe.pad.parent);
          if (probe.pad.net) expect(probe.top?.net).toBe(probe.pad.net);
          await page.evaluate(() => (window as any).__kicadWeb.host("board").zoomToFit());
        });

        await test.step("DRC runs to completion", async () => {
          await page.getByRole("tab", { name: "DRC" }).click();
          // the panel's Run DRC button calls the same service; awaiting the service tells a clean
          // board (no rows, no alert) from one that is still running
          const t0 = Date.now();
          const result = await page.evaluate(async () => {
            const m = (window as any).__kicadWeb.services.markers;
            try {
              const markers = await m.run("drc");
              return { markers: markers.length };
            } catch (e) {
              return { error: (e as Error).message };
            }
          });
          expect(result.error, `RunBoardJobDrc failed after ${Date.now() - t0} ms`).toBeUndefined();
          await expect(page.locator("[role=alert]")).toHaveCount(0);
          expect(await page.locator(".marker-row").count()).toBe(result.markers);
          console.log(`${b.name}: DRC ${result.markers} markers in ${Date.now() - t0} ms`);
        });

        await test.step("the unrouted variant opens with the same footprints and no tracks", async () => {
          await deleteBridgeSessions();
          await openBoard(page, `${copy.root}/${b.project}.unrouted.kicad_pro`);
          expect(await countType(page, "KOT_PCB_FOOTPRINT")).toBe(b.footprints);
          expect(await countType(page, "KOT_PCB_PAD")).toBe(b.pads);
          expect(await countType(page, "KOT_PCB_TRACE")).toBe(0);
          expect(await countType(page, "KOT_PCB_VIA")).toBe(0);
          const unrouted = await page.evaluate(() => (window as any).__kicadWeb.services.board.unrouted());
          expect(unrouted.unroutedCount).toBeGreaterThan(0);
        });
      } finally {
        await deleteBridgeSessions().catch(() => undefined);
        copy.cleanup();
      }
    });
  }
});
