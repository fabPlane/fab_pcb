# @kicad-web/router

Autorouting for kicad-web (docs/06-routing.md, milestone M7). One interface, two routers:

```ts
import { extractRouteInput, applyRouteResult, JsRouter, FreeroutingRouter } from "@kicad-web/router";

const input = await extractRouteInput(board); // Board from @kicad-web/client
const result = await new JsRouter().route(input, { maxTimeMs: 60_000 }, (p) => console.log(p.phase, p.percent));
await applyRouteResult(board, result); // one commit: BeginCommit + CreateItems + EndCommit
```

```
src/
  types.ts        RouteInput / RouteOptions / RouteResult / Autorouter — the contract
  extract.ts      extractRouteInput(board): outline, layers, pads, copper, keepouts, zones, rules, ratsnest
  apply.ts        applyRouteResult(board, result): tracks + vias in one CreateItems commit
  js-router.ts    JsRouter — @tscircuit/capacity-autorouter behind a SimpleRouteJson translation
  freerouting.ts  FreeroutingRouter — java -jar freerouting.jar, DSN in / SES out, two I/O modes
  specctra/       s-expression reader, DSN writer, SES reader (the builtin I/O mode + tests)
  bridge-job.ts   createRouteJobs(): a routing job the bridge can mount under /sessions/:id/route
bench/
  run.ts          the comparison harness -> bench/results/*.json + docs/router-comparison.md
  kicad.ts        spawn kicad-cli api-server on a fixture copy (shared with the integration test)
  fetch-freerouting.ts  downloads the jar (and, with --jdk, a Temurin 25) into vendor/
vendor/           freerouting-<version>.jar and jdk/ — git-ignored, see "Freerouting"
```

## Choosing a JavaScript router

Surveyed 2026-09-07 for a router that runs in Bun and the browser, is open source, takes a generic
input built from our `RouteInput` (not a per-board vendor schema) and reports progress.

| Candidate                                                                        | Licence                                      | Last release                        | Input                                                                                                                                                                  | Layers / vias                                 | DRC awareness                                                                | Progress                                            | Size                                   | Verdict                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `@tscircuit/capacity-autorouter` 0.0.885 (repo `tscircuit/tscircuit-autorouter`) | MIT (repo; the npm manifest omits the field) | 2026-09-05, releases weekly         | `SimpleRouteJson`: layer count, rect obstacles with layer names and `connectedTo` nets, connections as points to connect, bounds, outline, trace/via sizes and margins | any count (`top`, `inner<n>`, `bottom`), vias | clearance to obstacles, its own DRC-repair stages; only rectangles, no zones | `step()` loop, `progress` 0..1, `getCurrentPhase()` | 2.6 MB minified bundle, 3 runtime deps | **picked**                                                                     |
| `@tscircuit/infgrid-ijump-astar` 0.0.35                                          | none declared (tscircuit org is MIT)         | 2025-05-21, superseded by the above | same `SimpleRouteJson` (subset)                                                                                                                                        | 1 or 2 layers (`MultilayerIjump`)             | obstacle margins only                                                        | none (synchronous `solve`)                          | 277 kB                                 | older, no progress, no longer developed                                        |
| `@tscircuit/freerouting` / `freerouting` 0.0.19                                  | none declared                                | 2025-01-28                          | Specctra DSN via `dsn-converter`                                                                                                                                       | Freerouting's                                 | Freerouting's                                                                | —                                                   | 57 kB + Docker                         | a CLI wrapper around Freerouting's cloud API and Docker image, not a JS router |
| `dsn-converter` 0.0.92                                                           | none declared                                | 2026-08-19                          | DSN <-> circuit JSON                                                                                                                                                   | —                                             | —                                                                            | —                                                   | 351 kB                                 | useful only for DSN files; we have KiCad's exporter and `specctra/dsn.ts`      |
| `js-router`, `jsrouter` (npm)                                                    | MIT                                          | 2016 / 2017                         | —                                                                                                                                                                      | —                                             | —                                                                            | —                                                   | —                                      | URL routers for web apps, not PCB routers; no PCB fork exists on npm           |
| `vygr/JS-PCB` (GitHub)                                                           | GPL-2.0                                      | 2018                                | own JSON dialect (the C++ `pcb` router ported)                                                                                                                         | multilayer, vias                              | grid-based clearance                                                         | none                                                | small                                  | unmaintained 8 years, GPL, own format; would need a fork                       |
| `zalo/interactive-router`, `SLWHX/pcb-autorouter-rbr`, misc. student projects    | mixed / none                                 | 2026                                | own                                                                                                                                                                    | 1-2 layers                                    | weak                                                                         | —                                                   | —                                      | experiments, no package, no stability                                          |

**Pick: `@tscircuit/capacity-autorouter`.** It is the only maintained, MIT-licensed router with a
generic input, multilayer vias, an incremental `step()` API (so a page can yield between steps and
show progress) and a DRC-repair pipeline. Its input is built from `RouteInput` in
`buildSimpleRouteJson()`; nothing in this package is written per board.

What it costs us, measured on the practice boards and documented in `js-router.ts`:

- It only knows axis-aligned rectangles, so pads are bounding boxes (a circle becomes its square),
  existing diagonal tracks block a box, rule areas are boxes. All conservative.
- It honours obstacle rectangles strictly but the `defaultObstacleMargin` only loosely (traces cut
  corners by up to ~20 µm), and it spaces its own traces and vias by _their_ declared sizes. The
  translation therefore inflates obstacles by `clearance + width/2 + 50 µm`, tells the solver a via
  `2 × clearance` fatter and a trace `clearance` wider than the net class, and writes the items back
  at their real sizes (`opts.extra.{obstacleInflate,obstacleMargin,viaInflate,traceInflate,safety}`
  override, nm). With that: ecc83 routes DRC-clean; pic_programmer keeps 5 clearance errors out of
  441 tracks (`docs/router-comparison.md`).
- Copper zones are not obstacles (it is not zone-aware); the zone is refilled around the new tracks
  and DRC judges the result. Vias always span every routed layer (through vias).
- The pipeline is all-or-nothing: when its reachability precheck finds a net whose start point is
  sealed in (dense connectors whose inflated pad boxes touch), the run fails with nothing routed.
  `JsRouter` retries with less inflation and then without the nets the error names, so a dense
  board loses a few nets instead of everything; the dropped nets are listed in `log` and `unrouted`.
- `seed` and `viaCost` have no equivalent; `effort` maps to its `effort` option.

The alternative the plan allowed — a grid A\* router of our own — was not needed: the pick routed
100 % of ecc83 in 0.4 s and 97.7 % of pic_programmer in 3.2 s, in-process.

## The common layer

`extractRouteInput(board, { nets?, warn? })` reads, through the model layer:

- `GetBoardEnabledLayers` + `GetBoardLayerName` -> `copperLayers` (F.Cu, In1..InN, B.Cu, with user names);
- `GetItems(SHAPE)` on Edge.Cuts -> `outline` polygons (segments and arcs chained with a 10 µm tolerance, circles/rects/polygons closed; cutouts follow the outer boundary) and `bounds`;
- `GetItems(FOOTPRINT, PAD)` -> `pads` with absolute position/rotation, shape, size, copper layers, drill, footprint reference; custom pads get their real outline's bounding box from `GetPadShapeAsPolygon`;
- `GetItems(TRACE, ARC, VIA)` -> existing copper (arcs as 15° chords);
- `GetItems(ZONE)` -> rule areas as `keepouts` (tracks/vias/copper flags), copper zones as `zones` (outline + fills, net);
- `GetItems(TEXT)`, board shapes and footprint graphics on copper layers -> `obstacles` (bounding boxes via `GetBoundingBox`);
- `GetNets` + `GetNetClassForNets` + `GetBoardDesignRules` -> `rules`: clearance, track width, via size/drill per net class, board minimums, edge clearance;
- `GetRatsnest` -> `connections`: one per airline, endpoints with the item's reachable layers.

`applyRouteResult(board, result)` builds `Track` and `Via` protos (`viaProto` knows KiCad's rule that a
NORMAL pad stack's copper entry is keyed on `F_Cu`) and creates them in **one** commit, so `Undo`
removes the whole routing pass. Positions are rounded to integer nm.

`RouteOptions`: `layers`, `viaCost`, `maxTimeMs`, `nets`, `seed`, `effort`, `extra` — each adapter
logs which of these it cannot honour. `RouteResult`: `tracks`, `vias`, `unrouted` (the router's own
view; the bench re-measures with `GetRatsnest`), `totalConnections`, `timedOut`, `elapsedMs`, `log`.

## Freerouting

`FreeroutingRouter({ board }, { mode, passes, jar, java })` runs
`java -jar freerouting.jar -de in.dsn -do out.ses -mp <passes> --gui.enabled=false`, parses the
`Auto-routing pass #n ... (x unrouted and y violations)` lines into progress, and gets the design in
and out of KiCad in one of two ways:

- **`kicad`** (default when available): `RunBoardJobExportSpecctra` (inline output; the headless
  server plots from disk so the board is saved first) and `ImportSpecctraSession` (contents inline,
  `replace_existing_tracks: false`). This is KiCad's own exporter/importer — exact pad geometry,
  zones as planes, the importer's net/layer/padstack matching — and the items are created by KiCad,
  so `RouteResult.tracks` is empty and the importer's counts are in `log`. Both commands landed in
  the fork on 2026-09-07 (`8cc9377988`, `1f6937d5e5`); `available()` / `resolveMode()` check
  `GetSupportedCommands` and the generated bindings, so the adapter degrades to `builtin` on older
  servers or clients.
- **`builtin`**: `specctra/dsn.ts` writes the DSN from `RouteInput` (each pad its own one-pin
  component so footprint transforms never need undoing; KiCad-style padstack names; zones as planes,
  rule areas and copper graphics as keepouts; existing copper as protected wiring) and
  `specctra/ses.ts` reads the session into tracks/vias for `applyRouteResult()`. Works on any server;
  round/rect/oval pads are exact, rounded and chamfered rects become rects, custom pads their box.

Freerouting has no CLI knob for via cost or a seed, and no "stop and save" signal: `maxTimeMs` kills
the process and yields nothing, so the bench controls it with `-mp` (passes) instead.

Getting the jar: `bun run bench/fetch-freerouting.ts --jdk`. Freerouting is GPL-3.0; the jar is
downloaded from https://github.com/freerouting/freerouting/releases (v2.4.1, 64 MB,
sha256 `251101c3eeac22d7e7dfcf6796603279e5d1000283eb82d8f093780f7afc6aa9`) into `vendor/`, which is
git-ignored, and executed as a separate process — nothing of it is linked or redistributed.
Freerouting >= 2.2 is compiled for **Java 25**; the machine's Temurin 24 refuses it, so `--jdk`
also unpacks a Temurin 25 into `vendor/jdk` (also ignored). `FREEROUTING_JAR` / `FREEROUTING_JAVA`
override both paths.

## Bridge job

`src/bridge-job.ts` is a function the bridge can mount without this package touching the bridge:

```ts
import { createRouteJobs, matchRouteJobPath } from "@kicad-web/router/bridge-job";
const jobs = createRouteJobs();
// in Bun.serve fetch(): const m = matchRouteJobPath(url.pathname); if (m) return jobs.handle(req, { id, transport: session.transport }, m.jobId);
```

| Route                                                                                       | Effect                                                                                 |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /sessions/:id/route` `{router:"js"\|"freerouting", options?, freerouting?, message?}` | starts extract -> route -> apply on the session's open board; `202 {job}`              |
| `GET /sessions/:id/route`                                                                   | list jobs of the session                                                               |
| `GET /sessions/:id/route/:job`                                                              | `{job}`; with `Accept: text/event-stream`: `event: state`, `progress`, `done`, `error` |
| `DELETE /sessions/:id/route/:job`                                                           | cancel (Freerouting gets SIGTERM)                                                      |

The job uses the session's own `NngIpcTransport`; the browser sees the result through the usual
`DocumentChanged` event and a store re-sync.

## Benchmark

```bash
bun run --filter @kicad-web/router bench                      # every fixture board, js + freerouting
bun run bench/run.ts --boards ecc83,pic_programmer --routers js,freerouting,freerouting-builtin --time 600 --passes 100
bun run bench/run.ts --report                                 # regenerate docs/router-comparison.md from bench/results/*.json
```

Per board and router: fresh `kicad-cli api-server` on a temp copy of `e2e/fixtures/boards/<name>/*.unrouted.kicad_pcb`,
`RefillZones`, `GetUnroutedCount` + `RunBoardJobDrc` before; extract, route, apply; `RefillZones`,
`GetUnroutedCount`, `GetNetLengths`, via count, `RunBoardJobDrc` after; `SaveDocument` +
`RunBoardJobExportSvg`. JSON per run in `bench/results/`, the table in `docs/router-comparison.md`.

## Tests

```bash
bun test                          # unit: extraction on a fake transport, DSN/SES helpers, JS router and Freerouting on a synthetic 2-net board
KICAD_CLI=... bun test            # + test/router.kicad.test.ts: the pipeline on ecc83 against a real server
bunx tsc -b packages/router       # from the repo root
```

The Freerouting unit test runs the jar when `vendor/` has it and a Java (no KiCad needed) and skips
with a `[skip]` line otherwise; the integration file skips without `kicad-cli`.
