# Dense six-layer recovery input snapshot

Synthetic six-layer stress input: 702 pads, 263 nets and 439 initial native
unconnected edges. This snapshot supplies exact inputs used for the optional
local recovery measurement. It is outside the frozen autorouter suite.

The original generator is the shared MIT-licensed dense-board generator
`~/bench/boards/dense/gen_dense6.py` (seed 6406). No generator is forked here.
The prepared native case contains the exact native board, project/custom rules,
job metadata and initial native DRC report used in the six paired checks.
`provided.dsn` is the independently provided DSN used by the engine-only stress
comparison. The prepared native case is exported through the standard benchmark
harness, so compare each pair within its own export rather than mixing results.

`inputs.sha256.json` fingerprints every input and the originating generator.
The stored initial native report has 439 unconnected items; report connection
counts directly. Nets are not an appropriate denominator for edge completion.

Three repeats per mode, two normal passes, 600-second cooperative route budget,
optimisation/fanout disabled, strict exact DRC, same host and cores 12–19:

| Prepared native case metric | Recovery off | Recovery on |
|---|---:|---:|
| Passed | 0/3 | 0/3 |
| Opens each | 183, 183, 183 | 182, 182, 182 |
| New native errors each | 0, 0, 0 | 0, 0, 0 |
| Median / p95 seconds | 190.456 / 190.666 | 188.064 / 197.163 |
| Vias each | 315 | 315 |
| Length mm each | 2300.008 | 2305.476 |

No introduced error or warning geometry, fidelity loss or timeout. This remains
an incomplete board, with no speed claim. See the complete paired records in
`docs/pr-assets/agent-router-perf-public-recovery/dense-comparison.json`.

With this repository at `/home/hyper/bench/wt/fp-perf` and the engine checkout
at the pinned revision under `/home/hyper/bench/wt/fr-perf`:

```bash
cd /home/hyper/bench/wt/fr-perf
taskset -c 12-19 nice -n 10 timeout 7200 python3 docs/pr-assets/agent-fab-router-perf-local-rescue/public-dense-native.py /home/hyper/bench/wt/fp-perf/benchmarks/autorouter /home/hyper/bench/wt/fr-perf /home/hyper/bench/wt/fr-perf /home/hyper/bench/wt/fp-perf/benchmarks/boards/dense6-local-recovery/native-case /tmp/unused-dense-native
```
