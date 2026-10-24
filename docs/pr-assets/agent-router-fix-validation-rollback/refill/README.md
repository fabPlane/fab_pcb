A failed post-apply zone refill previously saved fab_router copper with stale fills and reported success. The adapter now fails before the final save, preserving the refill error. It attempts to undo the accepted route only while that route commit is newest. A newer refill commit, zero undo count or undo exception reports rollback failure and warns that tentative copper may remain in memory. Other engines retain their existing refill behavior.

| Same scenarios, same host/cores 20–25, three repeats per version                                     | Before (432353a) |      After |
| ---------------------------------------------------------------------------------------------------- | ---------------: | ---------: |
| Five new scenarios: owned failure, zero undo, undo exception, newer refill commit, successful refill |        3/15 pass | 15/15 pass |
| Twelve existing validation controls                                                                  |       36/36 pass | 36/36 pass |

These are stateful adapter unit diagnostics. The newer-refill case deliberately refuses rollback, preserving in-memory state rather than undoing an unidentified entry. No live native refill-stack restoration, final-filled DRC comparison, thermal safety or routing completion gain is established. The standalone native harness bypasses this adapter and was not rerun; historical engine scores remain context only.

Reproduce from repository root:

```sh
for run in 1 2 3; do
  timeout 60 taskset -c 20-25 nice -n 10 bun test packages/router/test/bridge-validation.test.ts
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

For before, install bridge-job.ts from 432353a in a disposable checkout with identical current fixture/tests, then repeat the first command. Raw logs and source hashes are adjacent. Regenerate the measured chart:

```sh
rsvg-convert -w 1600 docs/pr-assets/agent-router-fix-validation-rollback/refill/refill.svg -o docs/pr-assets/agent-router-fix-validation-rollback/refill/refill.png
```
