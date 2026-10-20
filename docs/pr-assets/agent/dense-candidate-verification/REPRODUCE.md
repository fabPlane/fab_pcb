The deterministic six-layer candidate and verifier live outside the frozen routing suite. The verifier checks regeneration, native geometry, pinned project policy, semantic DSN export and fresh native DRC. Its guards preserve local clearance overrides and reject unsupported external rule files and footprint zones and graphics. Footprint graphics can add copper without changing pad geometry or the board-level drawings, so the previous signature silently admitted different native copper geometry. The generator emits no footprint graphics; this fixed-candidate guard rejects graphical items on all layers.

Latest admission benchmark: same seed 6406 fixture, host hyper-ms-lin, cores 0–5, nice 10, native checker 10.0.6, Python `-O`, three independent repeats per case. Before `c3d3dcc`, after this branch. These are verifier executions, with no routing.

| Candidate control | Before accepted | After accepted | Repeats |
|---|---:|---:|---:|
| Unchanged | 3/3 | 3/3 | 3 |
| Footprint graphic on J1 | 3/3 | 0/3 | 3 |
| Footprint graphic on J2 | 3/3 | 0/3 | 3 |
| Footprint graphic on U1 | 3/3 | 0/3 | 3 |

All accepted controls reach fresh native DRC: 0 errors, 439 opens, 30 library warnings. The after verifier rejects the altered boards before export/checking. The unchanged controls remain accepted. This fixes fixed-candidate admission; it does not establish routed feasibility, complete native identity or production baseline adoption. Previously measured custom-rule and net-tie controls remain committed.

![Footprint-graphic admission controls](https://github.com/fabPlane/fab_pcb/blob/agent/dense-candidate-verification/docs/pr-assets/agent/dense-candidate-verification/footprint-graphic-controls.png?raw=true)

Reproduce from the repository root with fresh output directories:

```sh
git show c3d3dcc:benchmarks/boards/dense6-bga324/verify_dense6.py > /tmp/dense6-before59.py
nice -n 10 taskset -c 0-5 timeout 600 /usr/bin/python3 benchmarks/boards/dense6-bga324/measure_footprint_graphics_dense6.py \
  --before /tmp/dense6-before59.py \
  --after benchmarks/boards/dense6-bga324/verify_dense6.py \
  --generator benchmarks/boards/dense6-bga324/gen_dense6.py \
  --fixture benchmarks/boards/dense6-bga324 --out /tmp/dense6-footprint-graphics58
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O -m unittest discover \
  -s benchmarks/boards/dense6-bga324 -p test_verify_dense6.py
nice -n 10 taskset -c 0-5 timeout 180 bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts \
  nice -n 10 taskset -c 0-5 timeout 240 bun run test:unit
```

Validation: typecheck, all eleven unit packages, and fourteen Python tests pass. No layer-check script exists. No frozen boards, checker, scoring, engine or runtime were modified. Source generator is MIT; seed and dimensions are recorded in the candidate README.
