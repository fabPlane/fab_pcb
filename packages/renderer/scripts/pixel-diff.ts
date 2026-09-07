#!/usr/bin/env bun
/**
 * Pixel-diff harness: our renderer vs KiCad's own SVG export (the A5 exit test).
 *
 * One-step (needs kicad-cli, default: the sibling KiCad checkout's release build):
 *
 *   bun run scripts/pixel-diff.ts [--out DIR] [--px-per-mm 8] [--only board|schematic]
 *                                 [--board FILE.kicad_pcb] [--schematic FILE.kicad_sch]
 *                                 [--layers all|default|BL_F_Cu,BL_B_Cu,...] [--kicad-cli PATH]
 *                                 [--tolerance 1] [--ink 40] [--no-white-holes] [--pin-name-offset MM]
 *
 *   1. spawns `kicad-cli api-server` on a unique socket with a temp copy of the kitchen-sink
 *      project, opens the board and the schematic, loads their ItemStores, fetches the same
 *      server shapes the app feeds the hosts (GetPadShapeAsPolygon per copper layer,
 *      GetTextAsShapes for texts / fields / labels) and runs RunBoardJobExportSvg (fit page
 *      to board, scale 1, all requested layers on one page, no drawing sheet) and
 *      RunSchematicJobExportSvg (root sheet, no drawing sheet);
 *   2. writes `<out>/<kind>.snapshot.json` + `<out>/<kind>.svg`, kills the server;
 *   3. bundles scripts/pixel-diff/page.ts, serves it from a local port and drives a headless
 *      Chromium (Playwright; WebGL via SwiftShader) that renders the snapshot with the real
 *      BoardCanvasHost / SchematicCanvasHost at `px-per-mm`, rasterises the SVG at the same
 *      scale (the SVG viewBox is the world window: KiCad's SVG user unit is 1 mm at scale 1,
 *      offset 0), and compares the two as ink masks (pixel != white beyond `--ink`);
 *   4. writes `<out>/<kind>.ours.png`, `<kind>.svg.png`, `<kind>.diff.png`
 *      (grey = both, red = only KiCad, cyan = only ours; strong where outside the tolerance
 *      band) and `<out>/report.json`, and prints the mismatch figures.
 *
 * Two-step (no server needed): render + compare pre-exported inputs
 *
 *   bun run scripts/pixel-diff.ts --snapshot board.snapshot.json --svg board.svg [--out DIR] ...
 *
 * where the snapshot is what step 2 wrote (or any JSON of the same shape, see `Snapshot` in
 * pixel-diff/page.ts). `--export-only` stops after step 2 (produces the inputs for a later
 * two-step run on a machine without a KiCad build).
 *
 * Metrics (see README "Pixel-diff harness" for the tolerance): `mismatch` = XOR / all
 * pixels; `inkMismatch` = XOR / ink union (1 - IoU); `tolerant*` = the same after ignoring
 * pixels within `--tolerance` px of the other image's ink (anti-aliasing / stroke-width
 * differences do not count).
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { KiCad, NngIpcTransport, type Board, type ItemStore, type StoredItem } from '@fp-pcb/client';
import { BoardJobPaginationMode, BoardLayer, SchematicJobPageSize, ZoneType, unpackAny, type Text, type TextBox } from '@fp-pcb/proto';
import type { RunOptions, RunResult } from './pixel-diff/page.js';
import { dimensionText } from '../src/board/boardAdapter.js';
import { type SchTextRequest, resolveTextRequests, schematicTextRequests } from '../src/schematic/textRequests.js';

const here = dirname(fileURLToPath(import.meta.url));
const KICAD_ROOT = resolve(here, '..', '..', '..', '..', 'kicad');
const DEFAULT_CLI = `${KICAD_ROOT}/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli`;
const QA = process.env.KICAD_QA_DATA ?? `${KICAD_ROOT}/qa/data`;

// ---------------------------------------------------------------------------------- args

interface Args {
  out: string;
  pxPerMm: number;
  only?: 'board' | 'schematic';
  board: string;
  schematic: string;
  layers: 'all' | 'default' | string[];
  cli: string;
  tolerance: number;
  ink: number;
  whiteHoles: boolean;
  snapshot?: string;
  svg?: string;
  exportOnly: boolean;
  keepBrowser: boolean;
  /** schematic: pin-name offset (nm) to assume when a symbol reports 0 (see SchematicAdapterContext.assumePinNameOffset) */
  pinNameOffset?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    out: join(here, 'pixel-diff-out'),
    pxPerMm: 8,
    board: `${QA}/pcbnew/api_kitchen_sink.kicad_pcb`,
    schematic: `${QA}/eeschema/api_kitchen_sink.kicad_sch`,
    layers: 'default',
    cli: process.env.KICAD_CLI ?? DEFAULT_CLI,
    tolerance: 1,
    ink: 40,
    whiteHoles: true,
    exportOnly: false,
    keepBrowser: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = () => argv[++i] ?? '';
    switch (k) {
      case '--out':
        a.out = resolve(v());
        break;
      case '--px-per-mm':
        a.pxPerMm = Number(v());
        break;
      case '--only':
        a.only = v() as 'board' | 'schematic';
        break;
      case '--board':
        a.board = resolve(v());
        break;
      case '--schematic':
        a.schematic = resolve(v());
        break;
      case '--layers': {
        const s = v();
        a.layers = s === 'all' || s === 'default' ? s : s.split(',').map((l) => l.trim()).filter(Boolean);
        break;
      }
      case '--kicad-cli':
        a.cli = v();
        break;
      case '--tolerance':
        a.tolerance = Number(v());
        break;
      case '--ink':
        a.ink = Number(v());
        break;
      case '--no-white-holes':
        a.whiteHoles = false;
        break;
      case '--snapshot':
        a.snapshot = resolve(v());
        break;
      case '--svg':
        a.svg = resolve(v());
        break;
      case '--export-only':
        a.exportOnly = true;
        break;
      case '--keep-browser':
        a.keepBrowser = true;
        break;
      case '--pin-name-offset':
        a.pinNameOffset = Math.round(Number(v()) * 1e6); // mm
        break;
      case '-h':
      case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
      default:
        throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

// ---------------------------------------------------------------------------------- server

interface Server {
  kicad: KiCad;
  stop(): Promise<void>;
}

async function startServer(cli: string, projectFile: string, out: string): Promise<Server> {
  if (!existsSync(cli)) throw new Error(`kicad-cli not found at ${cli} (set KICAD_CLI or --kicad-cli, or use --snapshot/--svg)`);
  await mkdir('/tmp/kicad', { recursive: true });
  const socketPath = `/tmp/kicad/pixel-diff-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  const proc = Bun.spawn([cli, 'api-server', projectFile, '--socket', socketPath], { stdout: 'ignore', stderr: 'pipe' });
  const stderr: string[] = [];
  void (async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) stderr.push(new TextDecoder().decode(value));
    }
  })().catch(() => {});
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`kicad-cli exited with ${proc.exitCode}:\n${stderr.join('')}`);
    try {
      await stat(socketPath);
      break;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`timeout waiting for ${socketPath}`);
    }
    await Bun.sleep(25);
  }
  const transport = await NngIpcTransport.connect({ path: socketPath, defaultTimeoutMs: 120_000 });
  const kicad = await KiCad.connect(transport, { clientName: `fp-pcb/pixel-diff-${process.pid}`, readyTimeoutMs: 120_000 });
  return {
    kicad,
    async stop() {
      await transport.close().catch(() => {});
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        const t = setTimeout(() => proc.kill('SIGKILL'), 3000);
        await proc.exited;
        clearTimeout(t);
      }
      await rm(socketPath, { force: true });
      await rm(socketPath.replace(/\.sock$/, '-events.sock'), { force: true });
      if (stderr.length) await writeFile(join(out, 'kicad-cli.stderr.log'), stderr.join(''));
    },
  };
}

/** Temp copy of the project (board + schematic + project + DRU) with local library tables. */
async function tempProject(board: string, schematic: string): Promise<{ dir: string; pro: string; pcb: string; sch: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'fp-pcb-pixel-diff-'));
  const base = board.replace(/\.kicad_pcb$/, '');
  const name = basename(base);
  const pcb = join(dir, `${name}.kicad_pcb`);
  const pro = join(dir, `${name}.kicad_pro`);
  const sch = join(dir, `${basename(schematic)}`);
  await cp(board, pcb);
  if (existsSync(`${base}.kicad_pro`)) await cp(`${base}.kicad_pro`, pro);
  else await writeFile(pro, '{"meta":{"filename":"' + name + '.kicad_pro","version":1}}\n');
  if (existsSync(`${base}.kicad_dru`)) await cp(`${base}.kicad_dru`, join(dir, `${name}.kicad_dru`));
  await cp(schematic, sch);
  // sub-sheets (the kitchen sink's erc_test*, a hierarchical project's own sheets), project
  // libraries and lib tables next to the schematic travel with it
  const schDir = dirname(schematic);
  for (const f of await readdir(schDir)) {
    const src = join(schDir, f);
    const isSheet = f.endsWith('.kicad_sch') && f !== basename(schematic);
    const isLib = f.endsWith('.kicad_sym') || f.endsWith('.pretty') || f === 'libs' || f === 'fp-lib-table' || f === 'sym-lib-table';
    if (isSheet || isLib) await cp(src, join(dir, f), { recursive: true });
  }
  if (!existsSync(join(dir, 'fp-lib-table'))) await writeFile(join(dir, 'fp-lib-table'), `(fp_lib_table\n  (version 7)\n  (lib (name "Resistor_SMD") (type "KiCad") (uri "${QA}/libraries/Resistor_SMD.pretty") (options "") (descr ""))\n)\n`);
  if (!existsSync(join(dir, 'sym-lib-table'))) await writeFile(join(dir, 'sym-lib-table'), `(sym_lib_table\n  (version 7)\n  (lib (name "Device") (type "KiCad") (uri "${QA}/libraries/Device.kicad_sym") (options "") (descr ""))\n)\n`);
  return { dir, pro, pcb, sch, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------------- snapshots

/** JSON replacer: bigint -> decimal string (the adapters accept it), bytes -> { $bytes }. */
function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') };
  return v;
}

const num = (v: bigint | number | undefined): number => (typeof v === 'bigint' ? Number(v) : (v ?? 0));

/** Footprint children arrive as `Any`; the renderer wants decoded messages. */
function decodeFootprintChildren(proto: Record<string, any>): void {
  const items = proto.definition?.items as Array<Record<string, any>> | undefined;
  if (!items) return;
  proto.definition.items = items.map((it) => (it?.$typeName === 'google.protobuf.Any' ? (unpackAny(it as never) ?? it) : it));
}

/** Symbol children arrive as `Any` too (`SchematicSymbolInstance.definition.items[].item`). */
function decodeSymbolChildren(proto: Record<string, any>): void {
  const items = proto.definition?.items as Array<Record<string, any>> | undefined;
  if (!items) return;
  for (const entry of items) {
    const it = entry?.item;
    if (it?.$typeName === 'google.protobuf.Any') entry.item = unpackAny(it as never) ?? it;
  }
}

function hashText(t: Text): string {
  const a = t.attributes;
  const p = t.position;
  return [t.text, num(p?.xNm), num(p?.yNm), a?.angle?.valueDegrees, num(a?.size?.xNm), num(a?.size?.yNm), num(a?.strokeWidth?.valueNm), a?.horizontalAlignment, a?.verticalAlignment, a?.italic, a?.bold, a?.mirrored].join('|');
}

/**
 * A `textbox` request lays its glyphs out at the box (KiCad >= 11.0: `layOutTextBox` in
 * `api_handler_common.cpp` breaks the text to the column width and anchors it by the box's
 * justification and margins), so board text boxes and table cells ask for server glyphs like
 * any other text. The reply also carries the four box edges as segments whatever
 * `border_enabled` says; the adapter drops them and draws the border from `border_stroke`.
 */
interface TextRef {
  key: string;
  text?: Text;
  textbox?: TextBox;
}

/**
 * Schematic requests come from the renderer's own builder (`schematicTextRequests`), keyed and
 * placed exactly as the adapter draws them -- the same module the app feeds `TextShapeCache`
 * with -- so the harness measures what the app draws. Some symbol fields carry a `measure`
 * (`GetTextExtents`) stage that `resolveTextRequests` turns into the final `text`.
 */
type SchRef = SchTextRequest;

/**
 * The `GetTextAsShapes` request for a dimension. `text.text` is the bare measurement
 * (`26.5000`) while the plotter draws `Dimension.resolved_text` (`26.5000 mm`, `R 2.1506 mm`,
 * a leader's override text), so the glyphs have to be laid out for *that* string or they are
 * short and land off-centre. An empty `resolved_text` means the dimension plots no text at
 * all (a centre dimension) and no request is made. `dimensionText` also carries the
 * older-server fallback; apps/web `KicadCanvas.ts` `boardTexts` needs the same two lines.
 */
function dimensionRefs(key: string | undefined, p: Record<string, any>): TextRef[] {
  const text = p.text as Text | undefined;
  const shown = dimensionText(p);
  if (!key || !text || !shown) return [];
  return [{ key, text: { ...text, text: shown } }];
}

/** Same keys as apps/web KicadCanvas.ts `boardTexts`. */
function boardTexts(it: StoredItem): TextRef[] {
  const p = it.proto as Record<string, any>;
  const out: TextRef[] = [];
  const push = (key: string | undefined, text: Text | undefined) => {
    if (key && text && text.text) out.push({ key, text });
  };
  const pushBox = (key: string | undefined, textbox: TextBox | undefined) => {
    if (key && textbox && textbox.text) out.push({ key, textbox });
  };
  switch (it.type) {
    case 'KOT_PCB_TEXT':
      push(it.id, p.text);
      break;
    case 'KOT_PCB_DIMENSION':
      out.push(...dimensionRefs(it.id, p));
      break;
    case 'KOT_PCB_TEXTBOX':
      pushBox(it.id, p.textbox);
      break;
    case 'KOT_PCB_TABLE':
      for (const cell of p.cells ?? []) pushBox(cell?.textBox?.id?.value, cell?.textBox?.textbox);
      break;
    case 'KOT_PCB_FIELD':
      push(p.text?.id?.value, p.text?.text);
      break;
    case 'KOT_PCB_FOOTPRINT':
      for (const f of [p.referenceField, p.valueField, p.datasheetField, p.descriptionField, ...(p.userFields ?? [])]) push(f?.text?.id?.value, f?.text?.text);
      for (const child of p.definition?.items ?? []) {
        const c = child as Record<string, any>;
        if (c?.$typeName === 'kiapi.board.types.BoardText') push(c.id?.value, c.text);
        if (c?.$typeName === 'kiapi.board.types.BoardTextBox') pushBox(c.id?.value, c.textbox);
      }
      break;
    default:
      break;
  }
  return out;
}

async function fetchTextShapes(kicad: KiCad, refs: Array<TextRef | SchRef>): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const seen = new Map<string, TextRef | SchRef>();
  for (const r of refs) if (!seen.has(r.key) || seen.get(r.key) !== r) seen.set(r.key, r);
  // symbol fields that need their KiCad text box first (one GetTextExtents each)
  const measured = await resolveTextRequests([...seen.values()].filter((r): r is SchRef => 'hash' in r), (t) => kicad.textExtents(t as never));
  const list = [...seen.values()].filter((r) => !('hash' in r) || measured.includes(r));
  for (let i = 0; i < list.length; i += 200) {
    const slice = list.slice(i, i + 200);
    const res = await kicad.textAsShapes(slice.map((r) => (r.textbox ? { textbox: r.textbox as TextBox } : { text: r.text as Text })));
    res.forEach((r, j) => {
      out[slice[j]!.key] = r.shapes?.shapes ?? [];
    });
  }
  void hashText;
  return out;
}

function layerName(l: BoardLayer): string {
  return BoardLayer[l] ?? `BL_${l}`;
}

const DEFAULT_SKIP = /_(Mask|Paste|Adhes)$/;

async function exportBoard(kicad: KiCad, board: Board, args: Args, out: string): Promise<{ snapshot: string; svg: string }> {
  await board.documentSync.load();
  const store: ItemStore = board.store;
  const enabled = await board.enabledLayers();
  const enabledNames = enabled.layers.map(layerName);
  const copperLayers = enabledNames.filter((l) => l.endsWith('_Cu'));
  let plotLayers: string[];
  if (args.layers === 'all') plotLayers = enabledNames.filter((l) => l !== 'BL_UNKNOWN');
  else if (args.layers === 'default') plotLayers = enabledNames.filter((l) => l !== 'BL_UNKNOWN' && !DEFAULT_SKIP.test(l));
  else plotLayers = args.layers;
  const items: StoredItem[] = [];
  const padIds = new Set<string>();
  const texts: TextRef[] = [];
  for (const it of store.all()) {
    const proto = it.proto as Record<string, any>;
    // `PCB_REFERENCE_IMAGE_T: // Not plotted at all` (plot_brditems_plotter.cpp): the renderer
    // draws them, the SVG export never does, so they are left out of the comparison.
    if (it.type === 'KOT_PCB_REFERENCE_IMAGE') continue;
    // Rule areas are skipped by every plot path (`if( zone->GetIsRuleArea() ) continue;`,
    // plot_board_layers.cpp), while the renderer draws them like pcbnew does.
    if (it.type === 'KOT_PCB_ZONE' && proto.type === ZoneType.ZT_RULE_AREA) continue;
    if (it.type === 'KOT_PCB_FOOTPRINT') decodeFootprintChildren(proto);
    if (it.type === 'KOT_PCB_PAD') padIds.add(it.id);
    if (it.type === 'KOT_PCB_FOOTPRINT') for (const c of proto.definition?.items ?? []) if (c?.$typeName === 'kiapi.board.types.Pad' && c.id?.value) padIds.add(c.id.value);
    texts.push(...boardTexts(it));
    items.push({ id: it.id, type: it.type, layer: it.layer, net: it.net, parent: it.parent, proto } as StoredItem);
  }
  console.log(`board: ${items.length} items, ${padIds.size} pads, ${texts.length} texts; copper ${copperLayers.join(' ')}`);
  const padPolygons: Record<string, unknown> = {};
  const ids = [...padIds];
  for (const layer of copperLayers) {
    const enumValue = BoardLayer[layer as keyof typeof BoardLayer];
    if (typeof enumValue !== 'number') continue;
    const res = await board.padShapesAsPolygons(ids, enumValue);
    for (const [id, poly] of res) padPolygons[`${id}/${layer}`] = [poly];
  }
  const textShapes = await fetchTextShapes(kicad, texts);
  console.log(`board: ${Object.keys(padPolygons).length} pad polygons, ${Object.keys(textShapes).length} text shapes from the server`);
  const svgPath = join(out, 'board.svg');
  const layerEnums = plotLayers.map((l) => BoardLayer[l as keyof typeof BoardLayer]).filter((v): v is BoardLayer => typeof v === 'number');
  const job = await board.jobs.exportSvg(svgPath, {
    fitPageToBoard: true,
    precision: 4,
    pageMode: BoardJobPaginationMode.BJPM_ALL_LAYERS_ONE_PAGE,
    plotSettings: {
      layers: layerEnums,
      scale: 1,
      plotDrawingSheet: false,
      blackAndWhite: false,
      plotFootprintValues: true,
      plotReferenceDesignators: true,
      sketchPadsOnFabLayers: false,
    },
  });
  const produced = job.outputPaths.find((p) => p.endsWith('.svg')) ?? svgPath;
  if (produced !== svgPath) await cp(produced, svgPath);
  console.log(`board: RunBoardJobExportSvg -> ${produced} (${job.message || job.status})`);
  const snapshot = join(out, 'board.snapshot.json');
  await writeFile(snapshot, JSON.stringify({ kind: 'board', copperLayers, layers: plotLayers, items, padPolygons, textShapes }, replacer));
  return { snapshot, svg: svgPath };
}

async function exportSchematic(kicad: KiCad, schPath: string, args: Args, out: string): Promise<{ snapshot: string; svg: string }> {
  const schematic = await kicad.openSchematic(schPath);
  const root = await schematic.rootSheet();
  await root.documentSync.load();
  const items: StoredItem[] = [];
  const texts: SchRef[] = [];
  // adapter options shared with the page (snapshot.adapter): the requests must be built with the options the host draws with
  const adapter = { symbolPinsAbsolute: true, ...(args.pinNameOffset ? { assumePinNameOffset: args.pinNameOffset } : {}) };
  for (const it of root.store.all()) {
    const proto = it.proto as Record<string, any>;
    if (it.type === 'KOT_SCH_SYMBOL') decodeSymbolChildren(proto);
    // the same requests apps/web builds (renderer `schematicTextRequests`)
    texts.push(...schematicTextRequests({ id: it.id, type: it.type, proto }, adapter));
    items.push({ id: it.id, type: it.type, layer: it.layer, net: it.net, parent: it.parent, proto } as StoredItem);
  }
  const measured = texts.filter((t) => t.measure).length;
  const textShapes = await fetchTextShapes(kicad, texts);
  console.log(`schematic: ${items.length} items on the root sheet, ${texts.length} text requests (${measured} measured first), ${Object.keys(textShapes).length} text shapes`);
  const dir = join(out, 'schematic-svg');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const job = await schematic.jobs.exportSvg(dir, {
    plotSettings: { plotDrawingSheet: false, plotAll: false, pageSize: SchematicJobPageSize.SJPS_AUTO, blackAndWhite: false, useBackgroundColor: false, minPenWidth: 0 },
  });
  const files = (await readdir(dir)).filter((f) => f.endsWith('.svg')).sort();
  console.log(`schematic: RunSchematicJobExportSvg -> ${files.join(', ') || job.outputPaths.join(', ')} (${job.message || job.status})`);
  const base = basename(schPath, '.kicad_sch');
  const rootFile = files.find((f) => f === `${base}.svg`) ?? files.find((f) => !/-/.test(f)) ?? files[0];
  if (!rootFile) throw new Error('schematic SVG export produced no .svg');
  const svgPath = join(out, 'schematic.svg');
  await cp(join(dir, rootFile), svgPath);
  const snapshot = join(out, 'schematic.snapshot.json');
  await writeFile(snapshot, JSON.stringify({ kind: 'schematic', copperLayers: [], layers: [], items, padPolygons: {}, textShapes, adapter }, replacer));
  return { snapshot, svg: svgPath };
}

// ---------------------------------------------------------------------------------- browser

function parseViewBox(svg: string): { x: number; y: number; w: number; h: number } {
  const m = /viewBox="([^"]+)"/.exec(svg);
  if (!m) throw new Error('SVG has no viewBox');
  const [x, y, w, h] = m[1]!.trim().split(/[\s,]+/).map(Number);
  if (![x, y, w, h].every((v) => Number.isFinite(v))) throw new Error(`bad viewBox ${m[1]}`);
  return { x: x!, y: y!, w: w!, h: h! };
}

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>pixel-diff</title><style>html,body{margin:0;background:#fff}</style><script type="module" src="/page.js"></script>`;

async function compare(kind: 'board' | 'schematic', snapshotPath: string, svgPath: string, args: Args, out: string): Promise<RunResult & { kind: string; viewBox: ReturnType<typeof parseViewBox> }> {
  const svgText = await readFile(svgPath, 'utf8');
  const viewBox = parseViewBox(svgText);
  const snapJson = await readFile(snapshotPath, 'utf8');
  const snap = JSON.parse(snapJson) as { layers?: string[] };
  const maxPx = 8192;
  let pxPerMm = args.pxPerMm;
  if (Math.max(viewBox.w, viewBox.h) * pxPerMm > maxPx) {
    pxPerMm = maxPx / Math.max(viewBox.w, viewBox.h);
    console.log(`${kind}: clamping to ${pxPerMm.toFixed(2)} px/mm (${maxPx} px max)`);
  }
  const build = await Bun.build({ entrypoints: [join(here, 'pixel-diff', 'page.ts')], outdir: out, naming: 'page.js', target: 'browser', format: 'esm', minify: false });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error('page bundle failed');
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/') return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html' } });
      if (path === '/page.js') return new Response(Bun.file(join(out, 'page.js')));
      if (path === '/snapshot.json') return new Response(snapJson, { headers: { 'content-type': 'application/json' } });
      if (path === '/doc.svg') return new Response(svgText, { headers: { 'content-type': 'image/svg+xml' } });
      return new Response('not found', { status: 404 });
    },
  });
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`  [browser ${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => console.log(`  [browser error] ${e.message}`));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => !!(window as unknown as { pixelDiff?: unknown }).pixelDiff, null, { timeout: 30_000 });
    const layers = kind === 'board' ? [...(snap.layers ?? []), ...(args.whiteHoles ? ['board.via_hole', 'board.pad_plated_hole', 'board.plated_hole'] : [])] : [];
    const opts: RunOptions = { pxPerMm, viewBox, layers, hide: [], inkThreshold: args.ink, tolerancePx: args.tolerance, whiteHoles: kind === 'board' && args.whiteHoles };
    const result = (await page.evaluate(
      async (o) => {
        const snapshot = await (await fetch('/snapshot.json')).text();
        const svg = await (await fetch('/doc.svg')).text();
        return (window as unknown as { pixelDiff: { run: (s: string, v: string, o: unknown) => Promise<unknown> } }).pixelDiff.run(snapshot, svg, o);
      },
      opts as unknown,
    )) as RunResult;
    const png = async (name: string, dataUrl: string) => writeFile(join(out, `${kind}.${name}.png`), Buffer.from(dataUrl.split(',')[1]!, 'base64'));
    await Promise.all([png('ours', result.ours), png('svg', result.svg), png('diff', result.diff)]);
    if (args.keepBrowser) await page.waitForTimeout(600_000);
    const { ours: _o, svg: _s, diff: _d, ...rest } = result;
    return { kind, viewBox, ...rest, ours: '', svg: '', diff: '' };
  } finally {
    await browser.close();
    server.stop(true);
  }
}

// ---------------------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, { recursive: true });
const runs: Array<{ kind: 'board' | 'schematic'; snapshot: string; svg: string }> = [];

if (args.snapshot || args.svg) {
  if (!args.snapshot || !args.svg) throw new Error('--snapshot and --svg go together');
  const kind = (JSON.parse(await readFile(args.snapshot, 'utf8')) as { kind: 'board' | 'schematic' }).kind;
  runs.push({ kind, snapshot: args.snapshot, svg: args.svg });
} else {
  const project = await tempProject(args.board, args.schematic);
  const t0 = performance.now();
  const server = await startServer(args.cli, project.pro, args.out);
  console.log(`kicad-cli api-server ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  try {
    if (args.only !== 'schematic') {
      const board = await server.kicad.openBoard(project.pcb);
      runs.push({ kind: 'board', ...(await exportBoard(server.kicad, board, args, args.out)) });
    }
    if (args.only !== 'board') runs.push({ kind: 'schematic', ...(await exportSchematic(server.kicad, project.sch, args, args.out)) });
  } finally {
    await server.stop();
    await project.cleanup();
  }
}

if (!args.exportOnly) {
  const report: Array<Awaited<ReturnType<typeof compare>>> = [];
  for (const r of runs) {
    const res = await compare(r.kind, r.snapshot, r.svg, args, args.out);
    report.push(res);
    const f = (v: number) => `${v.toFixed(2)} %`;
    console.log(
      `${r.kind}: ${res.width}x${res.height} px @ ${args.pxPerMm} px/mm, ${res.renderItems} render items\n` +
        `  ink ours ${res.inkOurs} px, KiCad ${res.inkSvg} px, union ${res.union} px\n` +
        `  mismatch ${f(res.mismatchPct)} of all pixels, ${f(res.inkMismatchPct)} of the ink union\n` +
        `  tolerant (±${args.tolerance} px) ${f(res.tolerantMismatchPct)} of all pixels, ${f(res.tolerantInkMismatchPct)} of the ink union\n` +
        `  -> ${join(args.out, `${r.kind}.diff.png`)}`,
    );
  }
  await writeFile(join(args.out, 'report.json'), JSON.stringify({ args: { ...args }, results: report }, null, 2));
}
