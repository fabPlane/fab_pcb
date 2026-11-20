The adapter now queries native DRC after successful post-apply refill, before the final save. Query failure rejects the job and invokes the existing ownership-checked route rollback. A newer commit refuses rollback; zero undo and undo exceptions report rollback failure. The successful refill control now requires the extra query before saving.

| Same scenarios, same host/cores 20–25, three repeats | Before bc2f305 |      After |
| ---------------------------------------------------- | -------------: | ---------: |
| Four new filled-query failure scenarios              |      0/12 pass | 12/12 pass |
| Seventeen existing controls                          |     51/51 pass | 51/51 pass |

This checks query availability only. Returned DRC markers are not yet compared against a filled pre-route baseline. Native thermal violations therefore remain unresolved. These stateful adapter diagnostics do not prove live native undo behavior or restoration across refill commits. No scored benchmark was run: the standalone harness bypasses this adapter; historical engine scores remain context only.

Reproduce from repository root:

```sh
for run in 1 2 3; do
  timeout 60 taskset -c 20-25 nice -n 10 bun test packages/router/test/bridge-validation.test.ts
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

For before, restore only packages/router/src/bridge-job.ts from bc2f305 in a disposable checkout with the same current fixture/tests; restore the successful-refill expected call sequence to omit the newly required second DRC query. Run the same commands. Raw repeated logs and final source hashes are adjacent.

```sh
rsvg-convert -w 1600 docs/pr-assets/agent-router-fix-validation-rollback/filled-query/filled-query.svg -o docs/pr-assets/agent-router-fix-validation-rollback/filled-query/filled-query.png
```
