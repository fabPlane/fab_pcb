# Complete track clearance reports

The client defaults reportAllTrackErrors to false (first clearance finding per track).
An existing error can mask a new one on the same track. The adapter now requests
all findings for baseline, post-apply cleanup, and final filled DRC comparison.
Identity/multiplicity checks and ownership-checked rollback remain unchanged.

Same stateful job cases, host hyper-ms-lin, cores 20–25, three repeats per revision:

| Scenario | Before fd25e1a | After |
|---|---:|---:|
| New masked clearance, no refill | 0/3 | 3/3 |
| New masked clearance, refill | 0/3 | 3/3 |
| Existing clearances, no refill | 3/3 | 3/3 |
| Existing clearances, refill | 3/3 | 3/3 |

New findings reject before final save, undo the owned route and restore original
copper. Existing-only controls accept. This models native first-error suppression;
it is not a live editor experiment or a production thermal geometry repair.

Exact reproduction from the repository root (repeat the first command three times):

```sh
taskset -c 20-25 bun test packages/router/test/bridge-validation.test.ts -t 'checks every track clearance'
taskset -c 20-25 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
# Before comparison: apply the test-only diff to fd25e1a in a disposable checkout:
git diff fd25e1a HEAD -- packages/router/test/ > /tmp/c137-tests.patch
# At fd25e1a: git apply /tmp/c137-tests.patch; then run the targeted command above.
```

Configured unit suite: 159 pass, 1 existing skip, 0 fail. Package typecheck passes.
No new router benchmark: standalone harness bypasses this adapter. Prior full
native score remains 39/78 pass, 13/26 valid, 120 opens, 27 thermal errors.
Native refill ownership and live rollback safety remain unresolved.
