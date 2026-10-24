Resolution parsing filtered nested operands and ignored extra values. Reject malformed positional operands before any scale-dependent copper conversion.

Same host hyper-ms-lin, cores 20–25, four cases, three repeats: before a87d3f3, 2 pass / 2 fail each; after, 4 pass / 0 fail each. Added tests first. To reproduce before, apply only the added test block to a87d3f3.

```sh
for repeat in 1 2 3; do
 taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session resolution operand structure'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --filter @fp-pcb/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c161-resolution-operands/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c161-resolution-operands/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c161-resolution-operands/comparison.png
# Engine worktree:
taskset -c 20-25 nice -n 10 timeout 600 bash -c 'bun run typecheck && bun run check:layers && bun run test'
```

Import diagnostics only. The standalone benchmark bypasses this reader; no native routing gain or safety claim, and no router benchmark history row is due. Latest full native context remains 39/78 passing runs, 13/26 valid cases, 120 opens and 27 thermal errors, unresolved.

Final checks: adapter typecheck, 200 passing tests / one existing jar skip / zero failures (506 assertions); unchanged engine typecheck, 65 layer checks, 859 passing tests / zero failures (398454 assertions, 213.40 seconds).
