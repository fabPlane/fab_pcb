# Ownership checks for cleanup and relabel undos

The previous PR revision checked the newest native commit before undoing a route on a
failed DRC request. Two other tentative-route undos still lacked that check: dangling-copper
cleanup after a successful DRC response, and route-message relabeling after a ratsnest query.
An unrelated edit arriving during either query could be undone, followed by a successful job.
All three paths now share the same commit-ID check and undo-count validation.

The same four regressions run on the same host, cores 20–25, three repeats per version:

| Version             | Tests passing per repeat | Newer edits preserved | Owned controls passing |
| ------------------- | -----------------------: | --------------------: | ---------------------: |
| Previous PR c332543 |                      2/4 |                   0/2 |                    2/2 |
| Candidate           |                      4/4 |                   2/2 |                    2/2 |

The two newer-edit cases must fail the job without undo, reapply, success summary or final
save. The owned controls still clean up or relabel with one undo. Existing tests now expose
their mock commit IDs and require the ownership query before cleanup. No assertions were
removed. This is a stateful API stand-in; it does not prove live native undo behavior.
The stack query and undo are separate requests, so this check does not make them atomic.

Reproduce from the repository root with installed dependencies:

```bash
timeout 120 taskset -c 20-25 nice -n 10 python3 \
  docs/pr-assets/agent-router-fix-validation-rollback/ownership/audit.py \
  --out /tmp/router-undo-ownership-audit
(cd packages/router && bun run typecheck)
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts \
  timeout 600 taskset -c 20-25 nice -n 10 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-validation-rollback/ownership/render.py
```

The portable audit uses identical candidate tests in disposable snapshots of c332543 and
current source. audit.json records every source/test hash and all six raw test logs are
included. The plot derives its counts from that report. No bridge/service is started.

No native benchmark was repeated: the standalone harness bypasses this changed adapter.
The previous PR's full 26-case ×3 engine-context measurements remain 39/78 passes,
13/26 valid cases, 120 opens, 27 new thermal errors before and after, with identical engine
source and geometry. This follow-up makes no completion, thermal-safety or performance claim.
Native post-refill validation and ownership-aware restoration across refill commits remain
unresolved; refusing an unsafe undo can leave tentative copper in native memory.
