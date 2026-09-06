/**
 * Browser side of the pixel-diff harness (bundled by scripts/pixel-diff.ts and loaded in a
 * headless Chromium through Playwright). Renders an ItemStore snapshot with the real
 * BoardCanvasHost / SchematicCanvasHost at a fixed px-per-mm scale, rasterises KiCad's SVG
 * export at the same scale, and compares the two as ink masks.
 *
 * Everything is exposed on `window.pixelDiff.run(snapshot, svgText, options)`.
 */
import { BoardCanvasHost, KICAD_DEFAULT_THEME, SchematicCanvasHost, type BaseCanvasHost, type StoredItemLike, type StoreDiffLike, type Theme } from '../../src/index.js';

const MM = 1_000_000;

export interface Snapshot {
  kind: 'board' | 'schematic';
  copperLayers: string[];
  items: Array<{ id: string; type: string; layer?: string; net?: string; parent?: string; proto: unknown }>;
  /** `<pad kiid>/<BL_layer>` -> PolygonWithHoles (GetPadShapeAsPolygon) */
  padPolygons: Record<string, unknown>;
  /** adapter text key -> GraphicShape[] (GetTextAsShapes) */
  textShapes: Record<string, unknown[]>;
}

export interface RunOptions {
  /** rasterisation scale */
  pxPerMm: number;
  /** SVG viewBox in mm: the world window to render */
  viewBox: { x: number; y: number; w: number; h: number };
  /** render-model layer ids to show (board); everything else is hidden. Empty = all. */
  layers: string[];
  /** extra layers to hide (pseudo layers such as `board.via_hole`) */
  hide: string[];
  /** ink threshold: max channel distance from white (0..255) */
  inkThreshold: number;
  /** tolerance in px for the "tolerant" mismatch (masks are dilated by this much) */
  tolerancePx: number;
  /** paint drill holes white, as KiCad's plotter does with full drill marks on a white page */
  whiteHoles: boolean;
}

export interface RunResult {
  width: number;
  height: number;
  total: number;
  inkOurs: number;
  inkSvg: number;
  xor: number;
  union: number;
  /** xor / total, percent */
  mismatchPct: number;
  /** 1 - intersection / union, percent (0 = identical ink) */
  inkMismatchPct: number;
  /** pixels of either image farther than `tolerancePx` from any ink of the other, / total, percent */
  tolerantMismatchPct: number;
  /** same, relative to the ink union */
  tolerantInkMismatchPct: number;
  renderItems: number;
  ours: string;
  svg: string;
  diff: string;
}

/** Revive the snapshot JSON: `{ $bytes }` -> Uint8Array (bigints travelled as strings, which the adapters accept). */
function revive(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '$bytes' in (value as Record<string, unknown>)) {
    const b64 = (value as { $bytes: string }).$bytes;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return value;
}

class SnapshotStore {
  private map = new Map<string, StoredItemLike>();
  constructor(
    readonly kind: string,
    items: StoredItemLike[],
  ) {
    for (const it of items) this.map.set(it.id, it);
  }
  all(): Iterable<StoredItemLike> {
    return this.map.values();
  }
  get(id: string): StoredItemLike | undefined {
    return this.map.get(id);
  }
  subscribe(_cb: (diff: StoreDiffLike) => void): () => void {
    return () => {};
  }
}

async function renderOurs(snapshot: Snapshot, o: RunOptions, width: number, height: number): Promise<{ canvas: HTMLCanvasElement; renderItems: number }> {
  const el = document.createElement('div');
  el.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;`;
  document.body.appendChild(el);
  const store = new SnapshotStore(snapshot.kind, snapshot.items);
  const common = { overlays: { showGrid: false, showAxes: false }, background: 0xffffff, antialias: true, preference: 'webgl' as const };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const theme: Theme = o.whiteHoles
    ? { ...KICAD_DEFAULT_THEME, colors: { ...KICAD_DEFAULT_THEME.colors, 'board.via_hole': white, 'board.pad_plated_hole': white, 'board.plated_hole': white } }
    : KICAD_DEFAULT_THEME;
  let host: BaseCanvasHost;
  if (snapshot.kind === 'board') {
    host = new BoardCanvasHost(theme, {
      ...common,
      copperLayers: snapshot.copperLayers,
      adapter: {
        footprintChildrenAbsolute: true,
        padPolygons: (padId, layer) => snapshot.padPolygons[`${padId}/${layer}`] as never,
        textShapes: (id) => snapshot.textShapes[id] as never,
      },
    });
  } else {
    host = new SchematicCanvasHost(theme, {
      ...common,
      adapter: { textShapes: (id) => snapshot.textShapes[id] as never, symbolPinsAbsolute: true },
    });
  }
  host.mount(el, store, theme);
  await host.ready;
  if (o.layers.length) {
    const show = new Set(o.layers);
    for (const l of host.scene.layerIds()) host.setLayerVisible(l, show.has(l));
  }
  for (const l of o.hide) host.setLayerVisible(l, false);
  host.setCamera({ x: (o.viewBox.x + o.viewBox.w / 2) * MM, y: (o.viewBox.y + o.viewBox.h / 2) * MM, zoom: o.pxPerMm / MM });
  // Image primitives (reference images, schematic bitmaps) get their texture from an async
  // `Assets.load` of a data URL, so let those settle before the one and only frame.
  if (snapshot.items.some((it) => it.type === 'KOT_PCB_REFERENCE_IMAGE' || it.type === 'KOT_SCH_BITMAP')) {
    await new Promise((r) => setTimeout(r, 500));
  }
  host.renderNow();
  // Copy the WebGL drawing buffer in the same task (it is cleared once the frame composites).
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(host.canvas!, 0, 0, width, height);
  const renderItems = host.scene.itemCount;
  host.unmount();
  el.remove();
  return { canvas: out, renderItems };
}

async function rasteriseSvg(svgText: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('SVG failed to load'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(url);
  return canvas;
}

function inkMask(canvas: HTMLCanvasElement, threshold: number): Uint8Array {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const d = Math.max(255 - data[p]!, 255 - data[p + 1]!, 255 - data[p + 2]!);
    mask[i] = d > threshold ? 1 : 0;
  }
  return mask;
}

function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width) out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

export async function run(snapshotJson: string, svgText: string, o: RunOptions): Promise<RunResult> {
  const snapshot = JSON.parse(snapshotJson, revive) as Snapshot;
  const width = Math.max(1, Math.round(o.viewBox.w * o.pxPerMm));
  const height = Math.max(1, Math.round(o.viewBox.h * o.pxPerMm));
  const ours = await renderOurs(snapshot, o, width, height);
  const svg = await rasteriseSvg(svgText, width, height);
  const a = inkMask(ours.canvas, o.inkThreshold);
  const b = inkMask(svg, o.inkThreshold);
  const ad = dilate(a, width, height, o.tolerancePx);
  const bd = dilate(b, width, height, o.tolerancePx);
  let inkOurs = 0;
  let inkSvg = 0;
  let xor = 0;
  let union = 0;
  let tol = 0;
  const diff = document.createElement('canvas');
  diff.width = width;
  diff.height = height;
  const dctx = diff.getContext('2d')!;
  const img = dctx.createImageData(width, height);
  const px = img.data;
  for (let i = 0, p = 0; i < a.length; i++, p += 4) {
    const x = a[i]!;
    const y = b[i]!;
    inkOurs += x;
    inkSvg += y;
    if (x | y) union++;
    let r = 255;
    let g = 255;
    let bl = 255;
    if (x && y) {
      r = g = bl = 160;
    } else if (x !== y) {
      xor++;
      const far = x ? !bd[i] : !ad[i];
      if (far) tol++;
      if (y) {
        // only in KiCad's SVG: red (strong when outside the tolerance band)
        r = 255;
        g = far ? 0 : 150;
        bl = far ? 0 : 150;
      } else {
        // only in our render: cyan
        r = far ? 0 : 150;
        g = far ? 160 : 220;
        bl = 255;
      }
    }
    px[p] = r;
    px[p + 1] = g;
    px[p + 2] = bl;
    px[p + 3] = 255;
  }
  dctx.putImageData(img, 0, 0);
  const total = a.length;
  const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);
  return {
    width,
    height,
    total,
    inkOurs,
    inkSvg,
    xor,
    union,
    mismatchPct: pct(xor, total),
    inkMismatchPct: pct(xor, union),
    tolerantMismatchPct: pct(tol, total),
    tolerantInkMismatchPct: pct(tol, union),
    renderItems: ours.renderItems,
    ours: ours.canvas.toDataURL('image/png'),
    svg: svg.toDataURL('image/png'),
    diff: diff.toDataURL('image/png'),
  };
}

(window as unknown as { pixelDiff: { run: typeof run } }).pixelDiff = { run };
