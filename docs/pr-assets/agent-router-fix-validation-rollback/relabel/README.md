When the native connection count changed the commit label, the adapter undid its validated commit and reapplied the route without checking the replacement. A later native DRC failure was never queried, so the job could save and report success.

Relabelled commits now re-enter the existing ownership-checked validation/cleanup loop. The finite pass bound includes one extra validation pass; unstable connection counts stop after undoing the final tentative commit. The regression checks original copper restoration, no final save or summary on failure, and successful acceptance after two DRC checks.

| Identical scenarios, same host, 3 repeats per version     |     Before |      After |
| --------------------------------------------------------- | ---------: | ---------: |
| Failed replacement DRC; valid replacement; unstable count |   0/9 pass |   9/9 pass |
| Existing validation controls                              | 27/27 pass | 27/27 pass |

These are stateful adapter unit diagnostics, not live native undo evidence or scored routing benchmarks. Final-filled thermal protection remains unresolved. The standalone native benchmark bypasses this adapter, so it was not rerun; the PR retains its historical engine comparison separately.

Reproduce after:

```sh
cd /home/hyper/bench/wt/fp-bugs
bun test packages/router/test/bridge-validation.test.ts
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

For before, use bridge-job.ts from 7439fef with identical current fixture/test files in a disposable checkout, then repeat the test command three times. The six raw logs each contain nine existing controls plus three new scenarios. audit.json records final source/test hashes. The SVG/PNG plots the nine new repeated assertions of scenario behavior.

Regenerate the chart: `rsvg-convert -w 1600 docs/pr-assets/agent-router-fix-validation-rollback/relabel/relabel.svg -o docs/pr-assets/agent-router-fix-validation-rollback/relabel/relabel.png`.
