A wire with two path geometries silently imported only its first path. Reversing the declarations changed which copper survived. Reject multiple paths before conversion; separate wires and polygon-only plane echoes remain supported.

Same host hyper-ms-lin, cores 20–25, four cases, three repeats: before e9bc468, 2 pass / 2 fail each; after, 4 pass / 0 fail each. Added tests first. To reproduce before, apply only the added test block to e9bc468.

```sh
for repeat in 1 2 3; do
 taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session wire path multiplicity'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --filter @fp-pcb/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c160-wire-paths/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c160-wire-paths/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c160-wire-paths/comparison.png
# Engine worktree:
taskset -c 20-25 nice -n 10 timeout 600 bash -c 'bun run typecheck && bun run check:layers && bun run test'
```

Import diagnostics only. The standalone benchmark bypasses this reader; no native routing gain or safety claim, and no router benchmark history row is due. Latest full native context remains 39/78 passing runs, 13/26 valid cases, 120 opens and 27 thermal errors, unresolved.

Final checks: adapter typecheck and 196 pass / one existing jar skip / zero failures (500 assertions); unchanged engine typecheck, 65 layer checks, 859 pass / zero failures (398454 assertions, 224.84 seconds).
