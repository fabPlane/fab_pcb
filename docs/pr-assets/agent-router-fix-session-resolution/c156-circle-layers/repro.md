Explicit nested circle-layer operands were silently dropped. Two malformed shapes then triggered the all-layer fallback; an extra malformed shape beside a valid span was silently discarded. Reject malformed explicit layer operands before item conversion. Valid quoted and unquoted names remain accepted.

Tests added first. Same four cases on hyper-ms-lin, cores 20–25, three repeats: before 13a3a68 each 2 pass / 2 fail; after each 4 pass / 0 fail. Apply the test diff to the before revision to reproduce failures.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session circle layer operands'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c156-circle-layers/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c156-circle-layers/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c156-circle-layers/comparison.png
```

Adapter typecheck passes; configured units: 184 pass, one existing jar skip, zero failures. Import diagnostics only. No engine change or native routing/safety measurement. The standalone benchmark bypasses this reader; historical native reference remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 thermal errors. No benchmark history row is fabricated.
