A padstack with 600/800 um layer circles was imported as an 800 um barrel; reversing the shapes produced a 600 um barrel. NewVia has one diameter, so both conversions change supplied copper. Reject unequal scaled layer diameters instead of taking the last circle. Uniform sizes remain supported.

Same four cases, same host hyper-ms-lin, cores 20–25, three repeats: before ecd015f 2 pass / 2 fail each; after 4 pass / 0 fail each. Tests were added and run before changing production code. Apply the test diff to the before revision to reproduce failures.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session via layer diameter'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --cwd packages/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c153-layer-diameters/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c153-layer-diameters/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c153-layer-diameters/comparison.png
```

Typecheck passes; package unit suite 168 pass / 1 existing jar skip / 0 fail. Import regression measurements only: no router benchmark, native non-regression or thermal safety claim. Frozen engine reference remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 new thermal errors. Standalone engine benchmarking does not exercise this session reader.
