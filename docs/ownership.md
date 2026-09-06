# Ownership

Who owns what, in the spirit of a `CODEOWNERS` file. "Owner" is the agent (see
[05-agents.md](05-agents.md)) whose session edits the path; everybody else changes it only through
the owner or by editing the contract in [contracts.md](contracts.md) first. The coordinator commits.

| Path                                                                                 | Owner                                                                           | Notes                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`                                                                              | Coordinator                                                                     | plan, contracts, gap list; `api-coverage.md` and `coverage-badge.json` are generated (A2's script, run by the coordinator after every fork change)        |
| `packages/proto/`                                                                    | A2 · Proto & codegen                                                            | `src/gen` is generated from the fork's `api/proto`; `KICAD_COMMIT` is the pin                                                                             |
| `tooling/coverage/`                                                                  | A2 · Proto & codegen                                                            | `run.ts` (matrix), `summary.ts` (README line + shields badge, A9)                                                                                         |
| `packages/client/`                                                                   | A4 · Client SDK                                                                 | transports (A3 wrote `src/transport`), `KiCadClient`, generated `commands.ts`, object model, `ItemStore`; `test/conformance` is the API conformance suite |
| `packages/bridge/`                                                                   | A3 · Transport & bridge                                                         | Bun WebSocket ↔ nng bridge, process supervision, file API, static hosting                                                                                |
| `packages/renderer/`                                                                 | A5 · Board renderer (`core/`, `board/`), A6 · Schematic renderer (`schematic/`) | PixiJS `CanvasHost` implementations                                                                                                                       |
| `packages/kicad-patches/`                                                            | A1 · KiCad build (scripts), A7 · API gaps (patch series)                        | `build-macos.sh`, `build-linux.sh` + `docker/` (A9 wrote the Linux image for CI)                                                                          |
| `apps/web/`                                                                          | A8 · App shell                                                                  | React shell, panels, palette, properties editor, mock services                                                                                            |
| `e2e/`                                                                               | A9 · QA & CI                                                                    | Playwright smoke tests, real-project fixtures (`fixtures/NOTICE` for licensing), conformance pointer                                                      |
| `tooling/ci/`                                                                        | A9 · QA & CI                                                                    | per-package unit/integration test runner used by the root scripts and CI                                                                                  |
| `tooling/m0/`                                                                        | A1 · KiCad build                                                                | the M0 raw-socket ping script (frozen reference)                                                                                                          |
| `.github/workflows/`                                                                 | A9 · QA & CI                                                                    | `ci.yml`: bun (unit), e2e (Playwright), kicad-integration (Docker image + `KICAD_CLI`)                                                                    |
| root `package.json`, `bunfig.toml`, `tsconfig*.json`, `.editorconfig`, `.prettierrc` | Coordinator (A9 maintains the scripts and formatting config)                    | workspace list, root scripts                                                                                                                              |
| KiCad fork (`../kicad`, branch `web-api`)                                            | A7 · API gaps (C++)                                                             | every patch: proto + handler + `qa/tests/api` test + coverage rerun + conformance test for A4                                                             |

## Conventions the owners agreed on

- Tests: `bun test` per package; `*.kicad.test.ts` and everything under a `conformance/` directory =
  integration (needs `kicad-cli`, skips when absent, `KICAD_CLI` overrides the path). `bun run test:unit` /
  `bun run test:integration` at the root run every package in its own process (`tooling/ci/run-tests.ts`).
- Formatting: `.prettierrc` — 2 spaces, semicolons, double quotes in `packages/*` and `tooling/*`;
  `apps/web` and `packages/renderer` were written with single quotes and keep them via overrides.
- Generated files (`packages/proto/src/gen`, `tooling/coverage/commands.json`, `docs/api-coverage.md`,
  `docs/coverage-badge.json`) are never hand-edited; CI checks they are fresh (`gen:check`,
  `coverage:check`, `coverage:summary --check`).
