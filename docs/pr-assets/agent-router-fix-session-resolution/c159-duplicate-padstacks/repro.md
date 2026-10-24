Duplicate padstack identifiers previously used last-definition-wins semantics, silently changing the copper diameter of every via referencing that identifier. Reject duplicate definitions before replacing any metadata, including quoted/unquoted aliases. Distinct names preserve their individual via sizes and positions.

Four regression cases on hyper-ms-lin, cores 20–25, three repeats per revision: before f2316d3, 1 pass / 3 fail per repeat; after, 4 pass / 0 fail. Tests were added first. For before reproduction, apply only the added test block to f2316d3.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session duplicate padstack definitions'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --filter @fp-pcb/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c159-duplicate-padstacks/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c159-duplicate-padstacks/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c159-duplicate-padstacks/comparison.png
# In the engine worktree:
taskset -c 20-25 nice -n 10 timeout 600 bash -c 'bun run typecheck && bun run check:layers && bun run test'
```

Adapter units: 192 pass, one existing jar skip, zero failures. Initial typecheck caught an inferred optional tuple member in the new test; explicit readonly tuples fix the fixture typing. Import regression diagnostics only: the standalone native benchmark bypasses this reader. No native routing benchmark or thermal safety gain claimed; latest native context remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 thermal errors. No router history row is due.

Engine validation: typecheck and 65 layer checks pass; 859 tests pass, zero failures, 398454 assertions (227.76 seconds).
