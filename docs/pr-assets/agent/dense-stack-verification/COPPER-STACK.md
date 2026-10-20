The deterministic six-layer candidate verifier now compares the enabled copper stack in order, including native layer IDs, names and types. The previous signature compared only the copper-layer count, so changing an inner layer name or its signal/power/mixed designation still passed while the bundled DSN stayed unchanged. The board, generator and routing scores are unchanged.

The existing candidate includes reproducibility, geometry, project-rule and fresh native DRC checks. This change completes the copper-stack comparison in that fixed-candidate check; it does not establish complete native identity or production native baseline adoption.

Admission benchmark on hyper-ms-lin, cores 0–5, nice 10, seed 6406, native checker 10.0.6, Python `-O`. Before `27b3944`, after this branch; identical input cases and three independent repeats per case, 24 verifier executions. These controls perform no routing.

| Candidate control | Before accepted | After accepted | Repeats |
|---|---:|---:|---:|
| Unchanged | 3/3 | 3/3 | 3 |
| Renamed inner layer | 3/3 | 0/3 | 3 |
| Power inner layer | 3/3 | 0/3 | 3 |
| Mixed inner layer | 3/3 | 0/3 | 3 |

All 15 accepted executions reach fresh native DRC for both generated and bundled boards: 0 errors, 439 opens, 30 library warnings. All altered candidates reject before export/checking with the revised verifier. Persisted mutations are reloaded to confirm the name/type changes survive saving and retain six layers. No routing improvement or routed feasibility is claimed.

![Copper-stack admission](https://github.com/fabPlane/fab_pcb/blob/agent/dense-stack-verification/docs/pr-assets/agent/dense-stack-verification/copper-stack-controls.png?raw=true)

Exact reproduction from the repository root, with fresh output directories:

```sh
git show 27b3944:benchmarks/boards/dense6-bga324/verify_dense6.py > /tmp/dense6-before61.py
nice -n 10 taskset -c 0-5 timeout 600 /usr/bin/python3 benchmarks/boards/dense6-bga324/measure_copper_stack_dense6.py \
  --before /tmp/dense6-before61.py --after benchmarks/boards/dense6-bga324/verify_dense6.py \
  --generator benchmarks/boards/dense6-bga324/gen_dense6.py --fixture benchmarks/boards/dense6-bga324 --out /tmp/dense6-copper-stack61
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O -m unittest discover \
  -s benchmarks/boards/dense6-bga324 -p test_verify_dense6.py
nice -n 10 taskset -c 0-5 timeout 180 bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts \
  nice -n 10 taskset -c 0-5 timeout 240 bun run test:unit
```

Validation: typecheck, all eleven unit packages, fifteen optimized Python tests. No layer-check script is defined. Initial unit invocations omitted the required local engine module selector and failed the corpus worker import; the configured command above passes. No frozen benchmark, checker, scoring, engine or runtime changes.

Additional native export probe: after ignoring only the DSN root export filename, the renamed and power-layer mutations change the exported DSN; the mixed-layer mutation retains the same DSN payload. All three change the persisted native stack contract. This establishes export sensitivity for two controls, without claiming a routing effect for any control.
