Cancellation during baseline native DRC previously allowed the job to apply copper,
save, and finish as done. Check cancellation before every tentative apply, including
cleanup retries. Stateful regressions pause baseline DRC until cancellation.
They do not establish live editor atomicity or thermal safety.

Same host, cores 20–25, same cases, three repeats per revision:

| Case | Before 4617942 | After |
|---|---:|---:|
| Cancel during baseline, no refill | 0/3 | 3/3 |
| Cancel during baseline, refill | 0/3 | 3/3 |

Exact reproduction from repository root:

```sh
taskset -c 20-25 bun test packages/router/test/bridge-validation.test.ts -t 'cancellation during baseline'
taskset -c 20-25 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
# Apply test-only changes to 4617942 for before comparison; repeat each version three times.
```

Package suite: 161 pass, 1 existing skip, 0 fail. Validation file: 57 pass.
No router benchmark completed: standalone harness bypasses this adapter.
Latest full native score remains 39/78 passes, 13/26 valid, 120 opens,
27 thermal errors. Native refill ownership remains unresolved.
Cancellation after an apply has started is outside this change.
