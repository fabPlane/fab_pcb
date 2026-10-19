Disabling zone refill previously also bypassed the native error comparison: a successfully returned DRC result containing a new active error was saved unless it identified dangling copper. The adapter now captures the pre-apply native baseline for both refill modes. With refill disabled it compares native markers after dangling cleanup and before accepting the tentative commit. New error identities or multiplicities invoke ownership-checked rollback. Existing and excluded findings remain allowed. With refill enabled the comparison still runs after the final refill.

| Identical scenarios on hyper-ms-lin, cores 20–25, three repeats per version | Before 6ca8207 | After |
| --- | ---: | ---: |
| No refill: new error, duplicate, same-count replacement | 0/9 pass | 9/9 pass |
| No refill: existing and excluded controls | 6/6 pass | 6/6 pass |
| Prior validation scenarios | 78/78 pass | 78/78 pass |

The fixture models commit ownership and copper restoration; this is not live native undo proof. Error fixtures use native thermal marker types but no actual zone refill occurs on this explicit opt-out path. A native checker may report findings against stale fills in this mode. Default filled-state validation remains necessary for detecting thermal starvation. Cross-refill restoration and atomic ownership checks remain unresolved.

Required checks: adapter typecheck and unit runner (131 pass, one existing jar-dependent skip, zero failures). The unchanged engine's full required checks pass: typecheck, layers (65 files, zero violations), 859 tests, zero failures (223.60 seconds); see engine-checks.log. Source fix: 3a249ff. No engine benchmark was repeated: the frozen standalone harness bypasses this adapter. Historical full-engine context remains in ../native.json; no new thermal benchmark improvement or timing gain is claimed.

Run from repository root:
```sh
for run in 1 2 3; do
  timeout 60 taskset -c 20-25 nice -n 10 bun test packages/router/test/bridge-validation.test.ts
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-validation-rollback/unfilled-errors/chart.py
```

To reproduce the five new scenarios before the fix, in a disposable checkout with the final tests and fixture installed:
```sh
git show 6ca8207:packages/router/src/bridge-job.ts > packages/router/src/bridge-job.ts
for run in 1 2 3; do
  timeout 60 taskset -c 20-25 nice -n 10 bun test packages/router/test/bridge-validation.test.ts -t 'zone refill disabled'
done
```
The full before logs were captured before updating earlier tests' expected query sequences. Those updates account only for the new pre-apply baseline query (also the long-chain control's query count 27→28). No copper, state, save, or rollback expectations were weakened. All six raw repeat logs, source hashes and the measured chart script/SVG/PNG are adjacent. Rendering uses the existing rsvg-convert; no packages were installed.
