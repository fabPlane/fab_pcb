# @fp-pcb/e2e

Browser smoke tests for `apps/web`, run with Playwright against the app's **mock services**
(`createMockServices()` in `apps/web/src/main.tsx`), so they need no bridge and no KiCad build.
They exercise the shell end to end: file browser → open project → board editor → pick an item →
edit a property → undo → command palette → theme switch → schematic editor.

```bash
bun install
bun run --filter @fp-pcb/e2e install-browsers   # once: chromium (+ OS deps on Linux)
bun run test:e2e                                   # from the repo root; starts the vite dev server itself
E2E_SERVER=preview bun run test:e2e                # build apps/web and test the built dist (CI mode)
E2E_BASE_URL=http://127.0.0.1:5173 bun run test:e2e   # against a server you started yourself
bun run --filter @fp-pcb/e2e test:ui            # Playwright UI mode
```

Reports and traces land in `e2e/output/` (git-ignored).

## Real-server suite (`real/`)

`real/*.spec.ts` drive the same app against the bridge and a `kicad-cli api-server`; the whole
suite is skipped unless `KICAD_CLI` is set. Each test copies the kitchen-sink project into the
bridge workspace root with project-local library tables (`real/fixtures.ts`), so the QA fixtures
are only read. `real/global-setup.ts` starts the bridge when nothing answers on `BRIDGE_URL`
(default `http://127.0.0.1:4020`), rooted in a throw-away workspace under the system temp
directory that it removes again in the teardown — the bridge's own default root is the KiCad
checkout's `qa/data`, and a run must not leave scratch projects there. Set `WORKSPACE_ROOT`
yourself to override it (a bridge that is already running is reused as it is). The app is served
by vite on port 5174 with `VITE_BRIDGE_URL` pointing at the bridge.

```bash
KICAD_CLI=/path/to/kicad-cli bun run --filter @fp-pcb/e2e test:real
```

Covered: open project → place a via → undo → run DRC → export SVG; route a track with a layer
change; schematic wire → net label through the prompt → undo → cross-probe R1 → ERC;
`real/boards.spec.ts` opens each of the five practice boards under `fixtures/boards/` (and its
`.unrouted` variant), checks the item counts against `GetItemCounts`, that every pad is drawn and
picks with its net, and that DRC runs to completion.

## Practice boards (`fixtures/boards/`)

Five KiCad demo projects (`ecc83`, `sonde_xilinx`, `interf_u`, `pic_programmer`, `stickhub`;
licences in `fixtures/boards/NOTICE`) with a generated `<name>.unrouted.kicad_pcb` each —
tracks, track arcs and vias removed, zone fills dropped, outlines kept — made by
`fixtures/boards/strip-routes.ts` (`bun e2e/fixtures/boards/strip-routes.ts`, `--check` for
staleness; `bun test fixtures/boards` from this directory runs its tests). The board practice
pass (`node apps/web/scripts/prove-kicad.mjs --board <name>`) and the router comparison
(docs/06-routing.md) use them.

## Layout

| Path                        | Contents                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tests/`                    | Playwright specs against the mock services (`*.spec.ts`)                                                                  |
| `real/`                     | specs against real KiCad through the bridge (`KICAD_CLI` required, see above)                                             |
| `fixtures/`                 | real KiCad projects for integration/conformance runs and future renderer pixel tests; see `fixtures/NOTICE` for licensing |
| `conformance/`              | pointer to the IPC API conformance suite, which lives in `packages/client/test/conformance`                               |
| `playwright.config.ts`      | `webServer` = vite dev server or `vite preview` of the built dist                                                         |
| `playwright.real.config.ts` | real-server config: `real/`, one worker, bridge started by `real/global-setup.ts`                                         |

## Conventions

- Selectors prefer roles/text and the app's stable class names (`.file-row`, `.doc-tab`, `.palette`,
  `.statusbar`) over DOM structure. Property inputs carry `data-path` with the dotted proto path.
- Each test starts from a fresh browser context, so persisted UI state (theme, recent projects in
  `localStorage`) never leaks between tests.
- Keep the suite under a minute: it is the gate on every PR (`.github/workflows/ci.yml`, job `e2e`).
