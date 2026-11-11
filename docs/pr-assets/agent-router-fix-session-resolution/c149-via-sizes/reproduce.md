Encoded via sizes and fallback dimensions must be positive safe integer nanometres with diameter greater than drill. Validation precedes echo matching and item creation. Seven invalid controls and one valid name-fallback control on the same host, cores 20–25, three repeats per revision: before 8e751f3 1 pass / 7 fail; after 8 pass / 0 fail. Explicit circle versus encoded drill mismatch is covered.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session via sizes'
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

Before: apply only added via-size tests to 8e751f3. After: adapter typecheck passes; units 151 pass, one existing jar-dependent skip, zero failures. No native routing benchmark performed; thermal failures unresolved.
