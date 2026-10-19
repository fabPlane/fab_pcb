A failed native ratsnest request used to leave tentative copper in memory before the job failed. The same ownership-checked rollback now handles DRC and tentative ratsnest query failures. This covers the pre-refill relabel query; final measurement behavior is unchanged.

| Same scenarios, same host, three repeats | Before | After |
| --- | ---: | ---: |
| Owned rollback, zero undo count, undo exception | 0/9 pass | 9/9 pass |

The fixture models copper state and undo. It is not live native undo proof, a scored benchmark, or final-filled thermal protection. The standalone routing benchmark bypasses this adapter; no new run or score is claimed. Existing PR full-engine baseline remains context only.

Reproduce after:
```sh
cd /home/hyper/bench/wt/fp-bugs
bun test packages/router/test/bridge-validation.test.ts
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```
For before, install the same fixture/test files over source from commit 517c357 in a disposable checkout, then run the identical test command. Raw logs contain six pre-existing controls plus the three new scenarios: before 6 pass/3 fail; after 9 pass/0 fail per repeat.
