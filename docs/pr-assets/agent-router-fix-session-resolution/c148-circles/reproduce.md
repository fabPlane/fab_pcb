Explicit circle diameters must fail before board-item conversion if malformed. Previously NaN, missing and nested values became zero and selected a fallback; negative and non-finite sizes propagated. Require a positive safe integer nanometre diameter after scaling. Non-circle shapes retain their existing behavior.

Same host hyper-ms-lin, cores 20–25, nine identical cases, three repeats each. Before 72a33d5: 1 pass / 8 fail each; after: 9 pass / 0 fail each. The valid fractional two-layer control also checks board-item conversion. This is parser correctness evidence, not native routing validation.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session circle'
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 600 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
```

For before, apply only the added circle tests to 72a33d5. Adapter typecheck passes; package units: 143 pass, one existing jar-dependent skip, zero failures. No native benchmark was completed; thermal failures remain unresolved.
