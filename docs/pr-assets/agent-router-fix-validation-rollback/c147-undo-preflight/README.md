# Undo capability preflight

Before tentative application, require the editor's server undo capability. Unsupported capability and a failed capability query previously allowed a successful apply; both now fail before native baseline checking or applying copper. This uses the existing client capability API. Successful supported-editor controls are retained in the full suite. The initial save remains unchanged.

| Same cases on same host, 3 repeats            | Before | After |
| --------------------------------------------- | -----: | ----: |
| Correct rejection before application / repeat |    0/2 |   2/2 |
| Incorrectly applied / repeat                  |    2/2 |   0/2 |

Stateful fixtures, not a live editor. This does not establish availability of undo at a later time, atomic rollback, or ownership across zone refill. Shared native reference remains 39/78 passed, 13/26 valid, 120 opens, 27 new thermal errors; no native router run completed this cycle. The standalone benchmark bypasses the changed adapter.

Reproduce from repository root on the parent source and candidate, preserving identical test changes:

```sh
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 timeout 90 bun test packages/router/test/bridge-validation.test.ts -t 'undo capability preflight'
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

Adapter checks: typecheck PASS; 169 pass, one existing runtime skip, zero fail. Existing test doubles now explicitly advertise supported server undo; assertions are unchanged. Unchanged engine checks PASS: typecheck, 65 layer files with zero violations, 859 tests with zero failures (205.87 s). Source commit: `6de50d9`. Raw repeated logs and source hashes are retained alongside this file.
