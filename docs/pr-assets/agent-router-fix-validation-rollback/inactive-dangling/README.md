Inactive dangling findings previously triggered destructive cleanup, including ignored rules. Cleanup now requires effective error or warning severity, consistent with the client active-marker helper. The new regression fails first for ignored, exclusion-severity and informational markers; separate error/warning controls still remove scoped dangling copper. Existing mock markers now explicitly carry warning severity, including the excluded-marker control, so those tests continue exercising their intended paths.

Three repeats per source on the same host and cores: inactive copper preserved 0/9 → 9/9; active cleanup 6/6 → 6/6; prior controls 99/99 → 99/99. These are stateful commit/undo diagnostics, not native benchmark measurements. No native thermal completion or safety improvement is claimed. Standalone engine benchmarking bypasses this changed adapter; the historical full engine run remains context only.

Reproduce from the repository root (requires Bun and an existing engine checkout):

```sh
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts AUDIT_OUT=/tmp/inactive-dangling-audit python3 docs/pr-assets/agent-router-fix-validation-rollback/inactive-dangling/reproduce.py
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-validation-rollback/inactive-dangling/render.py
rsvg-convert -w 1600 docs/pr-assets/agent-router-fix-validation-rollback/inactive-dangling/severity.svg -o docs/pr-assets/agent-router-fix-validation-rollback/inactive-dangling/severity.png
```

The reproduction temporarily replaces only adapter source and always restores it. Its baseline source is pinned to the previous evidence commit; both versions run identical current regression files. Raw output and source hashes accompany this document.
