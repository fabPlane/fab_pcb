Unknown session wire/via nets previously became copper with net code 0. Require the named net to exist in the input before echo matching or item creation. Known net codes remain unchanged. Four identical cases on this host, cores 20–25, three repeats per revision: before 7b8c9b3 2 pass / 2 fail; after 4 pass / 0 fail each.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session net identity'
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

Before: apply only the added net-identity tests to 7b8c9b3. After: typecheck passes; units 155 pass, one existing jar-dependent skip. This is an import correctness diagnostic, not a router benchmark. Native thermal failures remain unresolved.
