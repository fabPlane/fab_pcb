Declared via padstacks with one distinct copper layer previously became through vias (one shape), or invalid zero-span vias (duplicate shapes/aliases). Require two distinct mapped layers when metadata is declared and normalize repeated aliases before echo matching and creation. Missing metadata fallback remains.

Same five cases on the same host, cores 20–25, three repeats: before e18b0dc 1 pass / 4 fail each; after 5 pass / 0 fail each. Apply the added tests to the before revision to reproduce failures.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 60 bun test packages/router/test/specctra.test.ts -t 'session via distinct layer span'
done
bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c152-via-span/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c152-via-span/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c152-via-span/comparison.png
```

Typecheck passes; unit suite 164 pass / 1 existing jar skip / 0 fail. Import diagnostics only; no router benchmark, native non-regression, or thermal safety claim. Before targeted runs omitted nice; both finish below one second, with no timing claim.
