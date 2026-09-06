// Drives apps/web against a real KiCad through the bridge in headless Chromium and saves the
// screenshots under docs/screenshots. Prerequisites (see apps/web/README.md):
//   1. bridge:  KICAD_CLI=... WORKSPACE_ROOT=<kicad>/qa/data bun run --filter @kicad-web/bridge start
//   2. app:     VITE_BRIDGE_URL=http://127.0.0.1:4020 bun run --filter @kicad-web/app dev
//   3. node apps/web/scripts/prove-kicad.mjs        (Playwright comes from e2e/node_modules)
import { chromium } from '../../../e2e/node_modules/@playwright/test/index.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
const base = process.env.APP_URL ?? 'http://localhost:5173';
const shots = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots');
const qa = process.env.KICAD_QA_DATA ?? '/Users/hyper/projects/tensorfleet/kicad/qa/data';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
const log = (...a) => console.log('##', ...a);
const rev = () => page.evaluate(async () => Number(await window.__kicadWeb.services.documents.boardDoc.revision()));
const saved = () => page.evaluate(async () => (await window.__kicadWeb.services.documents.boardDoc.saveToString()));

// ---------------------------------------------------------------- board
await page.goto(`${base}/?project=${qa}/pcbnew/api_kitchen_sink.kicad_pro`);
await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('open · KiCad'));
await page.waitForTimeout(2500);
log('board loaded, KiCad revision', await rev());
await page.screenshot({ path: `${shots}/board.png` });

// hover + click R1 (125.2, 90.9 mm)
const canvas = page.locator('canvas[aria-label="board canvas"]');
const box = await canvas.boundingBox();
const pt = await page.evaluate(() => { const h = window.__kicadWeb.host('board'); return h.worldToScreen(125_200_000, 90_900_000); });
await page.mouse.move(box.x + pt.x, box.y + pt.y);
await page.waitForTimeout(300);
log('hover status:', (await page.locator('.statusbar .msg').innerText()).trim());
await page.mouse.click(box.x + pt.x, box.y + pt.y);
await page.waitForFunction(() => document.querySelector('.statusbar .msg')?.textContent?.includes('selected'));
log('selected:', (await page.locator('.statusbar .msg').innerText()).trim(), '| props title:', (await page.locator('.props-title').innerText()).replace(/\s+/g, ' '));
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/board-selected.png` });

// edit X through the properties panel
const xField = page.locator('input[data-path="position.xNm"]');
log('X before:', await xField.inputValue());
const revBefore = await rev();
await xField.fill('130');
await xField.press('Enter');
await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('selected'));
await page.waitForFunction((r) => window.__kicadWeb.services.documents.boardDoc.revision().then((v) => Number(v) > r), revBefore, { timeout: 15000 });
const revAfter = await rev();
const s1 = await saved();
const atOf = (txt) => { const i = txt.indexOf('(footprint "Resistor_SMD:R_0603_1608Metric"'); const seg = txt.slice(i, i + 400).replace(/\s+/g, ' '); return seg.slice(0, 260); };
log(`edit X: KiCad revision ${revBefore} -> ${revAfter}; SaveDocumentToString R1 (at ${atOf(s1)}); history badge:`, await page.getByRole('tab', { name: /History/ }).locator('.badge').innerText());
log('X after:', await xField.inputValue());
await page.screenshot({ path: `${shots}/board-edited.png` });

// undo
await page.locator('.statusbar').click();
await page.keyboard.press('ControlOrMeta+z');
await page.waitForFunction((r) => window.__kicadWeb.services.documents.boardDoc.revision().then((v) => Number(v) > r), revAfter, { timeout: 15000 });
const s2 = await saved();
log(`undo: KiCad revision ${revAfter} -> ${await rev()}; SaveDocumentToString R1 (at ${atOf(s2)}); store X:`, await page.evaluate(() => { const st = window.__kicadWeb.services.documents.board(); const f = [...st.byType('KOT_PCB_FOOTPRINT')].find((x) => x.proto.referenceField?.text?.text?.text === 'R1'); return String(f.proto.position.xNm); }), '| history badge count:', await page.getByRole('tab', { name: /History/ }).locator('.badge').count());

// DRC
await page.getByRole('tab', { name: 'DRC' }).click();
await page.locator('.filter-bar button', { hasText: 'Run DRC' }).click();
await page.waitForSelector('.marker-row', { timeout: 120000 });
await page.waitForTimeout(500);
log('DRC markers:', await page.locator('.marker-row').count(), '| filter bar:', (await page.locator('.filter-bar').first().innerText()).replace(/\s+/g, ' '));
await page.screenshot({ path: `${shots}/board-drc.png` });

// jobs: SVG export
await page.getByRole('tab', { name: 'Jobs' }).click();
await page.locator('.jobs-layout .row', { hasText: 'SVG plot' }).click();
await page.getByRole('button', { name: 'Run SVG plot' }).click();
await page.waitForFunction(() => /done|failed/.test(document.querySelector('.run-item .state')?.textContent ?? ''), null, { timeout: 120000 });
await page.waitForTimeout(300);
log('job state:', (await page.locator('.run-item .state').first().innerText()).trim());
log('job log:', (await page.locator('pre.log').innerText()).split('\n').slice(-4).join(' | '));
log('outputs:', (await page.locator('.output-row .name').allInnerTexts()).join(', '));
const outDir = `${qa}/pcbnew/kicad-web-out`;
log('on disk:', existsSync(outDir) ? readdirSync(outDir).map((d) => `${d}: ${readdirSync(`${outDir}/${d}`).join(',')}`).join(' ; ') : 'none');
await page.screenshot({ path: `${shots}/board-jobs.png` });

// ---------------------------------------------------------------- schematic (its own project)
await page.goto(`${base}/?project=${qa}/eeschema/api_kitchen_sink.kicad_sch`);
await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 60000 });
await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('open · KiCad'));
await page.waitForTimeout(2500);
log('schematic loaded; sheets:', JSON.stringify(await page.evaluate(() => window.__kicadWeb.services.documents.sheets().map((s) => [s.name, s.file, s.page, s.children.length]))));
await page.screenshot({ path: `${shots}/schematic.png` });
await page.getByRole('tab', { name: 'Hierarchy' }).click();
await page.locator('.tree-item', { hasText: 'Subsheet' }).click();
await page.waitForTimeout(1500);
log('active sheet items:', await page.evaluate(() => [...window.__kicadWeb.services.documents.sheet(window.__kicadWeb.services.documents.sheets()[0].children[0].path).all()].length));
await page.screenshot({ path: `${shots}/schematic-subsheet.png` });
// click a symbol on the subsheet
const sc = page.locator('canvas[aria-label="schematic canvas"]');
const sbox = await sc.boundingBox();
const sym = await page.evaluate(() => { const d = window.__kicadWeb.services.documents; const st = d.sheet(d.sheets()[0].children[0].path); const s = [...st.byType('KOT_SCH_SYMBOL')][0]; const key = 'schematic:' + d.sheets()[0].children[0].path; const h = window.__kicadWeb.host(key); const p = h.worldToScreen(Number(s.proto.position.xNm), Number(s.proto.position.yNm)); return { ref: s.proto.referenceField?.text?.text, ...p }; });
await page.mouse.click(sbox.x + sym.x, sbox.y + sym.y);
await page.waitForTimeout(500);
log('clicked symbol', sym.ref, '->', (await page.locator('.statusbar .msg').innerText()).trim(), '| props:', (await page.locator('.props-title').innerText().catch(() => 'n/a')).replace(/\s+/g, ' '));
await page.screenshot({ path: `${shots}/schematic-selected.png` });
// ERC availability
await page.getByRole('tab', { name: 'ERC' }).click();
await page.locator('.filter-bar button', { hasText: 'Run ERC' }).click();
await page.waitForFunction(() => document.querySelector('[role=alert]') || document.querySelector('.marker-row'), null, { timeout: 60000 });
log('ERC:', (await page.locator('[role=alert]').innerText().catch(async () => `${await page.locator('.marker-row').count()} markers`)));
await browser.close();
const list = await (await fetch('http://127.0.0.1:4020/sessions')).json();
for (const s of list.sessions) await fetch(`http://127.0.0.1:4020/sessions/${s.id}`, { method: 'DELETE' });
log('cleaned up', list.sessions.length, 'bridge sessions');
