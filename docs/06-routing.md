# 06 — Real boards and routing (milestone M7)

Everything so far was proven on the API kitchen-sink fixtures. This phase uses real designs
and adds autorouting.

## The five practice boards

Chosen from KiCad's own `demos/` for a spread of size, all with schematic and board:

| Board | Footprints | Nets (approx.) | Why |
|---|---:|---:|---|
| `ecc83` | 15 | 107 | tiny through-hole tube preamp, single-layer-ish |
| `sonde xilinx` | 25 | 363 | small 2-layer SMD + THT mix |
| `interf_u` | 25 | 1363 | dense connector board, many nets per footprint |
| `pic_programmer` | 63 | ~400 | classic medium 2-layer, hierarchical schematic |
| `stickhub` | 94 | 1706 | medium 4-layer USB hub, fine pitch |

Each board is copied to `e2e/fixtures/boards/<name>/`, its tracks and vias are stripped to make a
"placed but unrouted" variant, and both the original and the stripped variant are checked in
(CC-BY-SA per KiCad demos, see the NOTICE).

## Practice pass

For each board, through the web UI against a headless server: open, view (board + all sheets),
edit properties, move a footprint, route a handful of nets by hand with the route tool, run DRC,
undo, save, export gerbers, and reopen in desktop KiCad. Every failure becomes a bug fix in the
app, renderer, client or fork, with a screenshot in `docs/screenshots/boards/`. The checklist and
the per-board results live in `docs/board-practice.md`.

## Router integration

Two routers, one interface (`packages/router`):

```ts
interface Autorouter {
  name: string;
  route(input: RouteInput, opts: RouteOptions, progress?: (p) => void): Promise<RouteResult>;
}
// RouteInput: board outline, layers, nets, pads/vias/existing tracks, keepouts, design rules
// RouteResult: tracks + vias to create, unrouted connections, timing, log
```

- **Freerouting** (Java, Specctra DSN in / SES out). KiCad has the Specctra exporter and session
  importer in `pcbnew/specctra_import_export/` but no API command for either, so the fork gains
  `RunBoardJobExportSpecctra` and `ImportSpecctraSession`. The bridge runs the `freerouting` jar
  as a job and streams its log.
- **A JavaScript router** that runs in Bun and the browser. Candidates are surveyed in
  `packages/router/README.md`; the pick must be open-source, take a generic input (not a
  vendor schema), and expose progress. Its output is applied with `CreateItems` in one commit.

## Comparison

Both routers run on all five stripped boards with the same rules. Metrics per run: completion
(routed / total connections), via count, total track length, DRC errors after `RefillZones` +
`RunBoardJobDrc`, wall time, and a rendered screenshot. Results table in `docs/router-comparison.md`
with the raw JSON under `packages/router/bench/results/`.

## Outcome (2026-09-07)

Practice: every step passes on all five boards; the pass found that real boards drew no pads,
silk or courtyards at all (footprint children arrive as `Any`), plus five smaller bugs, all fixed
with tests. Details and 72 screenshots: [board-practice.md](board-practice.md).

Routers: `@tscircuit/capacity-autorouter` was the only maintained, MIT, generic-input JavaScript
option. It is instant and complete on the small and medium boards but fails outright on the dense
connector board and the 4-layer hub, where Freerouting reaches 95% and 88%. Freerouting needs Java
25 and has no via-cost, seed or time-limit knobs. Numbers: [router-comparison.md](router-comparison.md).
Recommendation: offer both in the app, the JS router in-page for quick work and Freerouting as a
bridge job for dense boards.
