The adapter now captures native DRC markers from the filled board immediately before tentative apply, then compares the final refilled board before saving. New active errors reject the job and invoke the existing ownership-checked rollback. Marker identities use error type, layer, exact native position and sorted involved item IDs; regenerated marker UUIDs and descriptions are excluded. Counts are retained per identity, so duplicate findings and same-total replacement errors cannot disappear into a total-count comparison. Excluded findings are ignored. Existing errors with new marker UUIDs remain allowed.

| Identical stateful scenarios, host hyper-ms-lin, cores 20–25, three repeats per version | Before 0aad64e | After |
| --- | ---: | ---: |
| New thermal, duplicate thermal, same-count replacement | 0/9 pass | 9/9 pass |
| Unchanged markers and excluded markers | 6/6 pass | 6/6 pass |
| Existing validation controls | 63/63 pass | 63/63 pass |

Package typecheck and unit runner: 126 pass, one existing jar-dependent skip, zero failures. Unchanged engine checks also pass: typecheck, layer checks (65 files, zero violations), and 859 tests with zero failures. These are adapter unit diagnostics with a stateful copper/undo stand-in. Live native undo and restoration across separately committed fills are unverified. A newer undo entry refuses rollback, fails the job and reports that tentative copper may remain. This does not establish a native thermal benchmark improvement. No scored benchmark was run because the standalone engine harness bypasses the adapter. Historical full-engine evidence remains in ../native.json.

From repository root:
```sh
for run in 1 2 3; do
  timeout 60 taskset -c 20-25 nice -n 10 bun test packages/router/test/bridge-validation.test.ts
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
rsvg-convert -w 1600 docs/pr-assets/agent-router-fix-validation-rollback/filled-markers/filled-markers.svg -o /tmp/filled-markers.png
```

For the before comparison in a disposable checkout, use the same final fixture/tests, restore only packages/router/src/bridge-job.ts from 0aad64e, and remove the expected baseline DRC call from the successful-refill call sequence; the filled-query failure test expects two DRC calls instead of three. These changes describe the earlier call protocol without changing any new marker assertions. The three before/after logs and final source/test hashes are adjacent.

The explicit refillZones:false path still skips this filled-state comparison. Error severity is the native effective RuleSeverity.RS_ERROR; warnings and excluded/ignored findings do not count as new errors. Exact marker position changes conservatively count as new errors even if they might represent a moved version of an old violation. Separate undo-stack query and undo operations remain non-atomic.
