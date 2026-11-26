# Marker geometry regression coverage

Production is unchanged. Six stateful cases exercise a one-nanometre position change, copper-layer change, and reversed item order in both refill modes. Each of three repeats passes all 47 focused tests. The sensitivity mutation omits layer and position from the comparison key: four geometry tests fail, both ordering controls pass (43 pass / 4 fail). This is a mutation check, not a failing-before production fix or native benchmark gain.

Reproduce from the repository root:

```sh
for repeat in 1 2 3; do taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/bridge-validation.test.ts; done
cd packages/router
bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun test $(rg --files test -g '*.test.ts' | rg -v 'router.kicad.test.ts$')
```

The standalone benchmark bypasses the adapter, so no routing score or history row is attributed to this coverage change. Safe restoration across a committed native refill remains unresolved.

The before production revision is fccdf06; bridge-job.ts is byte-identical to the candidate. The same candidate tests/fixture run against both sources, three repeats each: 47/47 pass per repeat, all six new identity cases pass. Before/after labels describe production source, not pre-existing test coverage.

Unit suite: 147 pass, one pre-existing missing-runtime skip. The unfiltered package run also attempted live integration and failed because the stock native CLI exited before listening. This environmental failure is retained in adapter-checks.log.
