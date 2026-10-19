# Engine pin: search expansion budgets

Advance the engine pin from `69cf598` to `76534d6`, the implementation commit reviewed in https://github.com/fabPlane/fab_router/pull/38 . It prevents obsolete heap entries from consuming current-best expansion budgets. Raw pop diagnostics and cancellation/deadline polling remain intact. The engine PR contains failing-before regression tests, repeated original/candidate logs, the plot renderer and portable reproduction.

The full standalone native suite measured precisely these old/new engine bytes on the same host and cores 20–25, 26 cases × three repeats, identical input/config/checker/runtime/order/seeds. `native-comparison.json` includes all candidate attempts, matched-control flags and raw-evidence hashes; `candidate-source.json` identifies all 74 measured candidate files. This is the engine comparison for this pin change, not a separate rerun or live adapter transaction test.

| Measurement | Old pin | New pin |
| --- | ---: | ---: |
| Synthetic single-layer detour found, three repeats | 0/3 | 3/3 |
| Synthetic layered detour found, three repeats | 0/3 | 3/3 |
| Native passes | 39/78 | 39/78 |
| Native cases passing 3/3 | 13/26 | 13/26 |
| Opens | 120 | 120 |
| New thermal errors | 27 | 27 |
| Median route seconds | 1.172079 | 1.326766 |

Every native attempt's outcome, error types, fidelity, vias and track length matches. Shared-host timing is descriptive; overlapping engine tests make an isolated speed comparison unavailable. Observed median is 13.2% higher; no speed gain or timing nonregression claim. Native thermal starvation remains unresolved. The standalone harness bypasses the job adapter; this PR does not incorporate the separate native-validation work.

Package validation: typecheck passes; 96 unit tests pass, one existing runtime-dependent test skips, zero failures, 376 assertions. Tests select the measured candidate with `FAB_ROUTER_MODULE`; pin resolution/download is not exercised by that override.

```bash
(cd packages/router && taskset -c 20-25 nice -n 10 timeout 600 bun run typecheck)
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
# Run once with each engine checkout at the old/new pin, distinct output directories.
taskset -c 20-25 nice -n 10 timeout 2400 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /path/to/engine-checkout --out /path/to/new-results
```
