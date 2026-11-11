Explicit rectangular and polygonal via pad shapes silently became circular copper, using the encoded name or another layer's circle. The native via type has one circular diameter and cannot preserve these shapes. Reject explicit unsupported shapes before import; retain circular shapes and fallback for absent metadata.

Regression tests added FIRST. Same five cases on hyper-ms-lin, cores 20–25, three repeats: before 39c4fd1 each 2 pass / 3 fail; after each 5 pass / 0 fail. Apply the test diff to the before revision to reproduce failures. No rule or checker changes.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session via shape representability'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c155-via-shapes/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c155-via-shapes/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c155-via-shapes/comparison.png
```

Adapter typecheck passes; configured package units: 180 pass, one existing jar skip, zero failures. No engine production change, native routing measurement or native safety claim. The standalone harness bypasses this reader; historical native reference remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 thermal errors. No history row is fabricated for these unit diagnostics.
