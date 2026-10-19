# Successful refill undo-entry diagnostic

A successful native refill may push an undo entry after the tentative route. Existing coverage only modelled a refill that committed and then threw. The fixture now also models successful completion with a newer entry. Query failure and a newly introduced thermal finding both reject without a final save, refuse to undo the newer entry, report that tentative copper may remain in memory, and keep all original copper. A clean final DRC control saves successfully.

Three repeats per source on the same host, cores 20–25. Before source: `c03e9cd`; after: current source. Production bytes are identical. This extends test coverage; it does not improve native routing or restoration.

| Stateful outcome | Before | After |
| --- | ---: | ---: |
| Existing validation controls | 114/114 | 114/114 |
| Failed validation after committed refill: explicit refusal | 6/6 | 6/6 |
| Failed validation after committed refill: copper restored | 0/6 | 0/6 |
| Clean committed refill: route saved | 3/3 | 3/3 |

Reproduce from repository root:

```sh
FAB_ROUTER_MODULE=$HOME/bench/wt/fr-bugs/src/api.ts AUDIT_OUT=/tmp/committed-refill-audit taskset -c 20-25 nice -n 10 timeout 180 python3 docs/pr-assets/agent-router-fix-validation-rollback/committed-refill/reproduce.py
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=$HOME/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

The reproduction script temporarily replaces only the owned worktree source with the recorded baseline and restores candidate bytes in `finally`. It runs current tests against both sources.

The fixture is a stateful copper/top-entry stand-in, not a native undo stack implementation or live API evidence. `Board.refillZones()` returns `Promise<void>`; undo entries may expose client name, description and an optional API commit ID. Descriptions/client names alone do not prove that an entry belongs to this refill. No ownership inference or multi-entry undo is added. The generated `Undo` request contains only document and count, with no expected commit ID: an atomic compare-and-undo is not exposed. The separate stack query and undo calls remain non-atomic. Native thermal safety and restoration across committed refills remain unresolved. No scored benchmark or history row is warranted: the standalone engine harness bypasses this adapter.
