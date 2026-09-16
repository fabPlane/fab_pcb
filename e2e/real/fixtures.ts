/**
 * Shared bits for the real-server specs: skip without KICAD_CLI, a throwaway copy of the
 * kitchen-sink project inside the bridge workspace root (so `/files/*` and the project's
 * fp-lib-table apply), and the debug hook the app exposes in dev (`window.__fpPcb`).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, type Page } from "@playwright/test";

export const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:4020";
const KICAD_ROOT = process.env.KICAD_SRC ? resolve(process.env.KICAD_SRC) : resolve(import.meta.dirname, "..", "..", "..", "kicad");
export const QA = process.env.KICAD_QA_DATA ?? `${KICAD_ROOT}/qa/data`;

export const haveKicad = !!process.env.KICAD_CLI;

export interface RealProject {
  dir: string;
  pro: string;
  cleanup(): void;
}

/** Copies the kitchen sink into `<workspace root>/.fp-pcb-e2e-<tag>/` with local library tables. */
export async function makeProject(tag: string): Promise<RealProject> {
  const health = (await (await fetch(`${BRIDGE_URL}/health`)).json()) as { workspaceRoot: string };
  const root = health.workspaceRoot.replace(/\/$/, "");
  const dir = `${root}/.fp-pcb-e2e-${tag}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const ext of ["kicad_pro", "kicad_pcb", "kicad_dru"])
    cpSync(`${QA}/pcbnew/api_kitchen_sink.${ext}`, `${dir}/api_kitchen_sink.${ext}`);
  cpSync(`${QA}/eeschema/api_kitchen_sink.kicad_sch`, `${dir}/api_kitchen_sink.kicad_sch`);
  cpSync(`${QA}/eeschema/erc_test_dynamic_power_symbol_subsheet.kicad_sch`, `${dir}/erc_test_dynamic_power_symbol_subsheet.kicad_sch`);
  cpSync(`${QA}/libraries/Resistor_SMD.pretty`, `${dir}/Resistor_SMD.pretty`, { recursive: true });
  writeFileSync(
    `${dir}/fp-lib-table`,
    `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${dir}/Resistor_SMD.pretty") (options "") (descr ""))\n)\n`,
  );
  writeFileSync(
    `${dir}/sym-lib-table`,
    `(sym_lib_table\n  (version 7)\n  (lib (name "Device") (type "KiCad") (uri "${QA}/libraries/Device.kicad_sym") (options "") (descr ""))\n)\n`,
  );
  return { dir, pro: `${dir}/api_kitchen_sink.kicad_pro`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function deleteBridgeSessions(): Promise<void> {
  const list = (await (await fetch(`${BRIDGE_URL}/sessions`)).json()) as { sessions: { id: string }[] };
  for (const s of list.sessions) await fetch(`${BRIDGE_URL}/sessions/${s.id}`, { method: "DELETE" });
}

/** Opens the project in the app and waits for the board canvas + an open session. */
export async function openBoard(page: Page, pro: string): Promise<void> {
  await page.goto(`/?project=${encodeURIComponent(pro)}`);
  await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 90_000 });
  await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("open · KiCad"), null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).__fpPcb.stores.ui.getState().setGrid(1_000_000));
}

export const revision = (page: Page): Promise<number> =>
  page.evaluate(async () => Number(await (window as any).__fpPcb.services.documents.boardDoc.revision()));
export const waitRevisionAbove = (page: Page, r: number) =>
  page.waitForFunction((r) => (window as any).__fpPcb.services.documents.boardDoc.revision().then((v: bigint) => Number(v) > r), r, {
    timeout: 30_000,
  });
export const countType = (page: Page, type: string): Promise<number> =>
  page.evaluate((type) => [...(window as any).__fpPcb.services.documents.board().byType(type)].length, type);
/** Starts a command without awaiting it: commands that open a prompt only resolve once the dialog is answered. */
export const runCommand = (page: Page, id: string) =>
  page.evaluate((id) => {
    void (window as any).__fpPcb.runCommand(id);
  }, id);

export async function clickWorld(page: Page, storeKey: string, label: string, x: number, y: number): Promise<void> {
  const box = (await page.locator(`canvas[aria-label="${label}"]`).boundingBox())!;
  const p = await page.evaluate(({ storeKey, x, y }) => (window as any).__fpPcb.host(storeKey).worldToScreen(x, y), { storeKey, x, y });
  await page.mouse.move(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(60);
  await page.mouse.click(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(120);
}

export const test = base.extend<{ project: RealProject }>({
  // eslint-disable-next-line no-empty-pattern
  project: async ({}, use, testInfo) => {
    const p = await makeProject(`${testInfo.workerIndex}-${testInfo.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 24)}`);
    await use(p);
    await deleteBridgeSessions().catch(() => undefined);
    p.cleanup();
  },
});

export { expect } from "@playwright/test";
