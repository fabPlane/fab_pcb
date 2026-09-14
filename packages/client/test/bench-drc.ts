/**
 * The three backends, same board, same numbers: how long a project takes to open, how long DRC on
 * the kitchen sink takes, and what one round trip costs. Not a test -- run it by hand:
 *
 *   KICAD_TRANSPORT=wasm KICAD_WASM_DIR=<kicad>/build/wasm/host bun test/bench-drc.ts
 *   KICAD_TRANSPORT=stdio bun test/bench-drc.ts
 *   KICAD_CLI=<kicad>/build/dev/.../kicad-cli bun test/bench-drc.ts
 *
 * The `wasm` ping figure carries the harness's MEMFS mirror (a directory walk on each side of every
 * request), not just `kiapi_dispatch`; the module's own dispatch is ~0.006 ms.
 */
import { KICAD_TRANSPORT, startKiCad, tempProject } from "./kicad-server";

const tmp = await tempProject("fp-pcb-bench-");
const rt = await startKiCad(null, "bench");
const t0 = performance.now();
const project = await rt.kicad.openProject(tmp.pro);
const board = await project.openBoard(tmp.pcb);
const openMs = performance.now() - t0;

const drc: number[] = [];
let markers = 0;
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  markers = (await board.drc.run({ refillZones: false })).markers.length;
  drc.push(performance.now() - t);
}

const t1 = performance.now();
const PINGS = 200;
for (let i = 0; i < PINGS; i++) await rt.kicad.client.ping();
const pingMs = (performance.now() - t1) / PINGS;

console.log(
  `${KICAD_TRANSPORT}: open ${openMs.toFixed(0)} ms; DRC ${drc.map((t) => t.toFixed(0)).join("/")} ms (${markers} markers); ping ${pingMs.toFixed(3)} ms`,
);
await rt.stop();
await tmp.cleanup();
