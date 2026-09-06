# @kicad-web/e2e

Browser smoke tests for `apps/web`, run with Playwright against the app's **mock services**
(`createMockServices()` in `apps/web/src/main.tsx`), so they need no bridge and no KiCad build.
They exercise the shell end to end: file browser → open project → board editor → pick an item →
edit a property → undo → command palette → theme switch → schematic editor.

```bash
bun install
bun run --filter @kicad-web/e2e install-browsers   # once: chromium (+ OS deps on Linux)
bun run test:e2e                                   # from the repo root; starts the vite dev server itself
E2E_SERVER=preview bun run test:e2e                # build apps/web and test the built dist (CI mode)
E2E_BASE_URL=http://127.0.0.1:5173 bun run test:e2e   # against a server you started yourself
bun run --filter @kicad-web/e2e test:ui            # Playwright UI mode
```

Reports and traces land in `e2e/output/` (git-ignored).

## Layout

| Path                   | Contents                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tests/`               | Playwright specs (`*.spec.ts`)                                                                                            |
| `fixtures/`            | real KiCad projects for integration/conformance runs and future renderer pixel tests; see `fixtures/NOTICE` for licensing |
| `conformance/`         | pointer to the IPC API conformance suite, which lives in `packages/client/test/conformance`                               |
| `playwright.config.ts` | `webServer` = vite dev server or `vite preview` of the built dist                                                         |

## Conventions

- Selectors prefer roles/text and the app's stable class names (`.file-row`, `.doc-tab`, `.palette`,
  `.statusbar`) over DOM structure. Property inputs carry `data-path` with the dotted proto path.
- Each test starts from a fresh browser context, so persisted UI state (theme, recent projects in
  `localStorage`) never leaks between tests.
- Keep the suite under a minute: it is the gate on every PR (`.github/workflows/ci.yml`, job `e2e`).
