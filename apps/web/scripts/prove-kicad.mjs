// Drives apps/web against a real KiCad through the bridge in headless Chromium and saves the
// screenshots under docs/screenshots. Prerequisites (see apps/web/README.md):
//   1. bridge:  KICAD_CLI=... WORKSPACE_ROOT=<scratch dir> bun run --filter @fp-pcb/bridge start
//               (the proof copy is made inside the workspace root, so keep that root out of the
//               KiCad checkout -- the bridge's own default is <kicad>/qa/data)
//   2. app:     VITE_BRIDGE_URL=http://127.0.0.1:4020 bun run --filter @fp-pcb/app dev
//   3. node apps/web/scripts/prove-kicad.mjs [step,step,...]   (Playwright comes from e2e/node_modules)
//      node apps/web/scripts/prove-kicad.mjs --board <name>       (board practice, see prove-board.mjs)
//
// The kitchen-sink board + schematic are copied into `<workspace root>/.fp-pcb-proof/` with a
// project-local fp-lib-table / sym-lib-table (Resistor_SMD from qa/data/libraries, writable copy,
// and Device.kicad_sym), so the QA fixtures themselves are only read and the footprint editor's
// save can be verified on disk. The copy is removed at the end.
//
// Steps (default all): board, edit, route, draw, footprint, align, clipboard, markers, nets,
// serverundo, settings, boardtools, setup, page, 3d, jobs, fpeditor, schematic, annotate, fields,
// updatepcb, crossprobe, erc. The DRC-driven steps run before `jobs` on purpose: once the async
// export jobs have run, RunBoardJobDrc stops answering on this server.
// `--board <name> [step,...]` runs the board-practice pass (prove-board.mjs) on one of the demo
// boards under e2e/fixtures/boards instead of the kitchen-sink steps below.
if (process.argv.includes('--board')) {
  await import('./prove-board.mjs');
  process.exit(process.exitCode ?? 0);
}
import { chromium } from '../../../e2e/node_modules/@playwright/test/index.mjs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const base = process.env.APP_URL ?? 'http://localhost:5173';
const bridge = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4020';
const shots = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots');
const qa = process.env.KICAD_QA_DATA ?? '/Users/hyper/projects/tensorfleet/kicad/qa/data';
const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const want = (s) => !only || only.has(s);
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const log = (...a) => console.log('##', elapsed(), ...a);
const results = [];
/** `knownGap`: a KiCad-side limitation — reported as GAP, does not fail the run. */
const record = (step, ok, detail, opts = {}) => {
  const state = ok ? 'PASS' : opts.knownGap ? 'GAP' : 'FAIL';
  results.push({ step, ok: ok || !!opts.knownGap, state, detail });
  log(`${state} ${step}${detail ? `: ${detail}` : ''}`);
};

// ---------------------------------------------------------------- temp project inside the workspace root
const health = await (await fetch(`${bridge}/health`)).json();
const root = health.workspaceRoot.replace(/\/$/, '');
const proj = `${root}/.fp-pcb-proof`;
rmSync(proj, { recursive: true, force: true });
mkdirSync(proj, { recursive: true });
for (const ext of ['kicad_pro', 'kicad_pcb', 'kicad_dru']) cpSync(`${qa}/pcbnew/api_kitchen_sink.${ext}`, `${proj}/api_kitchen_sink.${ext}`);
cpSync(`${qa}/eeschema/api_kitchen_sink.kicad_sch`, `${proj}/api_kitchen_sink.kicad_sch`);
cpSync(`${qa}/eeschema/erc_test_dynamic_power_symbol_subsheet.kicad_sch`, `${proj}/erc_test_dynamic_power_symbol_subsheet.kicad_sch`);
cpSync(`${qa}/libraries/Resistor_SMD.pretty`, `${proj}/Resistor_SMD.pretty`, { recursive: true });
writeFileSync(`${proj}/fp-lib-table`, `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${proj}/Resistor_SMD.pretty") (options "") (descr "proof copy"))\n)\n`);
writeFileSync(`${proj}/sym-lib-table`, `(sym_lib_table\n  (version 7)\n  (lib (name "Device") (type "KiCad") (uri "${qa}/libraries/Device.kicad_sym") (options "") (descr "qa Device"))\n)\n`);
log('temp project', proj);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('crash', () => console.log('!! page crashed (renderer)'));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('!! main frame navigated to', f.url()); });
page.on('console', (m) => { const t = m.text(); if (/[vite]|reload|WebGL|CONTEXT_LOST|context lost/i.test(t)) console.log('console[' + m.type() + ']:', t.slice(0, 200)); });
page.on('close', () => console.log('!! page closed'));
browser.on('disconnected', () => console.log('!! browser disconnected'));
const step = (m) => process.env.PROOF_VERBOSE && console.log('  ', elapsed(), '...', m);

// ---------------------------------------------------------------- helpers
const kw = (fn, arg) => page.evaluate(fn, arg);
const rev = () => kw(async () => Number(await window.__fpPcb.services.documents.boardDoc.revision()));
const saved = () => kw(async () => await window.__fpPcb.services.documents.boardDoc.saveToString());
const count = (key, type) => kw(({ key, type }) => { const d = window.__fpPcb.services.documents; const st = key === 'board' ? d.board() : d.sheet(key); return [...st.byType(type)].length; }, { key, type });
/** Starts a command; commands that open a prompt only resolve once the dialog is answered, so the
 * command promise is not awaited (answerPrompt follows). `wait: true` awaits it. */
const run = (id, opts = {}) => kw(({ id, wait }) => { const p = window.__fpPcb.runCommand(id); return wait ? p : undefined; }, { id, wait: !!opts.wait });
const canvasBox = async (label) => page.locator(`canvas[aria-label="${label}"]`).boundingBox();
const screenPt = (key, x, y) => kw(({ key, x, y }) => window.__fpPcb.host(key).worldToScreen(x, y), { key, x, y });
/** Clicks a world coordinate (nm) on the canvas of `key`. */
async function clickWorld(label, key, x, y, opts = {}) {
  const box = await canvasBox(label);
  const p = await screenPt(key, x, y);
  await page.mouse.move(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(60);
  await page.mouse.click(box.x + p.x, box.y + p.y, opts);
  await page.waitForTimeout(120);
}
async function moveWorld(label, key, x, y) {
  const box = await canvasBox(label);
  const p = await screenPt(key, x, y);
  await page.mouse.move(box.x + p.x, box.y + p.y);
  await page.waitForTimeout(60);
}
const focusCanvas = () => page.locator('.statusbar').click();
/** Fills the open prompt dialog and confirms. */
async function answerPrompt(values) {
  await page.waitForSelector('[data-testid="prompt-ok"]', { timeout: 10000 });
  for (const [k, v] of Object.entries(values)) {
    const el = page.locator(`[data-prompt="${k}"]`);
    const tag = await el.evaluate((e) => e.tagName);
    if (tag === 'SELECT') await el.selectOption(String(v));
    else if ((await el.getAttribute('type')) === 'checkbox') await el.setChecked(Boolean(v));
    else await el.fill(String(v));
  }
  await page.locator('[data-testid="prompt-ok"]').click();
  await page.waitForTimeout(150);
}
/** Answers the library browser: type the id in the fallback field and confirm. */
async function pickLibrary(libId) {
  await page.waitForSelector('[data-testid="library-confirm"]', { timeout: 60000 });
  await page.locator('[data-testid="library-libid"]').fill(libId);
  await page.locator('[data-testid="library-confirm"]').click();
  await page.waitForTimeout(200);
}
/** Picks a library entry by clicking its row (exercises the tables + entry list + preview). */
async function pickLibraryByRow(nickname, name) {
  await page.waitForSelector('.library-browser', { timeout: 60000 });
  await page.locator('.lib-col.libs .lib-row', { hasText: nickname }).first().click();
  await page.waitForSelector(`.lib-col.entries .lib-row[data-libid="${nickname}:${name}"]`, { timeout: 60000 });
  await page.locator(`.lib-col.entries .lib-row[data-libid="${nickname}:${name}"]`).click();
  // the preview renders in the library session, which is spawned on first use (a few seconds)
  await page.waitForSelector('.lib-preview canvas', { timeout: 90000 });
  await page.waitForTimeout(1500);
}
const waitRev = async (after, timeout = 20000) => page.waitForFunction((r) => window.__fpPcb.services.documents.boardDoc.revision().then((v) => Number(v) > r), after, { timeout });
const toolHint = () => page.locator('[data-testid="tool-hint"]').innerText().catch(() => '');
const notify = () => page.locator('.toast').innerText().catch(() => '');
const mm = (v) => Math.round(v * 1e6);

try {
  // ---------------------------------------------------------------- board
  await page.goto(`${base}/?project=${proj}/api_kitchen_sink.kicad_pro`);
  await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('open · KiCad'));
  await page.waitForTimeout(2500);
  log('board loaded, KiCad revision', await rev());
  // 1 mm grid so the world coordinates below land exactly (the default 1.27 mm grid would snap them)
  await kw(() => window.__fpPcb.stores.ui.getState().setGrid(1_000_000));
  if (want('board')) {
    await page.screenshot({ path: `${shots}/board.png` });
    // hover + click R1 (125.2, 90.9 mm)
    await clickWorld('board canvas', 'board', 125_200_000, 90_900_000);
    await page.waitForFunction(() => document.querySelector('.statusbar .msg')?.textContent?.includes('selected'));
    log('selected:', (await page.locator('.statusbar .msg').innerText()).trim(), '| props title:', (await page.locator('.props-title').innerText()).replace(/\s+/g, ' '));
    await page.screenshot({ path: `${shots}/board-selected.png` });
    record('board', true, 'kitchen sink opened, R1 picked');
  }

  if (want('edit')) {
    await clickWorld('board canvas', 'board', 125_200_000, 90_900_000);
    await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('selected'));
    const xField = page.locator('input[data-path="position.xNm"]');
    const revBefore = await rev();
    await xField.fill('130');
    await xField.press('Enter');
    await waitRev(revBefore);
    const s1 = await saved();
    // KiCad writes `(at x y)` for untouched items and `(transform (translate x y) ...)` once an item went through the API
    const padsAt = (txt) => { const i = txt.indexOf('(footprint "Resistor_SMD:R_0603_1608Metric"'); const seg = txt.slice(i, i + 4000); return [...seg.matchAll(/\(pad "(\d)"[\s\S]*?\((?:at|translate) (-?[\d.]+) (-?[\d.]+)/g)].map((m) => `${m[1]}@${m[2]},${m[3]}`).join(' '); };
    const fpAt = (txt) => { const i = txt.indexOf('(footprint "Resistor_SMD:R_0603_1608Metric"'); return /\((?:at|translate) (-?[\d.]+) (-?[\d.]+)/.exec(txt.slice(i, i + 600))?.slice(1, 3).join(','); };
    log(`edit X: revision ${revBefore} -> ${await rev()}; R1 at ${fpAt(s1)}; pads (footprint-relative) ${padsAt(s1)}`);
    await page.screenshot({ path: `${shots}/board-edited.png` });
    await focusCanvas();
    const r2 = await rev();
    await page.keyboard.press('ControlOrMeta+z');
    await waitRev(r2);
    const s2 = await saved();
    record('edit', fpAt(s2) === '125.2,90.9', `move + undo: R1 back at ${fpAt(s2)}; pads ${padsAt(s2)}`);
  }

  if (want('route')) {
    await focusCanvas();
    await page.keyboard.press('Escape');
    const tracks0 = await count('board', 'KOT_PCB_TRACE');
    const vias0 = await count('board', 'KOT_PCB_VIA');
    const r0 = await rev();
    await page.keyboard.press('x');
    log('route tool:', await toolHint());
    await clickWorld('board canvas', 'board', mm(100), mm(100));
    await clickWorld('board canvas', 'board', mm(110), mm(100));
    await moveWorld('board canvas', 'board', mm(110), mm(100));
    await page.keyboard.press('v');
    log('after V:', await toolHint(), '| active layer:', (await page.locator('.statusbar').innerText()).match(/layer\s+(\S+)/)?.[1]);
    await clickWorld('board canvas', 'board', mm(110), mm(108));
    await moveWorld('board canvas', 'board', mm(118), mm(108));
    await page.screenshot({ path: `${shots}/board-route-preview.png` });
    await clickWorld('board canvas', 'board', mm(118), mm(108));
    await page.keyboard.press('Enter');
    await waitRev(r0);
    await page.waitForTimeout(400);
    const tracks1 = await count('board', 'KOT_PCB_TRACE');
    const vias1 = await count('board', 'KOT_PCB_VIA');
    const s = await saved();
    const segs = (s.match(/\(segment\b/g) ?? []).length;
    const viaIdx = [...s.matchAll(/\(via\b/g)].map((m) => m.index).find((i) => /\((?:at|translate) 110 100\)/.test(s.slice(i, i + 200)));
    const viaText = viaIdx !== undefined ? s.slice(viaIdx, viaIdx + 400).replace(/\s+/g, ' ') : 'no via at (110,100)';
    const viaLine = /\(layers "F\.Cu" "B\.Cu"\)/.test(viaText);
    log('via in file:', viaText.slice(0, 160));
    log(`route: tracks ${tracks0} -> ${tracks1}, vias ${vias0} -> ${vias1}; file has ${segs} segments, via at (110,100) F.Cu-B.Cu: ${viaLine}; toast: ${await notify()}`);
    await page.screenshot({ path: `${shots}/board-route.png` });
    record('route', tracks1 === tracks0 + 3 && vias1 === vias0 + 1 && viaLine, `3 segments + via written by KiCad (revision ${r0} -> ${await rev()})`);
    // undo the whole route in one step
    await focusCanvas();
    const r1 = await rev();
    await page.keyboard.press('ControlOrMeta+z');
    await waitRev(r1);
    log('route undo: tracks', await count('board', 'KOT_PCB_TRACE'), 'vias', await count('board', 'KOT_PCB_VIA'));
    const rUndo = await rev();
    await run('edit.redo');
    await waitRev(rUndo);
    await page.waitForTimeout(300);
    log('route redo: tracks', await count('board', 'KOT_PCB_TRACE'), 'vias', await count('board', 'KOT_PCB_VIA'));
    // standalone via tool
    await run('board.placeVia');
    await clickWorld('board canvas', 'board', mm(96), mm(112));
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    log('via tool: vias now', await count('board', 'KOT_PCB_VIA'));
  }

  if (want('draw')) {
    await focusCanvas();
    const shapes0 = await count('board', 'KOT_PCB_SHAPE');
    const texts0 = await count('board', 'KOT_PCB_TEXT');
    const zones0 = await count('board', 'KOT_PCB_ZONE');
    // switch to F.SilkS for graphics
    step('draw: select layer');
    await page.locator('select[aria-label="Active layer"]').selectOption('BL_F_SilkS');
    step('draw: line tool');
    await run('board.drawLine');
    step('draw: line clicks'); // Mod+Shift+L is a browser shortcut in headless Chromium
    await clickWorld('board canvas', 'board', mm(90), mm(70));
    await clickWorld('board canvas', 'board', mm(100), mm(70));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    step('draw: line done, rect tool');
    await run('board.drawRect'); // Mod+Shift+R is a browser shortcut in headless Chromium
    await clickWorld('board canvas', 'board', mm(90), mm(72));
    await clickWorld('board canvas', 'board', mm(100), mm(78));
    await page.waitForTimeout(400);
    step('draw: rect done, circle tool');
    await run('board.drawCircle'); // Mod+Shift+C is a browser shortcut in headless Chromium
    await clickWorld('board canvas', 'board', mm(105), mm(75));
    await clickWorld('board canvas', 'board', mm(108), mm(75));
    await page.waitForTimeout(400);
    step('draw: circle done, arc tool');
    await run('board.drawArc'); // Mod+Shift+A is a browser shortcut in headless Chromium
    await clickWorld('board canvas', 'board', mm(112), mm(78));
    await clickWorld('board canvas', 'board', mm(118), mm(78));
    await clickWorld('board canvas', 'board', mm(115), mm(74));
    await page.waitForTimeout(400);
    step('draw: arc done, polygon tool');
    await run('board.drawPolygon');
    await clickWorld('board canvas', 'board', mm(90), mm(82));
    await clickWorld('board canvas', 'board', mm(96), mm(82));
    await clickWorld('board canvas', 'board', mm(93), mm(86));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    step('draw: polygon done, text tool');
    await run('board.placeText'); // Mod+Shift+T is a browser shortcut in headless Chromium
    await answerPrompt({ text: 'KICAD-WEB', size: '1.5' });
    await clickWorld('board canvas', 'board', mm(105), mm(84));
    await page.waitForTimeout(400);
    step('draw: text done, zone tool');
    // zone on B.Cu, net from the board
    await page.locator('select[aria-label="Active layer"]').selectOption('BL_B_Cu');
    await run('board.drawZone'); // Mod+Shift+Z is a browser shortcut in headless Chromium
    await clickWorld('board canvas', 'board', mm(60), mm(60));
    await clickWorld('board canvas', 'board', mm(84), mm(60));
    await clickWorld('board canvas', 'board', mm(84), mm(68));
    await clickWorld('board canvas', 'board', mm(60), mm(68));
    await page.keyboard.press('Enter');
    step('draw: zone outline done, prompt');
    const nets = await kw(() => window.__fpPcb.services.documents.nets().map((n) => n.name));
    await answerPrompt({ net: nets[0] ?? '', name: 'proof-zone' });
    await page.waitForTimeout(1500);
    const shapes1 = await count('board', 'KOT_PCB_SHAPE');
    const texts1 = await count('board', 'KOT_PCB_TEXT');
    const zones1 = await count('board', 'KOT_PCB_ZONE');
    const zone = await kw(() => { const z = [...window.__fpPcb.services.documents.board().byType('KOT_PCB_ZONE')].find((x) => x.proto.name === 'proof-zone'); return z ? { filled: z.proto.filled, fills: z.proto.filledPolygons.length, net: z.proto.settings?.value?.net?.name, layers: z.proto.layers } : null; });
    await page.locator('select[aria-label="Active layer"]').selectOption('BL_F_Cu');
    await page.screenshot({ path: `${shots}/board-drawn.png` });
    log(`draw: shapes ${shapes0} -> ${shapes1}, texts ${texts0} -> ${texts1}, zones ${zones0} -> ${zones1}; zone ${JSON.stringify(zone)}`);
    record('draw', shapes1 === shapes0 + 5 && texts1 === texts0 + 1 && zones1 === zones0 + 1 && zone?.filled === true, `line/rect/circle/arc/polygon + text + zone (filled after RefillZones: ${zone?.fills} polygon sets on ${zone?.net})`);
  }

  if (want('footprint')) {
    await focusCanvas();
    const fps0 = await count('board', 'KOT_PCB_FOOTPRINT');
    await page.keyboard.press('a');
    // the library browser replaced the type-a-LIB_ID prompt: pick the row, then the reference dialog
    await pickLibraryByRow('Resistor_SMD', 'R_0603_1608Metric');
    const previewCanvas = await page.locator('.lib-preview canvas').count();
    await page.screenshot({ path: `${shots}/library-browser.png` });
    await page.locator('[data-testid="library-confirm"]').click();
    await page.waitForSelector('[data-testid="prompt-ok"]', { timeout: 20000 });
    const ref = await page.locator('[data-prompt="reference"]').inputValue();
    await answerPrompt({ value: '4k7' });
    await page.waitForFunction(() => /Footprint: click/.test(document.querySelector('[data-testid="tool-hint"]')?.textContent ?? ''), null, { timeout: 30000 });
    await moveWorld('board canvas', 'board', mm(140), mm(100));
    await page.screenshot({ path: `${shots}/board-footprint-preview.png` });
    await clickWorld('board canvas', 'board', mm(140), mm(100));
    await page.waitForTimeout(1500);
    const fps1 = await count('board', 'KOT_PCB_FOOTPRINT');
    const placed = await kw((ref) => { const f = [...window.__fpPcb.services.documents.board().byType('KOT_PCB_FOOTPRINT')].find((x) => x.proto.referenceField?.text?.text?.text === ref); return f ? { at: [Number(f.proto.position.xNm) / 1e6, Number(f.proto.position.yNm) / 1e6], items: f.proto.definition?.items?.length, lib: `${f.proto.definition?.id?.libraryNickname}:${f.proto.definition?.id?.entryName}` } : null; }, ref);
    const s = await saved();
    const i = s.indexOf(`(property "Reference" "${ref}"`);
    const pads = i > 0 ? [...s.slice(i, i + 6000).matchAll(/\(pad "(\d)"[\s\S]*?\((?:at|translate) (-?[\d.]+) (-?[\d.]+)/g)].map((m) => `${m[1]}@${m[2]},${m[3]}`).join(' ') : 'not in file';
    log(`footprint: ${fps0} -> ${fps1}; ${ref} = ${JSON.stringify(placed)}; file pads ${pads}; sessions on bridge: ${(await (await fetch(`${bridge}/sessions`)).json()).sessions.length} (library session spawned)`);
    await page.screenshot({ path: `${shots}/board-footprint.png` });
    record('footprint', fps1 === fps0 + 1 && placed?.items >= 2 && pads.includes('1@-0.825,0'), `${ref} ${placed?.lib} at ${placed?.at} with ${placed?.items} definition items; pads in file: ${pads}`);
    record('library-place', previewCanvas === 1, `library browser: entry picked from the fp-lib-table listing, ${previewCanvas} preview canvas, placed as ${ref}`);
  }

  if (want('align')) {
    await focusCanvas();
    // select the two R footprints and the new one: distribute + align
    const ids = await kw(() => [...window.__fpPcb.services.documents.board().byType('KOT_PCB_FOOTPRINT')].slice(0, 3).map((f) => f.id));
    await kw((ids) => window.__fpPcb.stores.editor.getState().setSelection('board', ids), ids);
    const before = await kw((ids) => ids.map((id) => { const f = window.__fpPcb.services.documents.board().get(id); return [Number(f.proto.position.xNm) / 1e6, Number(f.proto.position.yNm) / 1e6]; }), ids);
    const r0 = await rev();
    await run('edit.alignTop');
    await waitRev(r0);
    const after = await kw((ids) => ids.map((id) => { const f = window.__fpPcb.services.documents.board().get(id); return [Number(f.proto.position.xNm) / 1e6, Number(f.proto.position.yNm) / 1e6]; }), ids);
    log('align top:', JSON.stringify(before), '->', JSON.stringify(after));
    const r1 = await rev();
    await run('edit.distributeH');
    await waitRev(r1);
    const after2 = await kw((ids) => ids.map((id) => { const f = window.__fpPcb.services.documents.board().get(id); return Number(f.proto.position.xNm) / 1e6; }), ids);
    log('distribute H x:', JSON.stringify(after2));
    // rotate by angle through the prompt
    await kw((ids) => window.__fpPcb.stores.editor.getState().setSelection('board', [ids[0]]), ids);
    const r2 = await rev();
    await run('edit.rotateBy');
    await answerPrompt({ value: '45' });
    await waitRev(r2);
    const orient = await kw((id) => window.__fpPcb.services.documents.board().get(id).proto.orientation?.valueDegrees, ids[0]);
    // set layer (side) of a track and net edit
    const track = await kw(() => { const t = [...window.__fpPcb.services.documents.board().byType('KOT_PCB_TRACE')][0]; return { id: t.id, layer: t.layer, net: t.net }; });
    await kw((id) => window.__fpPcb.stores.editor.getState().setSelection('board', [id]), track.id);
    const r3 = await rev();
    await run('edit.setLayer');
    await answerPrompt({ value: track.layer === 'BL_F_Cu' ? 'BL_B_Cu' : 'BL_F_Cu' });
    await waitRev(r3);
    const r4 = await rev();
    await run('edit.setNet');
    await answerPrompt({ custom: 'PROOF_NET' });
    await waitRev(r4);
    const trackAfter = await kw((id) => { const t = window.__fpPcb.services.documents.board().get(id); return { layer: t.layer, net: t.net }; }, track.id);
    log(`rotate by 45 -> orientation ${orient}; track ${track.layer}/${track.net} -> ${trackAfter.layer}/${trackAfter.net}`);
    await page.screenshot({ path: `${shots}/board-align.png` });
    const sameY = after.every((p) => Math.abs(p[1] - after[0][1]) < 1e-6);
    record('align', sameY && orient === 45 && trackAfter.layer !== track.layer && trackAfter.net === 'PROOF_NET', `align top → y=${after[0][1]}, distribute, rotate 45°, set layer ${trackAfter.layer}, set net ${trackAfter.net}`);
    await focusCanvas();
    for (let i = 0; i < 5; i++) {
      const r = await rev();
      await page.keyboard.press('ControlOrMeta+z');
      await waitRev(r).catch(() => undefined);
    }
  }

  if (want('clipboard')) {
    await focusCanvas();
    const t = await kw(() => { const t = [...window.__fpPcb.services.documents.board().byType('KOT_PCB_TRACE')][0]; return t.id; });
    await kw((id) => window.__fpPcb.stores.editor.getState().setSelection('board', [id]), t);
    const n0 = await count('board', 'KOT_PCB_TRACE');
    const r0 = await rev();
    await page.keyboard.press('ControlOrMeta+d');
    await waitRev(r0);
    await page.keyboard.press('ControlOrMeta+c');
    await moveWorld('board canvas', 'board', mm(70), mm(95));
    const r1 = await rev();
    await page.keyboard.press('ControlOrMeta+v');
    await waitRev(r1);
    const n1 = await count('board', 'KOT_PCB_TRACE');
    const sel = await kw(() => window.__fpPcb.stores.editor.getState().docs.board.selection);
    log(`duplicate + copy/paste: tracks ${n0} -> ${n1}; pasted selection ${sel.length}; toast: ${await notify()}`);
    // KiCad clipboard text: SaveItemsToString of the track, pasted back through ParseAndCreateItemsFromString, undone
    const sexpr = await kw((id) => window.__fpPcb.services.documents.saveItemsToString('board', 'board', [id]), t);
    const r2 = await rev();
    await run('edit.pasteText');
    await answerPrompt({ text: sexpr });
    await waitRev(r2);
    await page.waitForTimeout(300);
    const n2 = await count('board', 'KOT_PCB_TRACE');
    const r3 = await rev();
    await focusCanvas();
    await page.keyboard.press('ControlOrMeta+z');
    await waitRev(r3);
    const n3 = await count('board', 'KOT_PCB_TRACE');
    log(`KiCad text paste: SaveItemsToString ${sexpr.length} chars (${sexpr.slice(0, 40).replace(/\s+/g, ' ')}…) -> ParseAndCreateItemsFromString: tracks ${n1} -> ${n2}; undo -> ${n3}`);
    record('clipboard', n1 === n0 + 2 && n2 === n1 + 1 && n3 === n1, 'duplicate (Mod+D), copy/paste (Mod+C / Mod+V at cursor) through CreateItems, and SaveItemsToString → ParseAndCreateItemsFromString paste + undo');
  }

  // ------------------------------------------------------------- markers on the canvas
  if (want('markers')) {
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
    await page.getByRole('tab', { name: 'DRC' }).click();
    await page.locator('.filter-bar button', { hasText: 'Run DRC' }).click();
    await page.waitForFunction(() => document.querySelector('[role=alert]') || document.querySelector('.marker-row'), null, { timeout: 180000 });
    const rows = await page.locator('.marker-row').count();
    if (rows > 0) {
      // the panel feeds host.setMarkers; the row click focuses the marker and selects its items
      const overlay = await kw(() => { const h = window.__fpPcb.host('board'); return typeof h.setMarkers === 'function' && typeof h.focusMarker === 'function'; });
      await page.locator('.marker-row').first().click();
      await page.waitForTimeout(900);
      const sel = await kw(() => window.__fpPcb.stores.editor.getState().docs.board?.selection?.length ?? 0);
      await page.screenshot({ path: `${shots}/board-drc-markers.png` });
      // exclude the first violation with a comment, then show it through the excluded filter
      const before = await kw(() => window.__fpPcb.services.markers.markers('drc').filter((m) => m.excluded).length);
      await page.locator('.marker-row').first().locator('button.btn.ghost.sm').click();
      await answerPrompt({ value: 'accepted by the fp-pcb proof' });
      await page.waitForTimeout(900);
      await page.locator('[data-testid="filter-excluded"]').click();
      await page.waitForTimeout(400);
      const after = await kw(() => window.__fpPcb.services.markers.markers('drc').filter((m) => m.excluded).map((m) => m.comment));
      await page.screenshot({ path: `${shots}/board-drc-excluded.png` });
      log(`DRC: ${rows} markers, overlay API ${overlay}, selection after focus ${sel}, excluded ${before} -> ${after.length} (${JSON.stringify(after[0])})`);
      record('markers', overlay && after.length === before + 1, `${rows} markers fed to host.setMarkers, focusMarker + selection on click, exclusion comment "${after[0]}" round-tripped through SetDrcMarkerExcluded`);
    } else record('markers', false, 'DRC produced no markers');

    // severities editor
    await page.locator('[data-testid="open-severities"]').click();
    await page.waitForSelector('[data-testid="severities-apply"]', { timeout: 30000 });
    await page.waitForTimeout(1200);
    const ruleCount = await page.locator('select[data-rule]').count();
    const rule = await page.locator('select[data-rule]').first().getAttribute('data-rule');
    const was = await page.locator('select[data-rule]').first().inputValue();
    const want2 = was === 'ignore' ? 'warning' : 'ignore';
    await page.locator('select[data-rule]').first().selectOption(want2);
    await page.screenshot({ path: `${shots}/board-drc-severities.png` });
    await page.locator('[data-testid="severities-apply"]').click();
    await page.waitForTimeout(1500);
    const now = await kw(async ({ rule }) => (await window.__fpPcb.services.board.severities('drc')).find((r) => r.rule === rule)?.severity, { rule });
    await page.locator('.dialog .btn', { hasText: 'Close' }).click();
    log(`severities: ${ruleCount} rules; ${rule} ${was} -> ${want2}, server now reports ${now}`);
    record('severities', now === want2, `${ruleCount} DRC rules from GetDrcSeverities; ${rule} set to ${want2} and read back`);
  }

  // ------------------------------------------------------------ ratsnest + net tools
  if (want('nets')) {
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
    const unrouted = await kw(() => window.__fpPcb.services.board.unrouted());
    const statusText = await page.locator('[data-testid="unrouted-count"]').innerText().catch(() => '');
    await run('view.toggleRatsnest');
    await page.waitForTimeout(400);
    const off = await kw(() => window.__fpPcb.stores.ui.getState().showRatsnest);
    await run('view.toggleRatsnest');
    await page.waitForTimeout(400);
    const on = await kw(() => window.__fpPcb.stores.ui.getState().showRatsnest);
    // net inspector: highlight a net, read GetNetLengths
    await page.locator('.left-rail button, .panel-tabs button', { hasText: 'Nets' }).first().click().catch(() => {});
    await kw(() => window.__fpPcb.stores.ui.getState().setLeftTab('nets'));
    await page.waitForSelector('[data-testid="net-lengths"]', { timeout: 30000 });
    await page.waitForTimeout(2500);
    const lengthRows = await page.locator('[data-length-net]').count();
    const top = await page.locator('[data-length-net]').first().getAttribute('data-length-net');
    // sort by pads, then back by length
    await page.locator('th[data-sort="padCount"]').click();
    await page.waitForTimeout(300);
    const byPads = await page.locator('[data-length-net]').first().getAttribute('data-length-net');
    await page.locator('th[data-sort="totalNm"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/board-net-inspector.png` });
    log(`nets: unrouted ${JSON.stringify(unrouted)}, status bar "${statusText.replace(/\s+/g, ' ')}", ratsnest toggle ${on}/${off}, ${lengthRows} length rows (top by length ${top}, by pads ${byPads})`);
    await kw(() => window.__fpPcb.host('board').zoomToFit());
    await page.waitForTimeout(400);
    record('nets', lengthRows > 0 && off === false && on === true && /unrouted/.test(statusText), `GetNetLengths ${lengthRows} rows with sortable columns, GetUnroutedCount ${unrouted.unroutedCount} in the status bar, ratsnest toggle works`);
  }


  // ------------------------------------------------------------------ server undo
  if (want('serverundo')) {
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
    await page.getByRole('tab', { name: 'History' }).click();
    await page.waitForSelector('[data-testid="undo-mode"]', { timeout: 20000 });
    await page.waitForTimeout(2500);
    const mode = (await page.locator('[data-testid="undo-mode"]').innerText()).trim();
    // make an edit KiCad records, then undo it through the panel
    const vias0 = await count('board', 'KOT_PCB_VIA');
    const r0 = await rev();
    await focusCanvas();
    await run('board.placeVia');
    await page.waitForFunction(() => /Via/.test(document.querySelector('[data-testid="tool-hint"]')?.textContent ?? ''), null, { timeout: 20000 });
    await clickWorld('board canvas', 'board', mm(150), mm(95));
    await waitRev(r0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    const vias1 = await count('board', 'KOT_PCB_VIA');
    const stack = await kw(() => window.__fpPcb.services.undo.stacks());
    await page.screenshot({ path: `${shots}/board-server-undo.png` });
    const r1 = await rev();
    await page.locator('[data-testid="history-undo"]').click();
    await page.waitForTimeout(3000);
    const vias2 = await count('board', 'KOT_PCB_VIA');
    const after = await kw(() => window.__fpPcb.services.undo.stacks());
    log(`server undo: mode "${mode}", vias ${vias0} -> ${vias1} -> ${vias2}; KiCad stack ${JSON.stringify(stack.undo.map((e) => e.description))} -> ${JSON.stringify(after.undo.map((e) => e.description))}, revision ${r0} -> ${r1}`);
    record('serverundo', /server undo/.test(mode) && vias1 === vias0 + 1 && vias2 === vias0 && stack.undo.length > after.undo.length, `history panel in ${mode}; GetUndoStack showed ${stack.undo.length} entries, Undo removed the via and popped one`);
  }

  // ------------------------------------------------------------ settings from KiCad
  if (want('settings')) {
    await run('tools.settings');
    await page.waitForSelector('[data-testid="canvas-theme"]', { timeout: 20000 });
    await page.waitForTimeout(2500);
    const themes = await page.locator('[data-testid="canvas-theme"] optgroup option').allInnerTexts();
    const defaults = (await page.locator('[data-testid="kicad-defaults"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (themes.length) {
      await page.locator('[data-testid="canvas-theme"]').selectOption(`server:${themes[0].replace(' (built in)', '')}`);
      await page.waitForTimeout(1500);
    }
    const applied = await kw(() => window.__fpPcb.stores.ui.getState().canvasTheme);
    await page.screenshot({ path: `${shots}/settings-kicad-themes.png` });
    await page.locator('.dialog .btn', { hasText: 'Close' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shots}/board-kicad-theme.png` });
    await kw(() => window.__fpPcb.host('board')?.zoomToFit());
    log(`settings: ListColorThemes ${JSON.stringify(themes)}, canvasTheme now "${applied}", GetAppSettings "${defaults}"`);
    record('settings', themes.length > 0 && applied.startsWith('server:') && /Units/.test(defaults), `${themes.length} KiCad themes offered, canvas pinned to ${applied}; GetAppSettings defaults shown (${defaults.slice(0, 90)})`);
  }

  // ------------------------------------------------------------- board bulk tools
  if (want('boardtools')) {
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
    await focusCanvas();
    const zones0 = await count('board', 'KOT_PCB_ZONE');
    await run('board.teardrops');
    await answerPrompt({ vias: true, pthPads: true, smdPads: false, trackToTrack: false, roundShapesOnly: false });
    await page.waitForTimeout(4000);
    const zones1 = await count('board', 'KOT_PCB_ZONE');
    await page.screenshot({ path: `${shots}/board-teardrops.png` });
    await run('board.removeTeardrops');
    await page.waitForTimeout(4000);
    const zones2 = await count('board', 'KOT_PCB_ZONE');
    // update footprints from library
    await run('board.updateFootprints');
    await answerPrompt({ references: '', onlyChanged: true });
    await page.waitForTimeout(4000);
    // autoplace (the kitchen sink has no outline: the command reports that instead of failing)
    await run('board.autoplace');
    await answerPrompt({ scope: 'all', includeOffboard: true });
    await page.waitForTimeout(4000);
    // global deletion of the board texts
    const texts0 = await count('board', 'KOT_PCB_TEXT');
    await run('board.globalDeletion');
    await answerPrompt({ KOT_PCB_TEXT: true, layer: '', locked: 'unlocked', boardEdges: false, teardrops: false });
    await page.waitForTimeout(4000);
    const texts1 = await count('board', 'KOT_PCB_TEXT');
    await page.screenshot({ path: `${shots}/board-global-deletion.png` });
    // toasts expire; the app log keeps every command's own report line
    const lines = await kw(() => (window.__fpPcb.stores.log.getState().lines ?? []).map((e) => e.text));
    const said = (re) => lines.filter((l) => re.test(l)).pop() ?? '';
    const teardrops = said(/^SetTeardrops:/);
    const removed = said(/^RemoveTeardrops:/);
    const update = said(/^UpdateFootprintsFromLibrary:/);
    const auto = said(/^AutoplaceFootprints:/);
    const del = said(/^GlobalDeletion:/);
    log(`board tools: zones ${zones0} -> ${zones1} -> ${zones2}; texts ${texts0} -> ${texts1}`);
    for (const l of [teardrops, removed, update, auto, del]) log('  app log:', l);
    // KiCad reuses / merges teardrop zones, so the zone count is not a reliable delta — the
    // command's own count is. Zone counts are reported for context only.
    const made = Number(/(\d+) teardrops? created/.exec(teardrops)?.[1] ?? 0);
    const gone = Number(/(\d+) teardrops? removed/.exec(removed)?.[1] ?? 0);
    record(
      'boardtools',
      made > 0 && gone > 0 && /updated/.test(update) && /placed|outline/.test(auto) && texts1 < texts0,
      `SetTeardrops made ${made} and RemoveTeardrops removed ${gone} (zones ${zones0}/${zones1}/${zones2}), "${update}", "${auto}", GlobalDeletion removed ${texts0 - texts1} texts`,
    );
  }

  if (want('setup')) {
    await focusCanvas();
    const before = await kw(() => window.__fpPcb.services.documents.boardSetup());
    await run('tools.boardSetup');
    await page.waitForSelector('.dialog', { timeout: 5000 });
    // constraints: min clearance 0.123 mm
    await page.locator('.dialog-sidebar nav button', { hasText: 'Constraints' }).click();
    const clr = page.locator('.dialog .form-grid input.num').first();
    await clr.fill('0.123');
    await clr.press('Enter');
    // stackup: first copper layer material
    await page.locator('.dialog-sidebar nav button', { hasText: 'Physical stackup' }).click();
    const copperRow = page.locator('.dialog table tbody tr', { hasText: 'copper' }).first();
    await copperRow.locator('input').first().fill('Proof copper');
    const thick = copperRow.locator('input.num');
    await thick.fill('0.07');
    await thick.press('Enter');
    // custom rule rename
    await page.locator('.dialog-sidebar nav button', { hasText: 'Custom rules' }).click();
    const ruleName = page.locator('[data-rule="name-0"]');
    const hadRule = (await ruleName.count()) > 0;
    if (hadRule) await ruleName.fill('proof-rule');
    // origin
    await page.locator('.dialog-sidebar nav button', { hasText: 'Origins' }).click();
    const gx = page.locator('.dialog .form-grid input.num').first();
    await gx.fill('12.5');
    await gx.press('Enter');
    await page.screenshot({ path: `${shots}/board-setup.png` });
    await page.locator('[data-testid="board-setup-ok"]').click();
    await page.waitForSelector('.dialog', { state: 'detached', timeout: 30000 }).catch(() => undefined);
    const err = await page.locator('.dialog [role=alert]').innerText().catch(() => '');
    if (err) { log('board setup error:', err); await page.keyboard.press('Escape'); }
    await page.waitForTimeout(500);
    const after = await kw(() => window.__fpPcb.services.documents.boardSetup());
    const s = await saved();
    const stack = /\(stackup[\s\S]*?\(layer "F\.Cu"[\s\S]*?\(thickness ([\d.]+)\)[\s\S]*?\(material "([^"]*)"\)/.exec(s);
    const cu = after.stackup.find((l) => l.type === 'copper');
    log(`board setup: clearance ${before.rules.minClearanceNm} -> ${after.rules.minClearanceNm}; F.Cu ${cu?.material} ${cu?.thicknessNm}; file stackup F.Cu thickness ${stack?.[1]} material "${stack?.[2]}"; rule ${after.customRuleList[0]?.name}; grid origin ${JSON.stringify(after.origin.grid)}`);
    record('setup', after.rules.minClearanceNm === 123000 && cu?.thicknessNm === 70000 && after.origin.grid.x === 12_500_000 && (!hadRule || after.customRuleList[0]?.name === 'proof-rule'), `SetBoardDesignRules + UpdateBoardStackup + SetCustomDesignRules + SetBoardOrigin round-trip (${err || 'no error'})`);
  }

  if (want('page')) {
    await focusCanvas();
    await run('tools.pageSettings');
    await page.waitForSelector('.dialog', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('[data-page="title"]') || document.querySelector('.dialog [role=alert]'), null, { timeout: 15000 });
    const errB = await page.locator('.dialog [role=alert]').innerText().catch(() => '');
    let tb = null;
    if (!errB) {
      await page.locator('[data-page="title"]').fill('fp-pcb proof');
      await page.locator('[data-page="revision"]').fill('A1');
      await page.locator('[data-page="pageSize"]').selectOption('PS_A3');
      await page.screenshot({ path: `${shots}/board-page-settings.png` });
      await page.locator('.dialog-footer .btn.primary').click();
      await page.waitForTimeout(800);
      tb = await kw(async () => { const b = window.__fpPcb.services.documents.boardDoc; return { title: (await b.titleBlock()).title, page: (await b.pageSettings()).pageSize }; });
      const s = await saved();
      log(`board page settings: title block now ${JSON.stringify(tb)}; file: ${/\(paper "([^"]+)"\)/.exec(s)?.[1]} title "${/\(title "([^"]*)"\)/.exec(s)?.[1]}"`);
    } else { log('board page settings refused:', errB); await page.keyboard.press('Escape'); }
    record('page', !errB && tb?.title === 'fp-pcb proof', errB || `SetTitleBlockInfo/SetPageSettings: ${JSON.stringify(tb)}`);
  }

  if (want('3d')) {
    await focusCanvas();
    await run('window.view3d');
    await page.waitForSelector('[data-testid="three-view"]', { timeout: 10000 });
    await page.waitForFunction(() => /mesh|failed|unavailable/i.test(document.querySelector('[data-testid="three-status"]')?.textContent ?? ''), null, { timeout: 180000 });
    await page.waitForTimeout(1500);
    const status = await page.locator('[data-testid="three-status"]').innerText();
    log('3D:', status);
    await page.screenshot({ path: `${shots}/board-3d.png` });
    record('3d', /mesh/.test(status), status);
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
    await page.waitForTimeout(800);
  }

  if (want('jobs')) {
    const outcomes = [];
    let asyncRuns = 0;
    for (const [id, opts] of [['board.gerbers', {}], ['board.drill', {}], ['board.position', {}], ['board.pdf', {}], ['board.svg', {}], ['board.step', {}], ['board.ipc2581', {}], ['board.odb', { compression: 'zip' }], ['board.dxf', {}], ['schematic.netlist', {}], ['schematic.bom', {}], ['schematic.svg', {}], ['schematic.pdf', {}]]) {
      const r = await kw(async ({ id, opts }) => { const j = window.__fpPcb.services.jobs; const def = j.jobs().find((d) => d.id === id); const o = {}; for (const x of def.options) o[x.key] = x.default; const run = await j.run(id, { ...o, ...opts }); return { state: run.state, error: run.error, outputs: run.outputs.map((f) => `${f.name} (${(f.bytes / 1024).toFixed(1)} KiB)`), log: run.log }; }, { id, opts });
      const async = r.log.some((l) => /queued \(async\)/.test(l));
      const progress = r.log.filter((l) => /^\d+% /.test(l)).length;
      if (async) asyncRuns++;
      outcomes.push(`${id}: ${r.state}${r.error ? ` (${r.error.slice(0, 120)})` : ''}${async ? ` [async, ${progress} progress lines]` : ' [sync]'} ${r.outputs.join(', ')}`);
    }
    for (const o of outcomes) log('job', o);
    log(`async jobs: ${asyncRuns}/${outcomes.length} answered JS_RUNNING and were waited with GetJobStatus`);
    await page.getByRole('tab', { name: 'Jobs' }).click();
    await page.locator('.jobs-layout .row', { hasText: 'IPC-2581' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/board-jobs.png` });
    // Measured: after the async export jobs have run, RunBoardJobDrc never answers on this
    // server, so the DRC-driven steps run before `jobs` above.
    record('drc-after-jobs', true, 'RunBoardJobDrc stops answering once the async export jobs have run — the markers step therefore runs before `jobs`', { knownGap: true });
    record('jobs', outcomes.every((o) => o.includes('done')), `${outcomes.length} exports (${asyncRuns} async)`);
  }

  if (want('fpeditor')) {
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
    await page.waitForTimeout(500);
    // context menu on R1 → Open footprint editor
    const box = await canvasBox('board canvas');
    const p = await screenPt('board', 125_200_000, 90_900_000);
    await page.mouse.click(box.x + p.x, box.y + p.y, { button: 'right' });
    await page.waitForSelector('[data-testid="canvas-context-menu"]');
    await page.screenshot({ path: `${shots}/board-context-menu.png` });
    await page.locator('[data-testid="canvas-context-menu"] button', { hasText: 'Open footprint editor' }).click();
    await page.waitForSelector('canvas[aria-label="footprint canvas"]', { timeout: 60000 });
    await page.waitForTimeout(1500);
    const key = await kw(() => `footprint:${window.__fpPcb.stores.app.getState().activeFootprint}`);
    const pads = await kw((key) => [...window.__fpPcb.services.documents.footprint(key.slice('footprint:'.length)).byType('KOT_PCB_PAD')].map((p) => ({ id: p.id, n: p.proto.number, x: Number(p.proto.position.xNm) })), key);
    log('footprint editor:', key, 'pads', JSON.stringify(pads.map((p) => `${p.n}@${p.x / 1e6}`)));
    await kw(({ key, id }) => window.__fpPcb.stores.editor.getState().setSelection(key, [id]), { key, id: pads[0].id });
    await page.waitForSelector('input[data-path="position.xNm"]');
    const x = page.locator('input[data-path="position.xNm"]');
    await x.fill('-0.9');
    await x.press('Enter');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${shots}/footprint-editor.png` });
    await focusCanvas();
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(1500);
    const file = readFileSync(`${proj}/Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod`, 'utf8');
    const padX = /\(pad "1"[\s\S]*?\((?:at|translate) (-?[\d.]+)/.exec(file)?.[1];
    const boardAlive = await kw(async () => { try { await window.__fpPcb.services.documents.boardDoc.revision(); return true; } catch (e) { return String(e.message); } });
    log(`footprint saved: pad 1 x in .kicad_mod = ${padX}; board still answers on the main session: ${boardAlive}`);
    record('fpeditor', padX === '-0.9' && boardAlive === true, `pad edited in the library session, SaveDocument wrote ${padX} to the .kicad_mod, board untouched`);
    await run('window.board');
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
  }

  // ---------------------------------------------------------------- schematic (same project)
  if (want('schematic') || want('crossprobe') || want('erc')) {
    await run('window.schematic');
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 60000 });
    await page.waitForTimeout(2000);
    log('schematic sheets:', JSON.stringify(await kw(() => window.__fpPcb.services.documents.sheets().map((s) => [s.name, s.file, s.page, s.children.length]))));
    await page.screenshot({ path: `${shots}/schematic.png` });
  }
  const rootKey = await kw(() => `schematic:${window.__fpPcb.stores.app.getState().activeSheet}`).catch(() => 'schematic:/');
  const sheetPath = rootKey.slice('schematic:'.length);
  const sc = (type) => count(sheetPath, type);
  const schRev = () => kw(async () => Number(await window.__fpPcb.services.documents.schematicDoc.revision()));
  const waitSchRev = (after) => page.waitForFunction((r) => window.__fpPcb.services.documents.schematicDoc.revision().then((v) => Number(v) > r), after, { timeout: 20000 });

  if (want('schematic')) {
    await focusCanvas();
    // Zoom-to-fit leaves the drawing area below ~137 mm under the bottom panel at 1440x900; frame the
    // region the clicks below use (x 30..130, y 120..160 mm) so every click reaches the canvas.
    const bounds = await kw((key) => { const h = window.__fpPcb.host(key); h.setCamera({ x: 80e6, y: 140e6, zoom: 4e-6 }); const c = document.querySelector('canvas[aria-label="schematic canvas"]'); const a = h.screenToWorld(0, 0); const b = h.screenToWorld(c.clientWidth, c.clientHeight); return [a.x / 1e6, a.y / 1e6, b.x / 1e6, b.y / 1e6].map((v) => Math.round(v)); }, rootKey);
    log('schematic camera framed, visible world (mm):', JSON.stringify(bounds));
    await page.waitForTimeout(300);
    const c0 = { line: await sc('KOT_SCH_LINE'), j: await sc('KOT_SCH_JUNCTION'), nc: await sc('KOT_SCH_NO_CONNECT'), l: await sc('KOT_SCH_LABEL'), g: await sc('KOT_SCH_GLOBAL_LABEL'), h: await sc('KOT_SCH_HIER_LABEL'), t: await sc('KOT_SCH_TEXT'), sym: await sc('KOT_SCH_SYMBOL'), sh: await sc('KOT_SCH_SHEET') };
    const r0 = await schRev();
    await page.keyboard.press('w');
    log('wire tool:', await toolHint());
    await clickWorld('schematic canvas', rootKey, mm(38.1), mm(127));
    await clickWorld('schematic canvas', rootKey, mm(63.5), mm(139.7));
    await moveWorld('schematic canvas', rootKey, mm(76.2), mm(139.7));
    await page.screenshot({ path: `${shots}/schematic-wire-preview.png` });
    await clickWorld('schematic canvas', rootKey, mm(76.2), mm(139.7));
    await page.keyboard.press('Enter');
    await waitSchRev(r0);
    step('schematic: wire committed, bus tool');
    await page.keyboard.press('b');
    await clickWorld('schematic canvas', rootKey, mm(38.1), mm(147.32));
    await clickWorld('schematic canvas', rootKey, mm(63.5), mm(147.32));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    step('schematic: bus done, junction');
    await page.keyboard.press('j');
    await clickWorld('schematic canvas', rootKey, mm(63.5), mm(139.7));
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    step('schematic: junction done, no-connect');
    await page.keyboard.press('q');
    await clickWorld('schematic canvas', rootKey, mm(38.1), mm(127));
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    step('schematic: no-connect done, label');
    await page.keyboard.press('l');
    await answerPrompt({ text: 'PROOF_NET' });
    await clickWorld('schematic canvas', rootKey, mm(50.8), mm(139.7));
    await page.waitForTimeout(500);
    step('schematic: label placed, global label');
    await page.keyboard.press('ControlOrMeta+l');
    await answerPrompt({ text: 'PROOF_GLOBAL', shape: 'output' });
    await clickWorld('schematic canvas', rootKey, mm(76.2), mm(139.7));
    await page.waitForTimeout(500);
    step('schematic: global placed, hier label');
    await page.keyboard.press('h');
    await answerPrompt({ text: 'PROOF_HIER', shape: 'bidi' });
    await clickWorld('schematic canvas', rootKey, mm(63.5), mm(147.32));
    await page.waitForTimeout(500);
    step('schematic: hier placed, text');
    await page.keyboard.press('t');
    await answerPrompt({ text: 'fp-pcb proof text' });
    await clickWorld('schematic canvas', rootKey, mm(38.1), mm(157));
    await page.waitForTimeout(500);
    step('schematic: text placed, symbol');
    // symbol from the library: Device:R as R1 so cross-probing to the board's R1 works
    await page.keyboard.press('a');
    await pickLibrary('Device:R');
    await answerPrompt({ reference: 'R1', value: '10k', footprint: 'Resistor_SMD:R_0603_1608Metric' });
    await page.waitForFunction(() => /Symbol: click/.test(document.querySelector('[data-testid="tool-hint"]')?.textContent ?? ''), null, { timeout: 30000 });
    const rSym = await schRev();
    await clickWorld('schematic canvas', rootKey, mm(88.9), mm(139.7));
    await waitSchRev(rSym); // the symbol commit (big definition) must land before the next tool starts
    await page.waitForTimeout(300);
    step('schematic: symbol placed, sheet');
    log('mid counts (before the sheet):', JSON.stringify({ line: await sc('KOT_SCH_LINE'), j: await sc('KOT_SCH_JUNCTION'), l: await sc('KOT_SCH_LABEL'), sym: await sc('KOT_SCH_SYMBOL') }), 'revision', await schRev());
    // hierarchical sheet
    // both corners must stay inside the visible canvas (the bottom panel starts ~600 px down at 1440x900)
    await page.keyboard.press('s');
    await clickWorld('schematic canvas', rootKey, mm(101.6), mm(127));
    await clickWorld('schematic canvas', rootKey, mm(114.3), mm(137.16));
    await answerPrompt({ name: 'Proof sheet', file: 'proof_sheet.kicad_sch' });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${shots}/schematic-tools.png` });
    const c1 = { line: await sc('KOT_SCH_LINE'), j: await sc('KOT_SCH_JUNCTION'), nc: await sc('KOT_SCH_NO_CONNECT'), l: await sc('KOT_SCH_LABEL'), g: await sc('KOT_SCH_GLOBAL_LABEL'), h: await sc('KOT_SCH_HIER_LABEL'), t: await sc('KOT_SCH_TEXT'), sym: await sc('KOT_SCH_SYMBOL'), sh: await sc('KOT_SCH_SHEET') };
    const sym = await kw((key) => { const s = [...window.__fpPcb.services.documents.sheet(key).byType('KOT_SCH_SYMBOL')].find((x) => x.proto.referenceField?.text?.text === 'R1'); return s ? { lib: `${s.proto.libId?.libraryNickname}:${s.proto.libId?.entryName}`, children: s.proto.definition?.items?.length, value: s.proto.valueField?.text?.text } : null; }, sheetPath);
    const sheets = await kw(() => window.__fpPcb.services.documents.sheets().map((s) => [s.name, s.file, s.children.map((c) => [c.name, c.file])]));
    for (const l of await kw(() => (window.__fpPcb.stores.log?.getState().lines ?? []).slice(-40).map((e) => `[${e.level}] ${e.text}`))) log('app log:', l.slice(0, 300));
    log('schematic counts', JSON.stringify(c0), '->', JSON.stringify(c1), '| R1 symbol', JSON.stringify(sym), '| hierarchy', JSON.stringify(sheets));
    await page.screenshot({ path: `${shots}/schematic-tools.png` });
    const ok = c1.line === c0.line + 4 && // wire: 3 segments (two 90° bends), bus: 1
       c1.j === c0.j + 1 && c1.nc === c0.nc + 1 && c1.l === c0.l + 1 && c1.g === c0.g + 1 && c1.h === c0.h + 1 && c1.t === c0.t + 1 && c1.sym === c0.sym + 1 && c1.sh === c0.sh + 1;
    record('schematic', ok, `wire (3 seg) + bus + junction + no-connect + 3 labels + text + Device:R (${sym?.children} lib children) + sheet (hierarchy now ${JSON.stringify(sheets[0]?.[2])})`);
    // save: KiCad's schematic SaveDocument is the known multi-handler dispatch bug
    const saveResult = await kw(async () => { try { await window.__fpPcb.services.documents.save('schematic'); return 'ok'; } catch (e) { return e.message; } });
    const files = readdirSync(proj).filter((f) => f.endsWith('.kicad_sch'));
    log(`schematic SaveDocument: ${saveResult}; .kicad_sch files in project: ${files.join(', ')}`);
    record('schematic-save', saveResult === 'ok', saveResult === 'ok' ? `SaveDocument ok; files: ${files.join(', ')}` : `KiCad refused: ${saveResult}`);
    record('sheet-file', files.includes('proof_sheet.kicad_sch'), files.includes('proof_sheet.kicad_sch') ? 'proof_sheet.kicad_sch created' : 'SaveDocument did not create proof_sheet.kicad_sch for the sheet added through the API (the root file references it) — needs the C++ side to create files for new sheets on save', { knownGap: true });
  }

  if (want('crossprobe')) {
    // select R1 on the schematic → board selection follows; then jump
    const symId = await kw((key) => [...window.__fpPcb.services.documents.sheet(key).byType('KOT_SCH_SYMBOL')].find((x) => x.proto.referenceField?.text?.text === 'R1')?.id ?? null, sheetPath);
    if (symId) {
      await kw(({ key, id }) => window.__fpPcb.stores.editor.getState().setSelection(key, [id]), { key: rootKey, id: symId });
      await page.waitForTimeout(300);
      const boardSel = await kw(() => window.__fpPcb.stores.editor.getState().docs.board?.selection ?? []);
      const boardRef = await kw((ids) => ids.map((id) => window.__fpPcb.services.documents.board().get(id)?.proto.referenceField?.text?.text?.text), boardSel);
      await run('inspect.crossProbe');
      await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 20000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${shots}/board-crossprobe.png` });
      const active = await kw(() => window.__fpPcb.stores.app.getState().activeEditor);
      log(`cross-probe: schematic R1 → board selection ${JSON.stringify(boardRef)}; jump switched to ${active}`);
      // and back: board R1 → schematic selection
      await kw(() => window.__fpPcb.stores.editor.getState().setSelection('board', []));
      await clickWorld('board canvas', 'board', 125_200_000, 90_900_000);
      await page.waitForTimeout(300);
      const schSel = await kw((key) => window.__fpPcb.stores.editor.getState().docs[key]?.selection ?? [], rootKey);
      log(`cross-probe: board R1 → schematic selection ${JSON.stringify(schSel)} (symbol ${symId})`);
      await run('window.schematic');
      await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 20000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${shots}/schematic-crossprobe.png` });
      record('crossprobe', boardRef.includes('R1') && schSel.includes(symId) && active === 'board', 'footprint ↔ symbol by reference, both directions, jump switches editor');
    } else record('crossprobe', false, 'no R1 symbol on the root sheet (schematic step skipped?)');
  }


  // ------------------------------------------------------------- schematic workflow
  if (want('annotate')) {
    await run('window.schematic');
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 30000 });
    await page.waitForTimeout(800);
    await run('schematic.annotate');
    await page.waitForSelector('[data-testid="annotate-run"]', { timeout: 30000 });
    await page.locator('[data-testid="annotate-scope"]').selectOption('all');
    await page.locator('[data-testid="annotate-start"]').fill('1');
    await page.locator('[data-testid="annotate-reset"]').setChecked(true);
    await page.locator('[data-testid="annotate-run"]').click();
    await page.waitForSelector('[data-testid="annotate-report"]', { timeout: 60000 });
    const report = (await page.locator('[data-testid="annotate-report"]').innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: `${shots}/schematic-annotate.png` });
    await page.locator('.dialog .btn', { hasText: 'Close' }).click();
    await page.waitForTimeout(400);
    const refs = await kw((key) => [...window.__fpPcb.services.documents.sheet(key).byType('KOT_SCH_SYMBOL')].map((s) => s.proto.referenceField?.text?.text).filter(Boolean).sort(), sheetPath);
    log('annotate report:', report, '| references now', JSON.stringify(refs));
    record('annotate', /symbols annotated/.test(report), `${report}; references ${refs.join(' ')}`);
  }

  if (want('fields')) {
    await run('window.schematic');
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 30000 });
    await run('schematic.fieldsTable');
    await page.waitForSelector('[data-testid="fields-apply"]', { timeout: 60000 });
    await page.waitForTimeout(2000);
    const rows = await page.locator('.fields-table tbody tr[data-ref]').count();
    const firstRef = await page.locator('.fields-table tbody tr[data-ref]').first().getAttribute('data-ref');
    const cell = page.locator(`[data-cell="${firstRef}:Value"]`);
    const oldValue = await cell.inputValue();
    await cell.fill('PROOF_VALUE');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/schematic-fields-table.png` });
    await page.locator('[data-testid="fields-apply"]').click();
    await page.waitForTimeout(3000);
    const readBack = await kw(async () => (await window.__fpPcb.services.schematic.fieldsTable()).rows.map((r) => [r.reference, r.fields.Value]));
    await page.locator('.dialog .btn', { hasText: 'Close' }).click();
    const hit = readBack.find(([, v]) => v === 'PROOF_VALUE');
    log(`fields table: ${rows} rows; ${firstRef}.Value "${oldValue}" -> PROOF_VALUE; server reports ${JSON.stringify(readBack)}`);
    record('fields', !!hit, `${rows} placements from GetSymbolFieldsTable; one edit committed through SetSymbolFields and read back on ${hit?.[0]}`);
  }

  if (want('updatepcb')) {
    await run('window.schematic');
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 30000 });
    await run('schematic.updatePcb');
    await page.waitForSelector('[data-testid="sync-preview"]', { timeout: 30000 });
    await page.locator('[data-testid="sync-preview"]').click();
    await page.waitForSelector('[data-testid="sync-report"]', { timeout: 90000 });
    const text = (await page.locator('[data-testid="sync-report"]').innerText()).replace(/\s+/g, ' ').slice(0, 300);
    await page.screenshot({ path: `${shots}/schematic-update-pcb.png` });
    await page.locator('.dialog .btn', { hasText: 'Close' }).click();
    log('update PCB (dry run):', text);
    record('updatepcb', /Preview:/.test(text), `SyncSchematicToBoard dry run reported: ${text.slice(0, 160)}`);
  }

  if (want('erc')) {
    await page.getByRole('tab', { name: 'ERC' }).click();
    await page.locator('.filter-bar button', { hasText: 'Run ERC' }).click();
    await page.waitForFunction(() => document.querySelector('[role=alert]') || document.querySelector('.marker-row'), null, { timeout: 60000 });
    const erc = await page.locator('[role=alert]').innerText().catch(async () => `${await page.locator('.marker-row').count()} markers`);
    log('ERC:', erc);
    await page.screenshot({ path: `${shots}/schematic-erc.png` });
    record('erc', /markers/.test(erc), erc);
  }
} catch (e) {
  console.error('!! proof aborted:', e);
  await page.screenshot({ path: `${shots}/proof-failure.png` }).catch(() => undefined);
  record('abort', false, e.message);
} finally {
  await browser.close();
  const list = await (await fetch(`${bridge}/sessions`)).json();
  for (const s of list.sessions) await fetch(`${bridge}/sessions/${s.id}`, { method: 'DELETE' });
  log('cleaned up', list.sessions.length, 'bridge sessions');
  if (!process.env.KEEP_PROOF) rmSync(proj, { recursive: true, force: true });
  else log('kept', proj);
}
log('SUMMARY');
for (const r of results) log(`  ${r.state} ${r.step}${r.detail ? ` — ${r.detail}` : ''}`);
process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
