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

## In the app

`Route → Autoroute…` (toolbar "Auto", `Shift+X`, palette) offers the three ways to run:
the JS router **in the tab** (`JsRouter` stepping between UI yields), the JS router **on the
bridge** and **Freerouting on the bridge** — both bridge jobs are `POST /sessions/:id/route`
from `packages/router/src/bridge-job.ts`, followed over SSE, cancellable (`DELETE` kills the
`java`). Options: nets (all unrouted / the selection's), copper layers, via cost, passes
(`-mp`) / effort, time limit, refill zones first. The job refills the zones, saves the board,
extracts the `RouteInput`, routes, and applies the result as **one** commit whose message is the
History entry — `Autoroute (js): 86 connections`, `Autoroute (freerouting): 128 connections`.
Freerouting runs in the router package's `kicad-dsn` mode (KiCad's own DSN exporter, the session
parsed by `specctra/ses.ts`) so the commit is ours rather than KiCad's fixed "Import Specctra
Session". After the apply the summary re-measures with `GetRatsnest`: "routed" is what KiCad
still sees as connected, the router's own count is shown next to it when it differs (a net
counts as routed for the router as soon as it got a wire), and the remaining airlines are listed
— a click frames one and highlights its net. "Refill zones + run DRC" runs both from the dialog.
A run that routes nothing is reported as **failed** with the router's reason and applies nothing;
Cancel does the same. `docs/screenshots/boards/<board>-autoroute-*.png`; the driver is the
`autoroute` step of `apps/web/scripts/prove-board.mjs`.

Measured 2026-09-07 through the real app (headless Chromium, bridge, KiCad 10.99.0-3711-g8cc9377988,
the `*.unrouted` fixtures, zones refilled before routing):

| Board | Router | Routed / total (GetRatsnest) | Tracks | Vias | Track length | Wall time | RefillZones + DRC after | Undo |
|---|---|---:|---:|---:|---:|---:|---|---|
| pic_programmer | JS, in the tab | 86 / 86 | 441 | 16 | 1662 mm | 5.6 s (router 5.1 s) | 4 clearance errors, 2 unconnected_items, 0 warnings | one step: 441 → 0 tracks |
| stickhub | JS, in the tab | **failed**, 0 / 128 | 0 | 0 | — | 61.6 s | board untouched | — |
| stickhub | Freerouting, bridge, `-mp 20` | 123 / 128 (the router counted 128: every net got a wire, 4 multi-pad nets not fully) | 554 | 42 | 618.0 mm | 5 min 16 s | 11 soldermask_bridge errors, 15 unconnected_items, 36 lib_footprint_mismatch warnings (all 36 pre-existing) | one step: 554 → 0 tracks |

Notes from the run:

- **pic_programmer, JS in the tab**: the tab stayed responsive — a trivial `page.evaluate` during
  the run never took more than 29 ms — the status bar went `unrouted 125 / 34 nets` (before the
  refill) → `unrouted 0`, History showed `Autoroute (js): 86 connections`, and one undo removed
  every track and via. DRC's two `unconnected_items` are pads the refilled pour reaches only
  through a thermal spoke the checker does not accept; the ratsnest itself is empty.
- **stickhub, JS in the tab**: the capacity-autorouter fails its reachability precheck
  (`Could not find start region for connection "GND_mst0"`, then `+3.3V`, `Net-(U1-VBUS_SENSE)`),
  the adapter's retries drop those nets and the last attempt ends with `HB ran out of iterations`
  after 60 s and 2 017 561 iterations — nothing routed. The dialog reports exactly that
  ("Routing failed: the router routed nothing: …", "The board was left as it was") and the board's
  track count stays 0; on this dense board a single solver `step()` can take ~1.6 s, so the tab is
  sluggish during those steps but never hangs, and Cancel lands at the next step.
- **stickhub, Freerouting `-mp 20`**: 128 connections, 5 min 16 s on the bridge (Freerouting
  itself 5 min 11 s), progress from Freerouting's pass lines; KiCad's ratsnest afterwards still
  has 5 airlines on 4 nets (`unrouted 5 / 4 nets` in the status bar), which the summary lists and
  frames on click. The commit message — and so the History entry — carries the router's own
  count (`Autoroute (freerouting): 128 connections`), because the commit is made before the
  ratsnest can be re-measured; the dialog shows both. The bench's 100-pass run
  (`docs/router-comparison.md`) reached 113 / 128 with 10 DRC errors; 20 passes here left fewer
  airlines but 11 solder-mask bridges (vias too close to pads on this fine-pitch board). `-mp 100`
  would take roughly 5–6 min more; a second run with more passes was not made in this pass.

