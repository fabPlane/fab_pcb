Cancellation during the tentative native ratsnest query previously reached final save
when refill was disabled. With refill enabled it continued into refill and only
then observed cancellation. Check inside the existing validation try/catch so
owned tentative copper is undone before relabel, refill, or save.

Same host, cores 20–25, two stateful cases, three repeats per revision:

| Case                                                    | Before 74bf7b4 | After |
| ------------------------------------------------------- | -------------: | ----: |
| Cancellation during tentative ratsnest, refill disabled |            0/3 |   3/3 |
| Cancellation during tentative ratsnest, refill enabled  |            0/3 |   3/3 |

Each case checks cancellation, no summary, exact original copper restoration,
one apply/undo, no post-apply refill, and no final save. These are stateful
stand-ins, not live native editor evidence. No routing gain is claimed.
Standalone scoring bypasses the adapter. Latest full native measurement remains
39/78 passes, 13/26 valid cases, 120 opens, 27 thermal errors; no unchanged sweep
was repeated and no new benchmark result is claimed.

Reproduce from repository root (repeat targeted command three times):

```sh
taskset -c 20-25 timeout 60 bun test packages/router/test/bridge-validation.test.ts -t 'cancellation during tentative ratsnest'
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

For before, apply only the fixture/test changes to 74bf7b4, leaving
bridge-job.ts unchanged. Adapter typecheck passes; configured unit suite:
167 pass, one existing skip, zero failures, 796 assertions.

Unchanged engine checks PASS: typecheck, layer checks (65 files, zero violations),
859 tests, zero failures, 398454 assertions, 216.32 seconds.
