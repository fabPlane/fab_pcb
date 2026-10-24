Duplicate resolution declarations within routes or placement previously selected the first scale silently. Reject ambiguous section scales before reading copper. Separate routing and placement resolutions and placement-only fallback remain supported.

Same host hyper-ms-lin, cores 20–25, four cases repeated three times: before c249313, 2 pass / 2 fail each; after, 4 pass / 0 fail each. Tests added first. Apply only the new test block to the before source to reproduce.

```sh
for repeat in 1 2 3; do
 taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session resolution multiplicity'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --filter @fp-pcb/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c163-resolution-multiplicity/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c163-resolution-multiplicity/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c163-resolution-multiplicity/comparison.png
# Engine worktree:
taskset -c 20-25 nice -n 10 timeout 600 bash -c 'bun run typecheck && bun run check:layers && bun run test'
```

Import diagnostics only. Standalone routing benchmark bypasses this reader; no scored run/history row or native safety/gain claim. Latest native context remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 thermal errors (unresolved). Adapter typecheck and 208 tests pass, one existing jar skip.

Engine checks: typecheck and 65 layer checks pass; 859 tests pass, zero failures, 398454 assertions (219.86 seconds). Engine source unchanged.
