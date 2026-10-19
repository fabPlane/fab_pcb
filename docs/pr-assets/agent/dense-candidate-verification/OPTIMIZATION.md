# Optimized native verifier controls (cycle45)

Python removes assert statements with `-O` or `PYTHONOPTIMIZE=1`. The original
verifier silently bypassed geometry, project rules, DSN equality, topology,
determinism and native DRC gates. Its export statement also disappeared entirely
inside an optimized child Python process. Explicit condition checks and an
unconditional export now preserve those operations under optimization.

Same host, fixtures and generator, three repeats per control; `/usr/bin/python3 -O`:

| Control | Original accepted | Corrected accepted |
|---|---:|---:|
| Valid candidate | 3/3 | 3/3 |
| Altered default clearance | 3/3 | 0/3 |
| Lowered native minimum | 3/3 | 0/3 |
| Moved footprint | 3/3 | 0/3 |
| Altered DSN width | 3/3 | 0/3 |

These are constructed evidence failures. Candidate feasibility, ranked scoring,
router behavior and quality definitions are unchanged. No routing gain claimed.
All valid native reports retain zero errors and 439 unconnected items. There are
30 library warnings per native board. Pads-only footprints do not prove assembly
clearance or routed feasibility.

From repository root:

```sh
git show 04992e9:benchmarks/boards/dense6-bga324/verify_gen_dense6.py > /tmp/dense6-verifier-before45.py
nice -n 10 taskset -c 0-5 timeout 1200 /usr/bin/python3 benchmarks/boards/dense6-bga324/measure_optimized_gen_dense6.py \
  --before /tmp/dense6-verifier-before45.py --after benchmarks/boards/dense6-bga324/verify_gen_dense6.py \
  --generator benchmarks/boards/dense6-bga324/gen_dense6.py --fixture benchmarks/boards/dense6-bga324 \
  --out /tmp/dense6-optimized-controls45
bun run typecheck
bun test
/usr/bin/python3 -m unittest discover -s scripts/gen -p test_verify_gen_dense6.py
```

Output directory must not already exist. Native KiCad Python bindings and
`kicad-cli` are required. Rejection reasons are checked; unrelated process failures
do not count as successful negative controls. Summary: optimized-controls.json.
