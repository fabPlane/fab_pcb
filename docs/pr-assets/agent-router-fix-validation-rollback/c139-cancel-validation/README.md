Cancellation arriving during tentative native DRC previously allowed saving copper
and finishing as done. Check cancellation inside the validation try block so the
existing ownership-checked rejection path restores the tentative commit.
Tests pause validation after apply, cancel, and release validation. They assert
original copper, one undo, no final refill/save, and no success summary.
Stateful stand-ins only; live editor atomicity and thermal safety remain unverified.

Same host, cores 20–25, same cases, three repeats per revision:

| Case | Before 333551e | After |
|---|---:|---:|
| Cancel during tentative DRC, no refill | 0/3 | 3/3 |
| Cancel during tentative DRC, refill requested | 0/3 | 3/3 |

Exact reproduction from repository root:

```sh
taskset -c 20-25 bun test packages/router/test/bridge-validation.test.ts -t 'cancellation during tentative'
taskset -c 20-25 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
# Apply test-only changes to 333551e for before comparison; repeat each version three times.
```

Package suite: 163 pass, 1 existing skip, 0 fail.
Unchanged engine: typecheck, layer check (65 files, zero violations), and
859 tests / zero failures / 398454 assertions pass (215.12 seconds).
No router benchmark completed: standalone harness bypasses this adapter.
Latest full native score remains 39/78 passes, 13/26 valid, 120 opens,
27 thermal errors. Cancellation during apply, ratsnest, or refill is outside this change.
