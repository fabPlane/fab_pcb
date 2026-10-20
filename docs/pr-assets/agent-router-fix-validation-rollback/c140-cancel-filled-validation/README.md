Cancellation received during the final filled native DRC query previously reached
final save and reported done. Check cancellation within the existing validation
try/catch before comparing markers or saving. Owned route commits are undone;
a newer refill entry still prevents rollback and reports copper may remain.

Same host, cores 20–25, same two cases, three repeats per revision:

| Stateful case                                | Before 7bc4961 | After |
| -------------------------------------------- | -------------: | ----: |
| Cancel during filled DRC, route still newest |            0/3 |   3/3 |
| Cancel during filled DRC, newer refill entry |            0/3 |   3/3 |

The first case checks original copper restoration and one undo. The second checks
no undo and an explicit ownership refusal. Both check no final save or summary.
These are stateful stand-ins, not native editor or atomic refill/undo evidence.
No routing gain is claimed. Standalone scoring bypasses this adapter; no unchanged
router sweep was repeated. Latest full native measurement remains 39/78 passes,
13/26 valid cases, 120 opens, 27 thermal errors.

Exact reproduction from repository root:

```sh
taskset -c 20-25 timeout 60 bun test packages/router/test/bridge-validation.test.ts -t 'cancellation during filled DRC'
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

Repeat the test command three times per revision. For before, apply only the
fixture/test diff to 7bc4961, leaving bridge-job.ts at that revision.

Validation: adapter typecheck passes; package suite 165 pass, one existing skip, zero failures. Unchanged engine typecheck/layers (65 files, zero violations)/859 tests pass, 398454 assertions, 209.09 seconds.
