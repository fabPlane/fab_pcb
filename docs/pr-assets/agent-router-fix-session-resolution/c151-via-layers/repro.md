Declared via layers previously disappeared during conversion, selecting an all-layer fallback. Reject unknown declared layers before echo matching or item creation. Missing padstack fallback and supported aliases are preserved.

Same four cases on the same host, cores 20–25, three repeats: before 64d60ad 2 pass / 2 fail each; after 4 pass / 0 fail each. Apply the added tests to the before revision to reproduce failures.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session via layer identity'
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c151-via-layers/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c151-via-layers/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c151-via-layers/comparison.png
```

Typecheck passes; unit suite 159 pass / 1 existing jar skip / 0 fail. Import diagnostics only; no router benchmark or native thermal safety claim.
