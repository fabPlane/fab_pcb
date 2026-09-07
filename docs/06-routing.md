# 06 — Real boards and routing (milestone M7)

Everything so far was proven on the API kitchen-sink fixtures. This phase uses real designs
and adds autorouting.

## The five practice boards

Chosen from KiCad's own `demos/` for a spread of size, all with schematic and board:

| Board            | Footprints | Nets (approx.) | Why                                             |
| ---------------- | ---------: | -------------: | ----------------------------------------------- |
| `ecc83`          |         15 |            107 | tiny through-hole tube preamp, single-layer-ish |
| `sonde xilinx`   |         25 |            363 | small 2-layer SMD + THT mix                     |
| `interf_u`       |         25 |           1363 | dense connector board, many nets per footprint  |
| `pic_programmer` |         63 |           ~400 | classic medium 2-layer, hierarchical schematic  |
| `stickhub`       |         94 |           1706 | medium 4-layer USB hub, fine pitch              |

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

One interface, two adapters, one job, one dialog — `packages/router` holds the first three, the
app the last:

```
Board ──extractRouteInput()──▶ RouteInput ──▶ Autorouter.route(input, opts, progress) ──▶ RouteResult ──applyRouteResult()──▶ one commit
                                                 │ JsRouter        (@tscircuit/capacity-autorouter, in Bun or the browser)
                                                 │ FreeroutingRouter (java -jar freerouting.jar, DSN in / SES out)
        createRouteJobs()  =  RefillZones → SaveDocument → extract → route → apply → GetRatsnest re-measure   (the bridge job)
        AutorouteDialog    =  js-tab (the same steps in the page, minus the save) | js-server | freerouting (both via the job)
```

**The interface** (`src/types.ts`). `extractRouteInput(board, { nets?, warn? })` reads outline,
copper layers, pads (absolute, with shape and drill), existing tracks/vias, rule areas, copper zones
and their fills, copper text/graphics, net-class rules and the ratsnest into a `RouteInput` — plain
nanometre numbers, no protobuf, so a router is unit-testable on hand-written boards. An
`Autorouter` is `{ name, route(input, opts, progress?), available?() }` and returns a `RouteResult`
(`tracks`, `vias`, `unrouted` as the router sees it, `totalConnections`, `timedOut`, `elapsedMs`,
`log`). `applyRouteResult(board, result, { message })` creates every track and via in **one**
`CreateItems` commit, so one Undo takes the pass back. `RouteOptions` are `layers`, `viaCost`,
`maxTimeMs`, `nets`, `seed`, `effort`, `extra` and `signal` — an `AbortSignal`; when it fires the
adapter rejects with `RouteCancelled` and nothing is applied. Each adapter logs which options it
cannot honour instead of silently ignoring them.

**`JsRouter`** (`src/js-router.ts`) drives `@tscircuit/capacity-autorouter` 0.0.885 (MIT; the
survey of the alternatives is in `packages/router/README.md`) through its `SimpleRouteJson`
input and its `step()` loop, yielding to the event loop every 50 ms (30 ms in the tab) so a page
stays live and Cancel lands at the next step. Its failure modes, stated plainly:

- The solver only knows axis-aligned rectangles: pads are their bounding boxes (a circle becomes
  a square, a 45° pad grows), diagonal tracks and rule areas block a box. Conservative, but on
  fine-pitch parts the inflated boxes of neighbouring pads touch and seal pads in.
- Copper zones are not obstacles for it. Its tracks cut through a pour, and after the refill a
  pad that the pour used to reach can be unconnected again — that is why the bench's ratsnest
  count after the refill is lower than the router's own (pic_programmer: the router says 86 / 86,
  KiCad's ratsnest 84). Freerouting, which sees a pour as a plane and routes other nets through
  it, has the same effect at a larger scale (stickhub: 123 right after the apply, 113 after the
  refill).
- The pipeline is all-or-nothing. When its reachability precheck finds a net whose start point
  is sealed in (`Could not find start region for connection "GND_mst0"`, `Static reachability
precheck failed`), the whole run fails. `JsRouter` retries with less obstacle inflation, then
  without the nets the error names, up to eight rounds; when the last attempt still fails
  (`HB ran out of iterations`) the result is **empty** — not partial. stickhub and interf_u end
  this way.
- A time limit does not give a partial result either: the solver has no output until it is
  solved, so `maxTimeMs` returns nothing routed with `timedOut: true` (interf_u: 13 min, then
  nothing). The dialog's help text still promises "returns what it has" for the JS router; the
  code does not.
- Vias always span every routed layer; `viaCost` and `seed` have no equivalent and are logged as
  ignored; `effort` is the solver's own knob (1 = default).

**`FreeroutingRouter`** (`src/freerouting.ts`) runs
`java -jar freerouting-2.4.1.jar -de board.dsn -do board.ses -mp <passes> --gui.enabled=false`
and parses its `Auto-routing pass #n … (x unrouted and y violations)` lines into progress. Three
ways in and out of KiCad, chosen by `mode`:

- `kicad-dsn` — **what the app and the bridge job use**: the DSN comes from KiCad's own exporter
  (`RunBoardJobExportSpecctra`, a fork command, exact pad geometry and zones as planes), the
  session is parsed by `specctra/ses.ts` and applied by `applyRouteResult()` under our commit
  message, so the History entry is "Autoroute (freerouting): n connections" and the tracks are
  known client-side.
- `kicad` — KiCad's exporter **and** its importer (`ImportSpecctraSession`, the second fork
  command). KiCad creates the items itself under its fixed "Import Specctra Session" entry. This
  is what the first bench measured.
- `builtin` — the package's own DSN writer (`specctra/dsn.ts`) and SES reader; works on any
  server, pads approximated.

Requirements and limits: the jar is GPL and **not** vendored in git —
`bun packages/router/bench/fetch-freerouting.ts --jdk` downloads it (64 MB) and a Temurin
**Java 25** (Freerouting ≥ 2.2 refuses older JDKs) into `packages/router/vendor/`, both
git-ignored; `FREEROUTING_JAR` and `FP_PCB_JAVA` (or `FREEROUTING_JAVA`) override the paths
and `resolveFreerouting(env)` reports, with the fix, why it cannot run (the bridge shows that in
`/health` and the dialog greys the option out). The CLI has **no via-cost, seed or time-limit
knob**: passes (`-mp`) are the only bound, and there is no "stop and save" — `maxTimeMs` or
Cancel kills the process (SIGTERM, SIGKILL after 5 s) and nothing is routed. It routes every
unrouted net in the DSN, so `nets` only filters which connections are counted, and in the
`kicad*` modes it gets every enabled copper layer whatever `layers` says; both are logged. Its
own "unrouted" count is per net, so a multi-pad net with one wire counts as done (stickhub: it
reports 128 / 128, KiCad's ratsnest 123).

**The bridge job** (`src/bridge-job.ts`, mounted by `packages/bridge/src/server.ts`):
`POST /sessions/:id/route {router: "js" | "freerouting", options?, freerouting?, refillZones?}`
starts a job on the session's own KiCad transport; `GET …/route/:job` polls it or, with
`Accept: text/event-stream`, streams `state` / `progress` / `done` / `error` events; `DELETE`
cancels through `RouteOptions.signal`. The body is `RefillZones` (unless `refillZones: false`) →
`SaveDocument` (KiCad's exporter reads the file on disk) → `extractRouteInput` → `route` →
`applyRouteResult` as one commit, then **`GetRatsnest` re-measures**: `summary.routed` is what
KiCad still sees as connected after the apply, `summary.routerRouted` the router's own count (a
net counts as routed for the router as soon as it got a wire, which overstates on multi-pad
nets), and `summary.unrouted` lists the airlines left. A run that routes nothing ends **failed**
with the router's reason (`emptyResultReason`: the precheck message, the timeout, a killed jar) and
applies nothing; Cancel before the apply leaves the board untouched. The commit message — the
History entry — is made before the re-measure, so it carries the router's count.

## Comparison

`packages/router/bench/run.ts` runs the bridge job per board and router on a fresh
`kicad-cli api-server` with a temp copy of the `*.unrouted` fixture, exactly as the app does, and
measures around it: `RefillZones` + `GetUnroutedCount` + `RunBoardJobDrc` before and after, via
count, `GetNetLengths`, wall time, an SVG render. Router names are `js`, `freerouting` (the
app's `kicad-dsn` mode, 20 passes by default like the dialog), `freerouting-kicad` (KiCad's
importer, the first bench's path; `--passes 100` reproduces those rows) and
`freerouting-builtin`. The table in [router-comparison.md](router-comparison.md) shows the
ratsnest-measured count next to the router's own, a "Measured with" line (KiCad version and
commit, Freerouting and Java, capacity-autorouter, Bun, machine, dates) and marks the rows kept
from the first harness. Raw JSON per run in `packages/router/bench/results/`.

## Outcome (2026-09-07)

Practice: every step passes on all five boards; the pass found that real boards drew no pads,
silk or courtyards at all (footprint children arrive as `Any`), plus five smaller bugs, all fixed
with tests. Details and 72 screenshots: [board-practice.md](board-practice.md).

Routers, measured through the job (KiCad `10.99.0-3711-g8cc9377988`, Freerouting 2.4.1 on
Temurin 25.0.4.1, capacity-autorouter 0.0.885, Apple M2 Max):

| Board          | Router                  | Routed / total (ratsnest) | Router said | Vias | Track length |   Wall time | DRC errors after (not unconnected)                                          | Notes                                               |
| -------------- | ----------------------- | ------------------------: | ----------: | ---: | -----------: | ----------: | --------------------------------------------------------------------------- | --------------------------------------------------- |
| ecc83          | JS (effort 1)           |                   14 / 14 |          14 |    0 |     169.6 mm |       0.4 s | 2 silk_edge_clearance                                                       |                                                     |
| ecc83          | Freerouting (20 passes) |                   14 / 14 |          14 |    1 |     261.7 mm |       7.3 s | 2 silk_edge_clearance                                                       |                                                     |
| sonde_xilinx   | JS (effort 1)           |                   48 / 48 |          48 |   12 |     673.5 mm |      36.0 s | 9 tracks_crossing, 1 clearance, 2 shorting_items, 1 drilled_holes_colocated |                                                     |
| sonde_xilinx   | Freerouting (20 passes) |                   47 / 48 |          48 |    0 |     593.2 mm |  1 min 48 s | 3 shorting_items, 2 clearance                                               |                                                     |
| pic_programmer | JS (effort 1)           |                   84 / 86 |          86 |   16 |    1656.8 mm |       5.4 s | 5 clearance                                                                 |                                                     |
| pic_programmer | Freerouting (20 passes) |                   84 / 86 |          86 |    3 |    1999.1 mm |      40.4 s | 6 clearance, 2 shorting_items                                               |                                                     |
| interf_u       | JS (effort 1)           |                   0 / 164 |           — |    0 |       0.0 mm | 13 min 20 s | clean                                                                       | first harness, 2026-09-06, kept; timed out          |
| interf_u       | Freerouting (20 passes) |                 156 / 164 |         164 |   38 |    4377.4 mm |  8 min 52 s | 3 starved_thermal                                                           |                                                     |
| stickhub       | JS (effort 1)           |       **failed**, 0 / 128 |           — |    — |            — |  1 min 08 s | board untouched                                                             | solver failed (attempt 3): HB ran out of iterations |
| stickhub       | Freerouting (20 passes) |                 113 / 128 |         128 |   42 |     617.1 mm |  5 min 12 s | 11 soldermask_bridge                                                        |                                                     |

- `@tscircuit/capacity-autorouter` was the only maintained, MIT, generic-input JavaScript
  router. It is fast and complete on the small and medium boards and **fails outright** on the
  dense connector board and the 4-layer hub — an empty result, not a partial one.
- Freerouting routes the boards the JS router cannot — 95 % of interf_u in under 9 minutes,
  88 % of stickhub in about 5½ — and the dialog's 20 passes are not a compromise: with `-mp 100`
  the first bench got the same numbers, because Freerouting stops on its own once the score stops
  improving (pass 20 on interf_u, pass 23 on stickhub). It needs Java 25 and a 64 MB download,
  and has no via-cost or time-limit knob.
- Neither result is DRC-clean on the medium boards: the JS router leaves clearance errors and,
  on sonde_xilinx, crossing tracks (its own DRC repair does not know KiCad's rules); Freerouting
  leaves clearance/short errors on pic_programmer and solder-mask bridges on stickhub (vias
  too close to fine-pitch pads). Both need a DRC pass and a hand fix afterwards.

**When to use which.** Small or medium 2-layer boards with through-hole and coarse SMD parts
(up to about pic_programmer's 63 footprints / 86 connections): the JS router **in the tab** —
seconds, no install, one Undo. Fine-pitch, dense connectors or four layers: **Freerouting on
the bridge**, 20 passes for a first result, more when the airline count stops falling; expect
minutes and a DRC pass. The JS router **on the bridge** is for the medium boards when the tab
should stay free — it does not route anything the in-tab run cannot. If Freerouting is greyed
out, the bridge's `/health` says what is missing.

## In the app

`Route → Autoroute…` (toolbar "Auto", `Shift+X`, palette) offers the three ways to run: the JS
router **in the tab** (`KicadAutorouteService.runInTab`: refill → extract → `JsRouter` with a
30 ms yield → apply → `GetRatsnest`, the same steps as the job minus the save), the JS router
**on the bridge** and **Freerouting on the bridge** (both `POST /sessions/:id/route`, followed
over SSE, cancelled with `DELETE`; the tab waits 10 s for the bridge's `error` event before
dropping the stream). Options: nets (all unrouted / the selection's), copper layers, via cost,
passes (`-mp`) / effort, time limit, refill zones first; defaults are effort 1 / 20 passes, a
300 s limit in the tab, 600 s on the bridge for the JS router, none for Freerouting (a limit would only kill it). The
summary shows routed / total as `GetRatsnest` sees it, "(router said n)" when the router's count
differs, tracks, vias, track length, wall and router time, the History entry, and the remaining
airlines — a click frames one and highlights its net. "Refill zones + run DRC" runs both from
the dialog. A run that routes nothing is reported as **failed** with the router's reason and
applies nothing; Cancel does the same. The pass is also recorded in the app's own history (from
the created items) so the client-side undo of a server without an undo stack can take it back.
Screenshots: `docs/screenshots/boards/<board>-autoroute-*.png`; the driver is the `autoroute`
step of `apps/web/scripts/prove-board.mjs`.

Measured 2026-09-07 through the real app (headless Chromium, bridge, KiCad
10.99.0-3711-g8cc9377988, the `*.unrouted` fixtures, zones refilled before routing):

| Board          | Router                        |       Routed / total (GetRatsnest) | Tracks | Vias | Track length |            Wall time | RefillZones + DRC after                                                                                     | Undo                     |
| -------------- | ----------------------------- | ---------------------------------: | -----: | ---: | -----------: | -------------------: | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| pic_programmer | JS, in the tab                |                            86 / 86 |    441 |   16 |      1662 mm | 5.6 s (router 5.1 s) | 4 clearance errors, 2 unconnected_items, 0 warnings                                                         | one step: 441 → 0 tracks |
| stickhub       | JS, in the tab                |                **failed**, 0 / 128 |      0 |    0 |            — |               61.6 s | board untouched                                                                                             | —                        |
| stickhub       | Freerouting, bridge, `-mp 20` | 123 / 128 (the router counted 128) |    554 |   42 |     618.0 mm |           5 min 16 s | 11 soldermask_bridge errors, 15 unconnected_items, 36 lib_footprint_mismatch warnings (all 36 pre-existing) | one step: 554 → 0 tracks |

The bench rows for the same board and router are the same runs seen from outside the browser
(stickhub × Freerouting: router 128, `GetRatsnest` after the apply 123, 113 after the refill, 42 vias, 617.1 mm, 5 min 12 s, 11 solder-mask bridges — 123 is the dialog's number, 113 what DRC reports after "Refill zones + run DRC",
15 `unconnected_items` in both), which is the point of the bench running the job: the two
tables measure the same code. Notes from the app run:

- **pic_programmer, JS in the tab**: the tab stayed responsive — a trivial `page.evaluate`
  during the run never took more than 29 ms — the status bar went `unrouted 125 / 34 nets`
  (before the refill) → `unrouted 0`, History showed `Autoroute (js): 86 connections`, and one
  undo removed every track and via. The dialog's 86 / 86 is the ratsnest right after the apply;
  DRC's two `unconnected_items` are the pads the refilled pour no longer reaches (the bench,
  which refills before counting, reports 84 / 86 for the same run).
- **stickhub, JS in the tab**: the precheck fails (`Could not find start region for connection
"GND_mst0"`, then `+3.3V`, `Net-(U1-VBUS_SENSE)`), the retries drop those nets and the last
  attempt ends with `HB ran out of iterations` after 60 s and 2 017 561 iterations — nothing
  routed. The dialog reports exactly that ("Routing failed: the router routed nothing: …", "The
  board was left as it was") and the track count stays 0; a single solver `step()` can take
  ~1.6 s on this board, so the tab is sluggish during those steps but never hangs, and Cancel
  lands at the next step.
- **stickhub, Freerouting `-mp 20`**: 5 min 16 s on the bridge (Freerouting itself 5 min 11 s),
  progress from its pass lines; KiCad's ratsnest afterwards still has 5 airlines on 4 nets, which
  the summary lists and frames on click. The History entry carries the router's own count
  (`Autoroute (freerouting): 128 connections`) because the commit is made before the ratsnest is
  re-measured; the dialog shows both. Ten of the pads the pour reached before the run are cut
  off by the new tracks once the zones are refilled, which is why DRC then counts 15
  `unconnected_items` where the dialog listed 5 airlines; the 11 solder-mask bridges are vias too
  close to pads on this fine-pitch board.

Note on the in-tab JavaScript router: it yields between solver steps, but a single step on a
dense board can take up to about a second (measured 0.7 s on sonde_xilinx, 1.2 s on stickhub), so
the tab stutters rather than freezes. For boards past a few hundred connections, run it on the
server from the same dialog; a Web Worker for the in-tab path is the proper fix.
