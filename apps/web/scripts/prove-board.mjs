// Board practice pass (docs/06-routing.md, results in docs/board-practice.md): drives apps/web
// against a real KiCad through the bridge on one of the demo boards under e2e/fixtures/boards.
// Entered through `node apps/web/scripts/prove-kicad.mjs --board <name> [step,...]`; prerequisites
// are the same as the kitchen-sink proof, with the bridge's WORKSPACE_ROOT set to the fixtures
// directory (or any directory: the board is copied into `<workspace root>/.fp-pcb-practice-<name>/`
// so the fixture itself is never written).
//
// Steps (default all): open (timings, counts), view (zoom to fit, layers panel, hover, select),
// schematic (every sheet), edit (property edit → revision bump, undo), move (M tool), route (the
// unrouted variant: five nets by hand with V layer switches, RefillZones, DRC, undo, save, gerbers +
// drill, reopen in a fresh server session), autoroute (a fresh unrouted copy through Route ->
// Autoroute...: FabRouter on the bridge on every board that allows it, then Freerouting on the
// bridge where the board asks for it and FREEROUTING_JAR is set — summary, RefillZones + DRC, undo;
// AUTOROUTE_PASSES overrides Freerouting's -mp, default 20). Screenshots go to
// docs/screenshots/boards/<name>-*.png, the machine-readable result to e2e/output/board-practice/<name>.json.
import { chromium } from "../../../e2e/node_modules/@playwright/test/index.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const base = process.env.APP_URL ?? "http://localhost:5173";
const bridge = process.env.BRIDGE_URL ?? "http://127.0.0.1:4020";
const shots = resolve(repo, "docs/screenshots/boards");
const outDir = resolve(repo, "e2e/output/board-practice");
const fixtures = resolve(repo, "e2e/fixtures/boards");

/** The five practice boards: fixture directory and project base name. */
export const BOARDS = {
  ecc83: { dir: "ecc83", project: "ecc83-pp", autoroute: { js: true, freerouting: false } },
  sonde_xilinx: { dir: "sonde_xilinx", project: "sonde xilinx", autoroute: { js: true, freerouting: false } },
  // the JS router times out after 800 s on interf_u (docs/router-comparison.md): not worth a practice run
  interf_u: { dir: "interf_u", project: "interf_u", autoroute: { js: false, freerouting: true } },
  pic_programmer: { dir: "pic_programmer", project: "pic_programmer", autoroute: { js: true, freerouting: false } },
  // the JS router fails its precheck on stickhub; Freerouting reached 113/128 in the bench
  stickhub: { dir: "stickhub", project: "StickHub", autoroute: { js: true, freerouting: true } },
};

const argv = process.argv.slice(2);
const name = argv[argv.indexOf("--board") + 1];
const board = BOARDS[name];
if (!board) {
  console.error(`unknown board "${name}"; one of ${Object.keys(BOARDS).join(", ")}`);
  process.exit(2);
}
const stepsArg = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--board")[0];
const only = stepsArg ? new Set(stepsArg.split(",")) : null;
const want = (s) => !only || only.has(s);
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
const log = (...a) => console.log("##", elapsed(), ...a);
const results = [];
const record = (step, ok, detail, opts = {}) => {
  const state = ok ? "PASS" : opts.knownGap ? "GAP" : "FAIL";
  results.push({ board: name, step, ok: ok || !!opts.knownGap, state, detail });
  log(`${state} ${step}${detail ? `: ${detail}` : ""}`);
};
const timings = {};
mkdirSync(shots, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- practice copy inside the workspace root
const health = await (await fetch(`${bridge}/health`)).json();
const root = health.workspaceRoot.replace(/\/$/, "");
const proj = `${root}/.fp-pcb-practice-${name}`;
rmSync(proj, { recursive: true, force: true });
cpSync(`${fixtures}/${board.dir}`, proj, { recursive: true });
const pro = `${proj}/${board.project}.kicad_pro`;
const unroutedPro = `${proj}/${board.project}.unrouted.kicad_pro`;
const unroutedPcb = `${proj}/${board.project}.unrouted.kicad_pcb`;
log("practice copy", proj);

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") {
    const t = `${m.text().slice(0, 300)}${m.location()?.url ? ` @ ${m.location().url}` : ""}`;
    consoleErrors.push(t);
    console.log("console:", t.slice(0, 260));
  }
});
page.on("pageerror", (e) => {
  consoleErrors.push(`pageerror: ${e.message}`);
  console.log("pageerror:", e.message);
});
page.on("crash", () => console.log("!! page crashed (renderer)"));
// First paint: the first WebGL draw call with geometry, stamped relative to navigation start.
await page.addInitScript(() => {
  // `__itemsAt`: the board store first holds items; `__firstDraw`: the first GL draw call after that
  const poll = setInterval(() => {
    try {
      const b = window.__fpPcb?.services?.documents?.board?.();
      if (b && !b.all()[Symbol.iterator]().next().done) {
        window.__itemsAt = performance.now();
        clearInterval(poll);
      }
    } catch {
      /* not ready */
    }
  }, 10);
  const stamp = (proto, fn) => {
    const orig = proto[fn];
    proto[fn] = function (...a) {
      if (window.__firstDraw === undefined && window.__itemsAt !== undefined) window.__firstDraw = performance.now();
      return orig.apply(this, a);
    };
  };
  if (window.WebGL2RenderingContext) {
    stamp(WebGL2RenderingContext.prototype, "drawElements");
    stamp(WebGL2RenderingContext.prototype, "drawArrays");
  }
  if (window.WebGLRenderingContext) {
    stamp(WebGLRenderingContext.prototype, "drawElements");
    stamp(WebGLRenderingContext.prototype, "drawArrays");
  }
});

// ---------------------------------------------------------------- helpers
const kw = (fn, arg) => page.evaluate(fn, arg);
const rev = () => kw(async () => Number(await window.__fpPcb.services.documents.boardDoc.revision()));
const count = (type) => kw((type) => [...window.__fpPcb.services.documents.board().byType(type)].length, type);
const counts = async () => ({
  footprints: await count("KOT_PCB_FOOTPRINT"),
  pads: await count("KOT_PCB_PAD"),
  tracks: await count("KOT_PCB_TRACE"),
  arcs: await count("KOT_PCB_ARC"),
  vias: await count("KOT_PCB_VIA"),
  zones: await count("KOT_PCB_ZONE"),
  shapes: await count("KOT_PCB_SHAPE"),
  texts: await count("KOT_PCB_TEXT"),
});
const run = (id, opts = {}) =>
  kw(
    ({ id, wait }) => {
      const p = window.__fpPcb.runCommand(id);
      return wait ? p : undefined;
    },
    { id, wait: !!opts.wait },
  );
const canvasBox = async (label) => page.locator(`canvas[aria-label="${label}"]`).boundingBox();
const screenPt = (key, x, y) => kw(({ key, x, y }) => window.__fpPcb.host(key).worldToScreen(x, y), { key, x, y });
async function clickWorld(label, key, x, y, opts = {}) {
  const box = await canvasBox(label);
  const p = await screenPt(key, x, y);
  if (p.x < 0 || p.y < 0 || p.x > box.width || p.y > box.height)
    throw new Error(`world point (${x / 1e6}, ${y / 1e6}) mm is off the ${label} (${p.x.toFixed(0)}, ${p.y.toFixed(0)} px)`);
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
const focusCanvas = () => page.locator(".statusbar").click();
const waitRev = async (after, timeout = 30000) =>
  page.waitForFunction((r) => window.__fpPcb.services.documents.boardDoc.revision().then((v) => Number(v) > r), after, { timeout });
/** Text of an element that may be absent (no auto-wait: locator.innerText would block 30 s). */
const textOf = async (sel) => ((await page.locator(sel).count()) ? page.locator(sel).first().innerText() : "");
const toolHint = () => textOf('[data-testid="tool-hint"]');
const statusText = () =>
  page
    .locator(".statusbar")
    .innerText()
    .then((t) => t.replace(/\s+/g, " ").trim());
const appLog = () => kw(() => (window.__fpPcb.stores.log.getState().lines ?? []).map((e) => `[${e.level}] ${e.text}`));
const shot = (suffix) => page.screenshot({ path: `${shots}/${name}-${suffix}.png` });
const mm = (v) => Math.round(v * 1e6);
const fmt = (nm) => (nm / 1e6).toFixed(2);

/** Opens a project and waits for the board canvas + open session; returns the timings (ms since goto). */
async function openProject(path, label) {
  const tStart = Date.now();
  await page.goto(`${base}/?project=${encodeURIComponent(path)}`);
  await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 120000 });
  const tCanvas = Date.now() - tStart;
  await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("open · KiCad"), null, { timeout: 120000 });
  const tOpen = Date.now() - tStart;
  await page.waitForFunction(() => window.__firstDraw !== undefined, null, { timeout: 120000 });
  const firstDraw = await kw(() => Math.round(window.__firstDraw));
  const itemsAt = await kw(() => Math.round(window.__itemsAt));
  // the server-side pad polygons and text shapes upgrade the first (fallback) paint
  await page
    .waitForFunction(
      () => (window.__fpPcb.stores.log.getState().lines ?? []).some((l) => /text shapes from GetTextAsShapes/.test(l.text)),
      null,
      { timeout: 120000 },
    )
    .catch(() => undefined);
  const tShapes = Date.now() - tStart;
  await page.waitForTimeout(500);
  await kw(() => window.__fpPcb.stores.ui.getState().setGrid(10_000));
  await kw(() => window.__fpPcb.host("board").zoomToFit());
  await page.waitForTimeout(300);
  const t = { canvasMs: tCanvas, sessionOpenMs: tOpen, storeItemsMs: itemsAt, firstDrawMs: firstDraw, serverShapesMs: tShapes };
  timings[label] = t;
  log(
    `${label}: canvas ${tCanvas} ms, session open ${tOpen} ms, store items ${itemsAt} ms, first content draw ${firstDraw} ms, server shapes ${tShapes} ms (ms since navigation)`,
  );
  return t;
}

/** Frames the world box (nm) in the board canvas with some margin. */
async function frame(key, a, b, marginMm = 4) {
  const box = await canvasBox(`${key === "board" ? "board" : "schematic"} canvas`);
  const w = Math.abs(b.x - a.x) + 2 * mm(marginMm);
  const h = Math.abs(b.y - a.y) + 2 * mm(marginMm);
  const zoom = Math.min(box.width / w, box.height / h);
  await kw(({ key, cam }) => window.__fpPcb.host(key).setCamera(cam), { key, cam: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, zoom } });
  await page.waitForTimeout(150);
}

const F_CU = 3; // kiapi BoardLayer.BL_F_Cu
const B_CU = 34; // kiapi BoardLayer.BL_B_Cu

/** Pads grouped by net with their copper layers (padStack.layers), for choosing nets to route. */
const padsByNet = () =>
  kw(
    ({ F_CU, B_CU }) => {
      const out = {};
      for (const p of window.__fpPcb.services.documents.board().byType("KOT_PCB_PAD")) {
        if (!p.net) continue;
        const layers = p.proto.padStack?.layers ?? [];
        (out[p.net] ??= []).push({
          id: p.id,
          x: Number(p.proto.position.xNm),
          y: Number(p.proto.position.yNm),
          front: layers.includes(F_CU),
          back: layers.includes(B_CU),
          number: p.proto.number,
          parent: p.parent,
        });
      }
      return out;
    },
    { F_CU, B_CU },
  );

try {
  // ---------------------------------------------------------------- open
  await openProject(pro, "open");
  const c0 = await counts();
  log("counts", JSON.stringify(c0));
  if (want("open")) {
    await shot("board");
    const version = (await textOf(".session-pill")).trim();
    record("open", c0.footprints > 0 && c0.pads > 0, `${version}; ${JSON.stringify(c0)}; ${JSON.stringify(timings.open)}`);
  }

  // ---------------------------------------------------------------- view
  if (want("view")) {
    await kw(() => window.__fpPcb.stores.ui.getState().setLeftTab("layers"));
    await page.waitForSelector(".layer-row", { timeout: 10000 });
    const layerRows = await page.locator(".layer-row").count();
    // hide B.Cu, screenshot, show it again
    const bcu = page.locator('.layer-row[title^="BL_B_Cu"]').first(); // rows show the user layer name (ecc83: bottom_cu), the title carries the id
    await bcu.locator("button.vis").click();
    await page.waitForTimeout(300);
    const hidden = await kw(() => window.__fpPcb.stores.editor.getState().docs.board?.hiddenLayers ?? null);
    await shot("layers");
    await bcu.locator("button.vis").click();
    await page.waitForTimeout(200);
    const shownAgain = await kw(() => window.__fpPcb.stores.editor.getState().docs.board?.hiddenLayers ?? null);
    // hover a pad: the status bar names the type, net and layer
    const fp = await kw(() => {
      const b = window.__fpPcb.services.documents.board();
      const routedNets = new Set([...b.byType("KOT_PCB_TRACE")].map((t) => t.net));
      const pads = [...b.byType("KOT_PCB_PAD")].filter((p) => p.parent);
      // a pad on an unrouted net (or none): where a track ends in a pad the smaller track wins the pick, as in KiCad
      const pad = pads.find((p) => !p.net) ?? pads.find((p) => !routedNets.has(p.net)) ?? pads[0];
      const f = b.get(pad.parent);
      return {
        id: f.id,
        x: Number(f.proto.position.xNm),
        y: Number(f.proto.position.yNm),
        ref: f.proto.referenceField?.text?.text?.text,
        pad: { x: Number(pad.proto.position.xNm), y: Number(pad.proto.position.yNm), net: pad.net, number: pad.proto.number },
      };
    });
    await frame("board", { x: fp.pad.x - mm(6), y: fp.pad.y - mm(6) }, { x: fp.pad.x + mm(6), y: fp.pad.y + mm(6) });
    await moveWorld("board canvas", "board", fp.pad.x, fp.pad.y);
    await page.waitForTimeout(400);
    const hoverText = await textOf(".statusbar .msg");
    // select the footprint: click one of its pads (the pick returns the pad; the footprint owns it)
    await clickWorld("board canvas", "board", fp.pad.x, fp.pad.y);
    await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("selected"), null, { timeout: 10000 });
    const selected = await kw(() => window.__fpPcb.stores.editor.getState().docs.board.selection);
    const selType = await kw(
      (ids) =>
        ids.map((id) => {
          const it = window.__fpPcb.services.documents.board().get(id);
          return it ? `${it.type}${it.net ? ` ${it.net}` : ""}` : id;
        }),
      selected,
    );
    const propsTitle = (await textOf(".props-title")).replace(/\s+/g, " ");
    await shot("selected");
    await kw(() => window.__fpPcb.host("board").zoomToFit());
    log(
      `view: ${layerRows} layer rows, B.Cu hidden -> ${JSON.stringify(hidden)?.slice(0, 80)}, hover "${hoverText}", click on ${fp.ref} pad ${fp.pad.number} selected ${JSON.stringify(selType)}, props "${propsTitle}"`,
    );
    record(
      "view",
      layerRows > 0 &&
        hidden?.includes("BL_B_Cu") &&
        shownAgain?.length === 0 &&
        selected.length === 1 &&
        /Pad/.test(hoverText) &&
        /KOT_PCB_PAD/.test(selType[0] ?? ""),
      `zoom to fit, ${layerRows} layer rows (B.Cu hidden and shown again), hover "${hoverText}", ${fp.ref} pad ${fp.pad.number} picked (${selType[0]}): props "${propsTitle}"`,
    );
  }

  // ---------------------------------------------------------------- schematic sheets
  if (want("schematic")) {
    const tSch = Date.now();
    await run("window.schematic");
    await page.waitForSelector('canvas[aria-label="schematic canvas"]', { timeout: 120000 });
    await page.waitForTimeout(1500);
    const flat = (s, acc = []) => {
      acc.push(s);
      for (const c of s.children) flat(c, acc);
      return acc;
    };
    const tree = await kw(() => window.__fpPcb.services.documents.sheets());
    const sheets = tree.flatMap((s) => flat(s));
    const perSheet = [];
    for (const [i, s] of sheets.entries()) {
      await kw((path) => window.__fpPcb.stores.app.getState().setActiveSheet(path), s.path);
      await page.waitForFunction((path) => !!window.__fpPcb.host(`schematic:${path}`), s.path, { timeout: 30000 });
      await page
        .waitForFunction(
          (path) => {
            const st = window.__fpPcb.services.documents.sheet(path);
            return !!st && [...st.all()].length > 0;
          },
          s.path,
          { timeout: 60000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(1200);
      await kw((path) => window.__fpPcb.host(`schematic:${path}`)?.zoomToFit(), s.path);
      await page.waitForTimeout(400);
      const c = await kw((path) => {
        const st = window.__fpPcb.services.documents.sheet(path);
        const out = {};
        if (!st) return out;
        for (const it of st.all()) out[it.type] = (out[it.type] ?? 0) + 1;
        return out;
      }, s.path);
      await shot(`sheet-${i + 1}`);
      perSheet.push({
        name: s.name,
        file: s.file,
        path: s.path,
        symbols: c.KOT_SCH_SYMBOL ?? 0,
        lines: c.KOT_SCH_LINE ?? 0,
        labels: (c.KOT_SCH_LABEL ?? 0) + (c.KOT_SCH_GLOBAL_LABEL ?? 0) + (c.KOT_SCH_HIER_LABEL ?? 0),
        sheets: c.KOT_SCH_SHEET ?? 0,
        total: Object.values(c).reduce((a, b) => a + b, 0),
      });
      log(`sheet ${i + 1}/${sheets.length} ${s.name} (${s.file}): ${JSON.stringify(c)}`);
    }
    timings.schematic = { openMs: Date.now() - tSch, sheets: sheets.length };
    record(
      "schematic",
      sheets.length > 0 && perSheet.every((s) => s.symbols > 0),
      `${sheets.length} sheet(s): ${perSheet.map((s) => `${s.name} ${s.symbols} symbols / ${s.lines} lines / ${s.labels} labels`).join("; ")}`,
    );
    await run("window.board");
    await page.waitForSelector('canvas[aria-label="board canvas"]', { timeout: 30000 });
    await page.waitForTimeout(800);
    // returning to the board must not refetch every pad polygon (the caches are per store)
    const refetches = (await appLog()).filter((l) => /pad polygons from GetPadShapeAsPolygon/.test(l)).length;
    log(`board tab restored: ${refetches} GetPadShapeAsPolygon round(s) logged so far`);
    timings.padPolygonRounds = refetches;
  }

  // ---------------------------------------------------------------- edit a property
  const firstFp = async () =>
    kw(() => {
      const f =
        [...window.__fpPcb.services.documents.board().byType("KOT_PCB_FOOTPRINT")].find((f) => !f.proto.locked) ??
        [...window.__fpPcb.services.documents.board().byType("KOT_PCB_FOOTPRINT")][0];
      return { id: f.id, x: Number(f.proto.position.xNm), y: Number(f.proto.position.yNm), ref: f.proto.referenceField?.text?.text?.text };
    });
  if (want("edit")) {
    const fp = await firstFp();
    await kw((id) => window.__fpPcb.stores.editor.getState().setSelection("board", [id]), fp.id);
    await page.waitForSelector('input[data-path="position.xNm"]', { timeout: 10000 });
    const xField = page.locator('input[data-path="position.xNm"]');
    const shown = await xField.inputValue();
    const r0 = await rev();
    await xField.fill(String(fp.x / 1e6 + 1));
    await xField.press("Enter");
    await waitRev(r0);
    const r1 = await rev();
    const revs = [r1];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(150);
      revs.push(await rev());
    }
    if (new Set(revs).size > 1) log(`  GetDocumentRevision after the edit read ${revs.join(", ")} over 600 ms`);
    const after = await kw((id) => Number(window.__fpPcb.services.documents.board().get(id).proto.position.xNm), fp.id);
    await shot("edited");
    await focusCanvas();
    await page.keyboard.press("ControlOrMeta+z");
    await waitRev(r1);
    const undone = await kw((id) => Number(window.__fpPcb.services.documents.board().get(id).proto.position.xNm), fp.id);
    log(
      `edit: ${fp.ref} X field showed "${shown}", set ${fmt(fp.x + mm(1))}: revision ${r0} -> ${r1}, store X ${fmt(after)}; undo -> ${fmt(undone)} (revision ${await rev()})`,
    );
    record(
      "edit",
      Math.max(...revs) > r0 && after === fp.x + mm(1) && undone === fp.x,
      `${fp.ref}.X ${fmt(fp.x)} -> ${fmt(after)} mm bumped the revision ${r0} -> ${Math.max(...revs)}${new Set(revs).size > 1 ? ` (GetDocumentRevision read ${revs.join(", ")} in the 600 ms after the commit)` : ""}; undo restored ${fmt(undone)}`,
    );
  }

  // ---------------------------------------------------------------- move with the M tool
  if (want("move")) {
    const fp = await firstFp();
    await frame("board", { x: fp.x - mm(10), y: fp.y - mm(10) }, { x: fp.x + mm(10), y: fp.y + mm(10) });
    await kw((id) => window.__fpPcb.stores.editor.getState().setSelection("board", [id]), fp.id);
    await moveWorld("board canvas", "board", fp.x, fp.y);
    await page.waitForTimeout(200);
    const r0 = await rev();
    await focusCanvas();
    await moveWorld("board canvas", "board", fp.x, fp.y);
    await page.keyboard.press("m");
    await page.waitForTimeout(200);
    const moving = await textOf(".hint.tool");
    await moveWorld("board canvas", "board", fp.x + mm(3), fp.y + mm(2));
    await moveWorld("board canvas", "board", fp.x + mm(5), fp.y + mm(3));
    await page.waitForTimeout(200);
    await shot("moving");
    await clickWorld("board canvas", "board", fp.x + mm(5), fp.y + mm(3));
    await waitRev(r0);
    await page.waitForTimeout(400);
    const after = await kw((id) => {
      const f = window.__fpPcb.services.documents.board().get(id);
      return { x: Number(f.proto.position.xNm), y: Number(f.proto.position.yNm) };
    }, fp.id);
    const pads = await kw(
      (id) => [...window.__fpPcb.services.documents.board().byType("KOT_PCB_PAD")].filter((p) => p.parent === id).length,
      fp.id,
    );
    await shot("moved");
    const r1 = await rev();
    await page.keyboard.press("Escape");
    await focusCanvas();
    await page.keyboard.press("ControlOrMeta+z");
    await waitRev(r1).catch(() => undefined);
    const undone = await kw((id) => {
      const f = window.__fpPcb.services.documents.board().get(id);
      return { x: Number(f.proto.position.xNm), y: Number(f.proto.position.yNm) };
    }, fp.id);
    log(
      `move: ${fp.ref} "${moving}" (${fmt(fp.x)}, ${fmt(fp.y)}) -> (${fmt(after.x)}, ${fmt(after.y)}), ${pads} pads still owned; undo -> (${fmt(undone.x)}, ${fmt(undone.y)})`,
    );
    record(
      "move",
      /Moving/.test(moving) && after.x === fp.x + mm(5) && after.y === fp.y + mm(3) && undone.x === fp.x,
      `M tool dragged ${fp.ref} by (5, 3) mm through an open transaction, click committed (revision ${r0} -> ${r1}), undo restored it`,
    );
    await kw(() => window.__fpPcb.host("board").zoomToFit());
  }

  // ---------------------------------------------------------------- the unrouted variant
  if (want("route")) {
    const sessionsBefore = (await (await fetch(`${bridge}/sessions`)).json()).sessions.length;
    await openProject(unroutedPro, "open-unrouted");
    const cu = await counts();
    const unrouted0 = await kw(() => window.__fpPcb.services.board.unrouted().catch((e) => ({ error: e.message })));
    log("unrouted variant counts", JSON.stringify(cu), "GetUnroutedCount", JSON.stringify(unrouted0));
    await shot("unrouted");
    // pick nets: two-pad nets first, both pads reachable on F.Cu, 3..60 mm apart
    const nets = await padsByNet();
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const candidates = [];
    for (const [net, pads] of Object.entries(nets)) {
      if (pads.length < 2 || /GND|VCC|VDD|\+5V|\+3V3|\+3\.3V|VBUS/i.test(net)) continue;
      // both pads reachable on one side: route on that side (stickhub is assembled on B.Cu)
      let best = null;
      for (const side of ["front", "back"]) {
        const same = pads.filter((p) => p[side]);
        for (let i = 0; i < same.length; i++)
          for (let j = i + 1; j < same.length; j++) {
            const d = dist(same[i], same[j]);
            if (d >= mm(1.5) && d <= mm(60) && (!best || d < best.d)) best = { a: same[i], b: same[j], d, side };
          }
      }
      if (best) candidates.push({ net, ...best, padCount: pads.length });
    }
    // runs long enough for vias first (fine-pitch boards offer mostly short two-pad nets), then few pads, then long
    candidates.sort((p, q) => Number(q.d >= mm(4)) - Number(p.d >= mm(4)) || p.padCount - q.padCount || q.d - p.d);
    const chosen = candidates.slice(0, 5);
    log(
      `routing nets (${candidates.length} candidates):`,
      chosen.map((c) => `${c.net} (${c.padCount} pads, ${fmt(c.d)} mm, ${c.side})`).join(", "),
    );
    const routed = [];
    await page.locator('select[aria-label="Active layer"]').selectOption("BL_F_Cu");
    for (const c of chosen) {
      await frame("board", c.a, c.b, 3);
      const startLayer = c.side === "back" ? "BL_B_Cu" : "BL_F_Cu";
      const otherLayer = c.side === "back" ? "BL_F_Cu" : "BL_B_Cu";
      await page.locator('select[aria-label="Active layer"]').selectOption(startLayer); // a finished route leaves the layer where it ended (as KiCad does)
      const tr0 = await count("KOT_PCB_TRACE");
      const vi0 = await count("KOT_PCB_VIA");
      const r0 = await rev();
      await focusCanvas();
      await page.keyboard.press("Escape");
      await page.keyboard.press("x");
      const hint = await toolHint();
      // A → m1 (V: to B.Cu) → m2 (V: back to F.Cu unless B is a through-hole pad) → B
      const m1 = { x: Math.round(c.a.x + (c.b.x - c.a.x) / 3), y: Math.round(c.a.y + (c.b.y - c.a.y) / 3) };
      const m2 = { x: Math.round(c.a.x + (2 * (c.b.x - c.a.x)) / 3), y: Math.round(c.a.y + (2 * (c.b.y - c.a.y)) / 3) };
      await clickWorld("board canvas", "board", c.a.x, c.a.y);
      const pickedNet = await kw(() => window.__fpPcb.tools.activeTool()?.net ?? null);
      if (pickedNet !== c.net)
        log(
          `  pick at pad A: ${JSON.stringify(
            await kw(({ x, y }) => {
              const h = window.__fpPcb.host("board");
              const s = h.worldToScreen(x, y);
              return h
                .pick(s.x, s.y, 5)
                .slice(0, 4)
                .map((r) => `${r.layer}:${r.net ?? "-"}:${r.distance.toFixed(1)}px`);
            }, c.a),
          )}`,
        );
      let vias = 0;
      let segments = 2; // A → m1 → B; each V adds a click at the via
      let layerAfterV = startLayer;
      if (c.d >= mm(4)) {
        // V at a third: to the other side; a second V at two thirds back, unless pad B is through-hole
        await clickWorld("board canvas", "board", m1.x, m1.y);
        await moveWorld("board canvas", "board", m1.x, m1.y);
        await page.keyboard.press("v");
        layerAfterV = await kw(() => window.__fpPcb.stores.editor.getState().docs.board.activeLayer);
        vias = 1;
        if (!(c.b.front && c.b.back)) {
          await clickWorld("board canvas", "board", m2.x, m2.y);
          await moveWorld("board canvas", "board", m2.x, m2.y);
          await page.keyboard.press("v");
          vias = 2;
          segments = 3;
        }
      } else {
        // too short for vias: a straight run on the start layer (still through the route tool)
        await clickWorld("board canvas", "board", m1.x, m1.y);
      }
      await moveWorld("board canvas", "board", c.b.x, c.b.y);
      if (routed.length === 0) await shot("route-preview");
      await clickWorld("board canvas", "board", c.b.x, c.b.y);
      await page.keyboard.press("Enter");
      await waitRev(r0);
      await page.waitForTimeout(500);
      const tr1 = await count("KOT_PCB_TRACE");
      const vi1 = await count("KOT_PCB_VIA");
      const made = await kw(
        (net) => [...window.__fpPcb.services.documents.board().byType("KOT_PCB_TRACE")].filter((t) => t.net === net).map((t) => t.layer),
        c.net,
      );
      const ok =
        pickedNet === c.net &&
        tr1 === tr0 + segments &&
        vi1 === vi0 + vias &&
        made.length >= segments &&
        (vias === 0 || layerAfterV === otherLayer);
      routed.push({ net: c.net, ok, segments: tr1 - tr0, vias: vi1 - vi0, layers: made, pickedNet, hint, layerAfterV, side: c.side });
      log(
        `route ${c.net} (${c.side}): picked net "${pickedNet}", layer after V ${layerAfterV}, tracks ${tr0} -> ${tr1}, vias ${vi0} -> ${vi1}, layers ${JSON.stringify(made)}${ok ? "" : " !! unexpected"}`,
      );
      await focusCanvas();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await kw(() => window.__fpPcb.host("board").zoomToFit());
    await page.waitForTimeout(300);
    await shot("routed");
    const unrouted1 = await kw(() => window.__fpPcb.services.board.unrouted().catch((e) => ({ error: e.message })));
    record(
      "route",
      routed.length >= 5 && routed.every((r) => r.ok) && routed.some((r) => r.vias > 0),
      `${routed.length} nets routed by hand with the route tool (V switches side and back on runs over 4 mm): ${routed.map((r) => `${r.net} ${r.segments} seg/${r.vias} via${r.side === "back" ? " from B.Cu" : ""}${r.ok ? "" : " FAILED"}`).join(", ")}; unrouted ${unrouted0?.unroutedCount} -> ${unrouted1?.unroutedCount}`,
    );

    // refill zones
    const tZ = Date.now();
    const filledBefore = await kw(() =>
      [...window.__fpPcb.services.documents.board().byType("KOT_PCB_ZONE")].map((z) => z.proto.filledPolygons?.length ?? 0),
    );
    const refill = await kw(async () => {
      try {
        await window.__fpPcb.services.documents.refillZones();
        return "ok";
      } catch (e) {
        return e.message;
      }
    });
    await page.waitForTimeout(1500);
    const filledAfter = await kw(() =>
      [...window.__fpPcb.services.documents.board().byType("KOT_PCB_ZONE")].map((z) => ({
        name: z.proto.name,
        filled: z.proto.filled,
        sets: z.proto.filledPolygons?.length ?? 0,
      })),
    );
    timings.refillZonesMs = Date.now() - tZ;
    await shot("zones");
    log(`RefillZones: ${refill} in ${timings.refillZonesMs} ms; fills ${JSON.stringify(filledBefore)} -> ${JSON.stringify(filledAfter)}`);
    record(
      "refill",
      refill === "ok" && (filledAfter.length === 0 || filledAfter.some((z) => z.sets > 0)),
      `RefillZones ${refill} (${timings.refillZonesMs} ms): ${filledAfter.map((z) => `${z.name || "<zone>"} ${z.sets} polygon set(s)`).join(", ") || "no zones on this board"}`,
    );

    // DRC
    const tD = Date.now();
    await page.getByRole("tab", { name: "DRC" }).click();
    await page.locator(".filter-bar button", { hasText: "Run DRC" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("[role=alert]") ||
        document.querySelector(".marker-row") ||
        /0 markers|no markers/i.test(document.querySelector(".markers-panel, .panel")?.textContent ?? ""),
      null,
      { timeout: 300000 },
    );
    await page.waitForTimeout(800);
    timings.drcMs = Date.now() - tD;
    const alert = await textOf("[role=alert]");
    const markers = await kw(() =>
      window.__fpPcb.services.markers
        .markers("drc")
        .map((m) => ({ severity: m.severity, message: m.message ?? m.description, rule: m.rule ?? m.code })),
    );
    const rows = await page.locator(".marker-row").count();
    const byRule = {};
    for (const m of markers) byRule[m.rule ?? "?"] = (byRule[m.rule ?? "?"] ?? 0) + 1;
    await shot("drc");
    log(
      `DRC: ${markers.length} markers (${rows} rows) in ${timings.drcMs} ms${alert ? `; alert "${alert}"` : ""}; by rule ${JSON.stringify(byRule)}`,
    );
    record(
      "drc",
      !alert && rows === markers.length,
      alert ||
        `${markers.length} markers in ${timings.drcMs} ms: ${Object.entries(byRule)
          .map(([k, v]) => `${v}× ${k}`)
          .join(", ")}`,
    );

    // undo a few steps: each hand route was one commit
    await focusCanvas();
    const before = { tracks: await count("KOT_PCB_TRACE"), vias: await count("KOT_PCB_VIA") };
    const steps = [];
    for (let i = 0; i < 3; i++) {
      const r = await rev();
      await page.keyboard.press("ControlOrMeta+z");
      await waitRev(r, 20000).catch(() => undefined);
      await page.waitForTimeout(300);
      steps.push({ tracks: await count("KOT_PCB_TRACE"), vias: await count("KOT_PCB_VIA") });
    }
    const undoMode = await kw(() =>
      (window.__fpPcb.services.undo?.mode?.() ?? window.__fpPcb.services.undo?.stacks) ? "server" : "client",
    );
    log(
      `undo x3 (${undoMode}): tracks ${before.tracks} -> ${steps.map((s) => s.tracks).join(" -> ")}, vias ${before.vias} -> ${steps.map((s) => s.vias).join(" -> ")}`,
    );
    const lastRouted = routed.slice(-3).reverse();
    let expectT = before.tracks,
      expectV = before.vias,
      undoOk = true;
    for (const [i, r] of lastRouted.entries()) {
      expectT -= r.segments;
      expectV -= r.vias;
      if (steps[i].tracks !== expectT || steps[i].vias !== expectV) undoOk = false;
    }
    record(
      "undo",
      undoOk,
      `three undos removed the last three routes one commit each: tracks ${before.tracks} -> ${steps.map((s) => s.tracks).join(" -> ")}, vias ${before.vias} -> ${steps.map((s) => s.vias).join(" -> ")}`,
    );

    // save
    const saveResult = await kw(async () => {
      try {
        await window.__fpPcb.services.documents.save("board");
        return "ok";
      } catch (e) {
        return e.message;
      }
    });
    await page.waitForTimeout(800);
    const file = readFileSync(unroutedPcb, "utf8");
    const fileSegs = (file.match(/\(segment\b/g) ?? []).length;
    const fileVias = (file.match(/\(via\b/g) ?? []).length;
    const fileFilled = (file.match(/\(filled_polygon\b/g) ?? []).length;
    const storeT = await count("KOT_PCB_TRACE");
    const storeV = await count("KOT_PCB_VIA");
    log(
      `save: ${saveResult}; file has ${fileSegs} segments, ${fileVias} vias, ${fileFilled} filled polygons (store: ${storeT} tracks, ${storeV} vias)`,
    );
    record(
      "save",
      saveResult === "ok" && fileSegs === storeT && fileVias === storeV,
      `SaveDocument wrote ${fileSegs} segments + ${fileVias} vias + ${fileFilled} zone fill polygons to ${unroutedPcb.split("/").pop()}`,
    );

    // gerbers + drill
    const jobs = [];
    for (const id of ["board.gerbers", "board.drill"]) {
      const tJ = Date.now();
      const r = await kw(async (id) => {
        const j = window.__fpPcb.services.jobs;
        const def = j.jobs().find((d) => d.id === id);
        const o = {};
        for (const x of def.options) o[x.key] = x.default;
        const run = await j.run(id, o);
        return {
          state: run.state,
          error: run.error,
          outputs: run.outputs.map((f) => f.name),
          bytes: run.outputs.reduce((a, f) => a + f.bytes, 0),
        };
      }, id);
      jobs.push({ id, ...r, ms: Date.now() - tJ });
      log(
        `job ${id}: ${r.state}${r.error ? ` (${r.error.slice(0, 160)})` : ""} in ${Date.now() - tJ} ms: ${r.outputs.length} file(s), ${(r.bytes / 1024).toFixed(0)} KiB`,
      );
    }
    await page.getByRole("tab", { name: "Jobs" }).click();
    await page.waitForTimeout(300);
    await shot("jobs");
    record(
      "export",
      jobs.every((j) => j.state === "done" && j.outputs.length > 0),
      jobs
        .map(
          (j) =>
            `${j.id.replace("board.", "")}: ${j.outputs.length} files (${j.outputs.filter((f) => /\.(gbr|drl|gbrjob)$/i.test(f)).length} gbr/drl) in ${j.ms} ms`,
        )
        .join("; "),
    );

    // reopen in a fresh server session
    const list = await (await fetch(`${bridge}/sessions`)).json();
    for (const s of list.sessions) await fetch(`${bridge}/sessions/${s.id}`, { method: "DELETE" });
    await page.waitForTimeout(500);
    await openProject(unroutedPro, "reopen");
    const again = await counts();
    const routedNets = await kw(
      (nets) =>
        Object.fromEntries(
          nets.map((n) => [n, [...window.__fpPcb.services.documents.board().byType("KOT_PCB_TRACE")].filter((t) => t.net === n).length]),
        ),
      routed.map((r) => r.net),
    );
    await shot("reopened");
    const sessionsNow = (await (await fetch(`${bridge}/sessions`)).json()).sessions;
    log(
      `reopened (${sessionsBefore} sessions before, ${sessionsNow.length} now): ${JSON.stringify(again)}; segments per routed net ${JSON.stringify(routedNets)}`,
    );
    record(
      "reopen",
      again.tracks === storeT && again.vias === storeV,
      `fresh kicad-cli session: ${again.tracks} tracks / ${again.vias} vias persisted (${Object.entries(routedNets)
        .map(([n, c]) => `${n}: ${c}`)
        .join(", ")})`,
    );
  }
  // ---------------------------------------------------------------- autoroute (Route -> Autoroute...)
  if (want("autoroute")) {
    // a fresh unrouted copy: the route step saved its hand routes into the practice copy
    for (const f of [`${board.project}.unrouted.kicad_pcb`, `${board.project}.unrouted.kicad_pro`])
      cpSync(`${fixtures}/${board.dir}/${f}`, `${proj}/${f}`);
    const list0 = await (await fetch(`${bridge}/sessions`)).json();
    for (const s of list0.sessions) await fetch(`${bridge}/sessions/${s.id}`, { method: "DELETE" });
    await page.waitForTimeout(300);
    await openProject(unroutedPro, "open-autoroute");
    const unroutedCell = () => textOf('[data-testid="unrouted-count"]').then((t) => t.replace(/\s+/g, " ").trim());
    const currentRun = () =>
      kw(() => {
        const r = window.__fpPcb.services.autoroute?.current();
        return r ? { state: r.state, error: r.error, summary: r.summary, progress: r.progress, log: r.log.slice(-6) } : null;
      });
    const historyTop = () =>
      kw(async () => {
        const s = await window.__fpPcb.services.undo.stacks();
        return s.undo[s.undo.length - 1]?.description ?? null;
      });
    const availability = await kw(() => window.__fpPcb.services.autoroute.available());
    log("autoroute availability", JSON.stringify(availability));
    // AUTOROUTE_ROUTERS=js|freerouting|js,freerouting narrows the run (default: both the board allows)
    const only = new Set((process.env.AUTOROUTE_ROUTERS ?? "js,freerouting").split(","));
    const jsWanted = board.autoroute.js && only.has("js");
    const freeroutingWanted = board.autoroute.freerouting && only.has("freerouting") && !!process.env.FREEROUTING_JAR;
    if (board.autoroute.freerouting && !process.env.FREEROUTING_JAR)
      log(
        "Freerouting run skipped: set FREEROUTING_JAR (the bridge reports",
        availability.freerouting.ok ? "it available" : `"${availability.freerouting.reason}"`,
        ")",
      );

    /** Runs one router through the dialog; returns the finished run and the timings. */
    const runRouter = async (router, opts) => {
      const before = await counts();
      const unrouted0 = await unroutedCell();
      await run("board.autoroute");
      await page.waitForSelector('[data-testid="autoroute-router"]', { timeout: 10000 });
      await page.waitForTimeout(400);
      if (opts.shotDialog) await shot("autoroute-dialog");
      await page.locator('[data-testid="autoroute-router"]').selectOption(router);
      if (opts.passes) await page.locator('[data-testid="autoroute-passes"]').fill(String(opts.passes));
      if (opts.timeLimitS !== undefined) await page.locator('[data-testid="autoroute-time"]').fill(String(opts.timeLimitS));
      const tStart = Date.now();
      await page.locator('[data-testid="autoroute-run"]').click();
      await page.waitForSelector('[data-testid="autoroute-progress"]', { timeout: 10000 });
      // the tab must stay responsive while the in-tab router steps: time a trivial evaluate every second
      const lags = [];
      let shotTaken = false;
      let lastState = "";
      for (;;) {
        const t = Date.now();
        const r = await currentRun();
        lags.push(Date.now() - t);
        if (r && r.state !== lastState) {
          lastState = r.state;
          log(
            `  ${router}: ${r.state}${r.progress?.phase ? ` (${r.progress.phase}${r.progress.routed !== undefined ? `, ${r.progress.routed}/${r.progress.total}` : ""})` : ""}`,
          );
        }
        if (!shotTaken && r && r.state === "routing" && Date.now() - tStart > (opts.progressShotAfterMs ?? 3000)) {
          await shot(`autoroute-${opts.tag}-progress`);
          shotTaken = true;
        }
        if (r && ["done", "failed", "cancelled"].includes(r.state)) break;
        if (Date.now() - tStart > (opts.maxWaitMs ?? 900000)) {
          log("  giving up on the run; cancelling");
          await page
            .locator('[data-testid="autoroute-cancel"]')
            .click()
            .catch(() => undefined);
        }
        await page.waitForTimeout(1000);
      }
      const wallMs = Date.now() - tStart;
      const r = await currentRun();
      await page.waitForTimeout(800);
      const after = await counts();
      const unrouted1 = await unroutedCell();
      const top = await historyTop();
      await shot(`autoroute-${opts.tag}-${r.state === "done" ? "done" : "failed"}`);
      const maxLag = Math.max(...lags);
      log(
        `${router}: ${r.state} in ${wallMs} ms; summary ${JSON.stringify(r.summary ? { routed: r.summary.routed, total: r.summary.total, tracks: r.summary.tracks, vias: r.summary.vias, lengthMm: +(r.summary.trackLengthNm / 1e6).toFixed(1), wallMs: r.summary.wallMs, message: r.summary.message, unroutedAfter: r.summary.unroutedAfter } : null)}; error ${r.error ?? "-"}; tracks ${before.tracks} -> ${after.tracks}, vias ${before.vias} -> ${after.vias}; status bar "${unrouted0}" -> "${unrouted1}"; history top "${top}"; max evaluate lag ${maxLag} ms`,
      );
      if (r.log?.length) for (const l of r.log) log("   |", l.slice(0, 200));
      return { run: r, wallMs, before, after, unrouted0, unrouted1, top, maxLag };
    };

    /** The dialog's "Refill zones + run DRC", then the markers by rule. */
    const drcFromDialog = async (tag) => {
      const tD = Date.now();
      await page.locator('[data-testid="autoroute-drc"]').click();
      await page.waitForFunction(
        () => /DRC:|DRC failed/.test(document.querySelector('[data-testid="autoroute-summary"]')?.textContent ?? ""),
        null,
        { timeout: 600000 },
      );
      const markers = await kw(() =>
        window.__fpPcb.services.markers
          .markers("drc")
          .filter((m) => !m.excluded)
          .map((m) => ({ severity: m.severity, rule: m.rule })),
      );
      const byRule = {};
      for (const m of markers) byRule[`${m.severity}:${m.rule}`] = (byRule[`${m.severity}:${m.rule}`] ?? 0) + 1;
      await shot(`autoroute-${tag}-drc`);
      log(`${tag}: RefillZones + DRC in ${Date.now() - tD} ms: ${JSON.stringify(byRule)}`);
      return {
        ms: Date.now() - tD,
        byRule,
        errors: markers.filter((m) => m.severity === "error" && !/unconnected/i.test(m.rule)).length,
        unconnected: markers.filter((m) => /unconnected/i.test(m.rule)).length,
        warnings: markers.filter((m) => m.severity === "warning").length,
      };
    };

    /** Closes the dialog and undoes the autoroute commit; returns the counts afterwards. */
    const undoAutoroute = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await focusCanvas();
      const r0 = await rev();
      await page.keyboard.press("ControlOrMeta+z");
      await waitRev(r0, 60000).catch(() => undefined);
      await page.waitForTimeout(800);
      return counts();
    };

    if (jsWanted) {
      const js = await runRouter("fab-router", { tag: "js", shotDialog: true, timeLimitS: 240, maxWaitMs: 300000 });
      timings.autorouteJs = { wallMs: js.wallMs, state: js.run.state, maxEvaluateLagMs: js.maxLag };
      const s = js.run.summary;
      if (js.run.state === "done" && s && s.routed > 0) {
        const drc = await drcFromDialog("js");
        const undone = await undoAutoroute();
        const okUndo = undone.tracks === js.before.tracks && undone.vias === js.before.vias;
        log(
          `js undo: tracks ${js.after.tracks} -> ${undone.tracks}, vias ${js.after.vias} -> ${undone.vias}${okUndo ? "" : " !! unexpected"}`,
        );
        record(
          "autoroute-js",
          js.after.tracks === js.before.tracks + s.tracks && js.top === s.message && okUndo && js.maxLag < 2000,
          `FabRouter on the bridge: ${s.routed}/${s.total} connections, ${s.tracks} tracks, ${s.vias} vias, ${(s.trackLengthNm / 1e6).toFixed(1)} mm in ${(s.wallMs / 1000).toFixed(1)} s (dialog ${(js.wallMs / 1000).toFixed(1)} s, max ${js.maxLag} ms per evaluate); status bar "${js.unrouted0}" -> "${js.unrouted1}"; history "${js.top}"; RefillZones + DRC: ${drc.errors} errors, ${drc.unconnected} unconnected, ${drc.warnings} warnings; undo removed it (tracks ${js.after.tracks} -> ${undone.tracks})`,
        );
      } else {
        // the dialog must report the failure and leave the board alone
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        const untouched = js.after.tracks === js.before.tracks && js.after.vias === js.before.vias;
        const reported = !!(await textOf('[data-testid="autoroute-error"]').catch(() => "")) || js.run.state !== "done";
        record(
          "autoroute-js",
          untouched && (js.run.state === "failed" || js.run.state === "cancelled" || (s && s.routed === 0)) && js.maxLag < 2000,
          `FabRouter on the bridge ${js.run.state} after ${(js.wallMs / 1000).toFixed(1)} s: ${js.run.error ?? (s ? `${s.routed}/${s.total} routed` : "no summary")}; board untouched (tracks ${js.before.tracks} -> ${js.after.tracks}), dialog ${reported ? "reported it" : "did NOT report it"}, max evaluate lag ${js.maxLag} ms`,
          { knownGap: false },
        );
      }
    }

    if (freeroutingWanted) {
      const passes = Number(process.env.AUTOROUTE_PASSES ?? 20);
      const fr = await runRouter("freerouting", {
        tag: "freerouting",
        shotDialog: !jsWanted,
        passes,
        timeLimitS: 0,
        progressShotAfterMs: 20000,
        maxWaitMs: 1800000,
      });
      timings.autorouteFreerouting = { wallMs: fr.wallMs, state: fr.run.state, passes };
      const s = fr.run.summary;
      if (fr.run.state === "done" && s) {
        const drc = await drcFromDialog("freerouting");
        const undone = await undoAutoroute();
        const okUndo = undone.tracks === fr.before.tracks && undone.vias === fr.before.vias;
        log(
          `freerouting undo: tracks ${fr.after.tracks} -> ${undone.tracks}, vias ${fr.after.vias} -> ${undone.vias}${okUndo ? "" : " !! unexpected"}`,
        );
        record(
          "autoroute-freerouting",
          s.routed > 0 && fr.after.tracks === fr.before.tracks + s.tracks && fr.top === s.message && okUndo,
          `Freerouting on the bridge (-mp ${passes}): ${s.routed}/${s.total} connections, ${s.tracks} tracks, ${s.vias} vias, ${(s.trackLengthNm / 1e6).toFixed(1)} mm in ${(s.wallMs / 1000).toFixed(1)} s (dialog ${(fr.wallMs / 1000).toFixed(1)} s); status bar "${fr.unrouted0}" -> "${fr.unrouted1}"; history "${fr.top}"; RefillZones + DRC: ${drc.errors} errors, ${drc.unconnected} unconnected, ${drc.warnings} warnings; undo removed it (tracks ${fr.after.tracks} -> ${undone.tracks})`,
        );
      } else {
        await page.keyboard.press("Escape");
        record("autoroute-freerouting", false, `Freerouting ${fr.run.state}: ${fr.run.error ?? "no summary"}`);
      }
    }
  }
} catch (e) {
  console.error("!! practice aborted:", e);
  await page.screenshot({ path: `${shots}/${name}-failure.png` }).catch(() => undefined);
  record("abort", false, e.message);
} finally {
  const lines = await appLog().catch(() => []);
  const errors = lines.filter((l) => /^\[(error|warn)\]/.test(l));
  if (errors.length) {
    log(`${errors.length} warn/error line(s) in the app log:`);
    for (const l of errors.slice(0, 20)) console.log("   ", l.slice(0, 300));
  }
  await browser.close();
  const list = await (await fetch(`${bridge}/sessions`)).json();
  for (const s of list.sessions) await fetch(`${bridge}/sessions/${s.id}`, { method: "DELETE" });
  log("cleaned up", list.sessions.length, "bridge sessions");
  writeFileSync(
    `${outDir}/${name}.json`,
    JSON.stringify({ board: name, kicad: null, timings, results, consoleErrors, appErrors: errors }, null, 2),
  );
  if (!process.env.KEEP_PROOF) rmSync(proj, { recursive: true, force: true });
  else log("kept", proj);
}
log("SUMMARY", name);
for (const r of results) log(`  ${r.state} ${r.step}${r.detail ? ` — ${r.detail}` : ""}`);
log("timings", JSON.stringify(timings));
process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
