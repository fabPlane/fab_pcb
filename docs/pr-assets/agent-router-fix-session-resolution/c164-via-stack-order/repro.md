Padstack shape order previously determined native drill endpoints. A reversed through span was incorrectly classified as blind/buried; a reversed blind span had reversed endpoints. Normalize declared layers to board copper stack order before echo matching or native conversion. No layers are added to the declared set.

Same host hyper-ms-lin, cores 20–25, four cases repeated three times: before 4a101c7, 2 pass / 2 fail each; after, 4 pass / 0 fail each. Tests added first. Apply the new test block to the before source to reproduce. Ordered and reversed through/blind spans exercise the native proto builder.

```sh
for repeat in 1 2 3; do
 taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session via stack order'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --filter @fp-pcb/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c164-via-stack-order/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c164-via-stack-order/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c164-via-stack-order/comparison.png
# Engine worktree:
taskset -c 20-25 nice -n 10 timeout 600 bash -c 'bun run typecheck && bun run check:layers && bun run test'
```

Conversion regression measurements only. Standalone routing benchmark bypasses this reader; no scored router run or native thermal safety claim. Latest native context remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 thermal errors (unresolved). Adapter typecheck and 212 tests pass, one existing jar skip.

Unchanged engine: typecheck and 65 layer checks pass; 859 tests pass, zero failures, 398454 assertions (219.08 seconds).
