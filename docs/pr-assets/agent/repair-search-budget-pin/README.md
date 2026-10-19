# Opt-in extended search budget

Expose `extra.extendedSearchBudget` as an explicit boolean in the native adapter,
reject invalid values before solving, and update the engine pin to 4bff3692fd07f7d4d716556c2de447000daf5c7b.
The engine change is reviewed in https://github.com/fabPlane/fab_router/pull/42. Default routing behavior is preserved;
extended mode doubles bounded planar/layered node-pop budgets. Add the MIT
connector fixture under `benchmarks/boards/connector-search-budget`, outside the
frozen suite. Engine regression and adapter contracts cover the option.

Same machine, six assigned cores, same inputs, three repeats per configuration:

| Frozen native solenoid J1 | Baseline 69cf598 | Candidate default | Candidate extended |
| --- | ---: | ---: | ---: |
| Valid repeats | 3/3 | 3/3 | 3/3 |
| Opens / new native errors, each run | 0 / 0 | 0 / 0 | 0 / 0 |
| Vias, each run | 12 | 12 | 12 |
| Wire length mm, each run | 352.691 | 352.691 | 358.771 |
| Median route seconds | 0.823 | 0.850 | 0.792 |

Separate L1 SRJ engine measurement: baseline five opens each vs extended two each,
zero internal spacing violations, three repeats each; median 12.893s vs 14.556s.
This is an opt-in completion gain at a runtime cost. Enabled native wire length
increases 1.7%; timings overlap checks and are not a speed claim. Native acceptance
uses stock KiCad 10.0.6 and the unchanged frozen checker. No full-suite claim.

The initial always-enabled experiment failed an existing engine fingerprint test
and was rejected. It is retained under `rejected-default/`; final candidate
results are under `default/` and `extended/`, with every source hash verified
against the final opt-in implementation. The recorded candidate Git revision is
its pre-commit parent; source digests distinguish the measured trees.

Reproduce with verified runtime and separate engine checkouts:

```sh
bun install --frozen-lockfile
bun run --cwd packages/router typecheck
bun test packages/router/test/fab-router.test.ts
nice -n 10 taskset -c 6-11 timeout 300 python3 benchmarks/autorouter/benchmark.py --router fab-router --case kitspace-solenoid-driver-j1 --fab-router-source /path/to/baseline --out /tmp/native-before
nice -n 10 taskset -c 6-11 timeout 300 python3 benchmarks/autorouter/benchmark.py --router fab-router --case kitspace-solenoid-driver-j1 --fab-router-source /path/to/candidate --out /tmp/native-default
python3 docs/pr-assets/agent/repair-search-budget-pin/make-config.py benchmarks/autorouter /tmp/extended-configs
nice -n 10 taskset -c 6-11 timeout 300 python3 benchmarks/autorouter/benchmark.py --router fab-router --case kitspace-solenoid-driver-j1 --fab-router-source /path/to/candidate --config-dir /tmp/extended-configs --out /tmp/native-extended
```

The engine PR contains exact standalone SRJ reproduction commands and raw runs.
Adapter typecheck and all 11 focused tests pass (43 assertions).

![Opt-in search budget comparison](https://github.com/fabPlane/fab_pcb/blob/agent/repair-search-budget-pin/docs/pr-assets/agent/repair-search-budget-pin/budgets.png?raw=true)
