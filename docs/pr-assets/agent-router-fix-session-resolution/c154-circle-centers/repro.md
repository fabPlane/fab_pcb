Session circle offsets were discarded: `(circle F.Cu 800 100 0)` became a concentric 800 um via pad, moving copper 100 um relative to the supplied geometry. NewVia cannot represent an eccentric pad independently of its drill. Reject nonzero or malformed centers; preserve omitted and explicit zero centers.

Tests added FIRST. Same seven cases on hyper-ms-lin, cores 20–25, three repeats: before d8525f5 2 pass / 5 fail each; after 7 pass / 0 fail each. Apply the test diff to the before revision to reproduce the failures.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session via circle centers'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c154-circle-centers/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c154-circle-centers/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c154-circle-centers/comparison.png
```

Adapter typecheck passes; configured package unit suite 175 pass, 1 existing jar skip, 0 fail. Import regression measurements only; no router benchmark or native safety/completion claim. Standalone router benchmarking bypasses this reader. Frozen reference remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 new thermal errors, unresolved.
