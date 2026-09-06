/**
 * Demo: renders a synthetic board so a human can eyeball pan / zoom / pick / hover /
 * layer toggles / theme switching. Build with `bun run demo:build`, serve with `bun run demo`.
 */
import { BoardCanvasHost, KICAD_CLASSIC_THEME, KICAD_DEFAULT_THEME, boardLayerDisplayName, copperLayerList, loadUserTheme, type PickResult } from '../src/index.js';
import { MemoryStore, syntheticBoard, footprint, track, via, zone, MM } from '../test/fixtures.js';
import { BOARD_LAYER_ENUM } from '../src/board/boardLayers.js';

const el = document.getElementById('canvas')!;
const status = document.getElementById('status')!;
const layersEl = document.getElementById('layers')!;
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- data
const items = syntheticBoard();
// optional stress test: ?n=100000 adds that many extra tracks/vias/footprints
const n = Number(params.get('n') ?? 0);
if (n > 0) {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const cols = Math.ceil(Math.sqrt(n / 4));
  for (let i = 0; i < n / 4; i++) {
    const x = 50 + (i % cols) * 2.5;
    const y = 5 + Math.floor(i / cols) * 2.5;
    items.push(footprint(`sfp-${i}`, `R${i}`, x, y, (i % 4) * 90, i % 3 === 0));
    items.push(track(`st-${i}`, x + 1, y, x + 1 + rnd() * 2, y + rnd() * 2, 0.15 + rnd() * 0.2, i % 2 ? BOARD_LAYER_ENUM.BL_F_Cu! : BOARD_LAYER_ENUM.BL_B_Cu!, i % 5 ? 'GND' : 'VCC'));
    items.push(via(`sv-${i}`, x + 1 + rnd() * 2, y + rnd() * 2, 0.6, 0.3));
  }
  items.push(zone('big-zone', [BOARD_LAYER_ENUM.BL_B_Cu!], [[48, 3], [50 + cols * 2.5 + 2, 3], [50 + cols * 2.5 + 2, 8 + (n / 4 / cols) * 2.5], [48, 8 + (n / 4 / cols) * 2.5]], [[60, 10], [70, 10], [70, 20], [60, 20]]));
}
const store = new MemoryStore(items);

// ---------------------------------------------------------------- host
const host = new BoardCanvasHost(KICAD_DEFAULT_THEME, {
  copperLayers: copperLayerList(2),
  leftDrag: 'rubberband',
  overlays: { gridUnit: 'mm' },
});
host.mount(el, store, KICAD_DEFAULT_THEME);

let selection: string[] = [];
const describe = (h: PickResult) => `${h.ref}${h.net ? ` (${h.net})` : ''} on ${boardLayerDisplayName(h.layer)} d=${h.distance.toFixed(1)}px`;

host.onPick((hits, ev) => {
  if (!hits.length) {
    selection = [];
  } else if (ev.shiftKey) {
    selection = [...selection, hits[0]!.owner];
  } else {
    // cycle through overlapping hits on repeated clicks
    const cur = selection[0];
    const idx = hits.findIndex((h) => h.owner === cur);
    selection = [hits[(idx + 1) % hits.length]!.owner];
  }
  host.setSelection(selection);
  status.textContent = hits.length ? `pick: ${hits.slice(0, 4).map(describe).join(' | ')}` : 'pick: nothing';
});
host.onHover((hit) => {
  if (hit) status.textContent = `hover: ${describe(hit)}`;
});
host.onBoxSelect(({ hits, touching }) => {
  selection = [...new Set(hits.map((h) => h.owner))];
  host.setSelection(selection);
  status.textContent = `box (${touching ? 'touching' : 'inside'}): ${selection.length} items`;
});
host.onCameraChange((cam) => {
  const w = host.screenToWorld(0, 0);
  document.getElementById('cam')!.textContent = `zoom ${(cam.zoom * MM).toFixed(2)} px/mm · centre ${(cam.x / MM).toFixed(2)}, ${(cam.y / MM).toFixed(2)} mm · grid ${(host.overlays.gridPitch / MM).toFixed(3)} mm · tl ${(w.x / MM).toFixed(1)},${(w.y / MM).toFixed(1)}`;
});

// ---------------------------------------------------------------- controls
const layerList = ['BL_F_Cu', 'BL_B_Cu', 'BL_F_SilkS', 'BL_B_SilkS', 'BL_F_Mask', 'BL_B_Mask', 'BL_F_Paste', 'BL_F_CrtYd', 'BL_B_CrtYd', 'BL_F_Fab', 'BL_Edge_Cuts', 'BL_Dwgs_User', 'BL_Cmts_User', 'board.via_hole', 'board.anchor'];
for (const l of layerList) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.onchange = () => host.setLayerVisible(l, cb.checked);
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'active';
  radio.checked = l === 'BL_F_Cu';
  radio.onchange = () => host.setActiveLayer(l);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '1';
  range.step = '0.05';
  range.value = '1';
  range.oninput = () => host.setLayerOpacity(l, Number(range.value));
  label.append(radio, cb, ` ${boardLayerDisplayName(l)} `, range);
  layersEl.appendChild(label);
}
(document.getElementById('theme') as HTMLSelectElement).onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  host.setTheme(v === 'classic' ? KICAD_CLASSIC_THEME : KICAD_DEFAULT_THEME);
};
(document.getElementById('theme-file') as HTMLInputElement).onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) host.setTheme(loadUserTheme(await f.text()));
};
document.getElementById('fit')!.onclick = () => host.zoomToFit();
document.getElementById('flip')!.onclick = () => host.flipView(!host.isFlipped);
(document.getElementById('net') as HTMLSelectElement).onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  host.setHighlightNets(v ? [v] : []);
};
(document.getElementById('grid') as HTMLSelectElement).onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value as 'mm' | 'mil' | 'off';
  host.overlays.options.showGrid = v !== 'off';
  if (v !== 'off') host.overlays.options.gridUnit = v;
  host.requestRender();
};
document.getElementById('move')!.onclick = () => {
  // optimistic move through the store: the renderer rebuilds just that footprint
  const r1 = store.get('fp-r1')!;
  const p = (r1.proto as { position: { xNm: bigint } }).position;
  p.xNm += BigInt(MM);
  store.apply({ updated: [r1] });
};
document.getElementById('remove')!.onclick = () => store.apply({ removed: ['t3'] });

host.ready.then(() => {
  status.textContent = `ready: ${store.byType('KOT_PCB_FOOTPRINT').length} footprints, ${host.scene.itemCount} render items, ${host.scene.cachedContexts} shared pad contexts. Middle-drag / touch to pan, wheel to zoom, left-drag box-select, click to pick.`;
  // simple fps counter
  let frames = 0;
  let last = performance.now();
  const tick = () => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) {
      document.getElementById('fps')!.textContent = `${frames} fps`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (params.get('spin')) {
    // continuous pan to measure frame rate
    setInterval(() => host.camera.panByPixels(2, 1), 16);
  }
});

Object.assign(window as unknown as Record<string, unknown>, { host, store });
