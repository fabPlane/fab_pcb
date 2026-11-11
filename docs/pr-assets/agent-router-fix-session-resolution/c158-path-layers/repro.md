Malformed wire layer operands previously dropped routed copper: nested layer forms discarded the wire during parsing; empty names survived parsing and were skipped during conversion. Reject both at the parser boundary. Quoted and unquoted valid names preserve exact track width and endpoint.

Tests were added before the fix. Same four cases on hyper-ms-lin, three repeats per revision: before 4fa33ae 2 pass / 2 fail; after 4 pass / 0 fail. Apply the test diff to that revision for the before run.

```sh
for repeat in 1 2 3; do
  taskset -c 20-25 nice -n 10 timeout 30 bun test packages/router/test/specctra.test.ts -t 'session path layer operands'
done
taskset -c 20-25 nice -n 10 timeout 300 bun run --filter @fp-pcb/router typecheck
FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts taskset -c 20-25 nice -n 10 timeout 300 bun tooling/ci/run-tests.ts unit --filter @fp-pcb/router
python3 docs/pr-assets/agent-router-fix-session-resolution/c158-path-layers/render.py
rsvg-convert docs/pr-assets/agent-router-fix-session-resolution/c158-path-layers/comparison.svg -o docs/pr-assets/agent-router-fix-session-resolution/c158-path-layers/comparison.png
```

Configured adapter units: 188 pass, one existing jar skip, zero failures; typecheck passes. The first unconfigured package run failed to resolve the engine module; rerunning with FAB_ROUTER_MODULE passed. Import diagnostics only; standalone benchmark bypasses this reader. No native routing benchmark or safety gain claimed. Latest historical native score remains 39/78 passing runs, 13/26 valid cases, 120 opens, 27 thermal errors; no history row fabricated.
