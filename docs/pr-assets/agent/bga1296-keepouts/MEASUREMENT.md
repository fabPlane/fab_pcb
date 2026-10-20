# Cycle 75 routing measurement

Same host, cores 0–5, nice 10, three fresh repeats and a ten-second routing
budget per attempt. Four ready backends; three accept the new native fixture.
The paired new-board variants differ only in their two all-layer routing
keepouts. Native terminal signatures and project rules agree in all three
qualification repeats, and both normalized variants preserve the constraints.
The paired variants have identical connectivity and placement, but deliberately
different routing constraints.

|Router|Without keepouts: completed / valid passes|With keepouts: completed / valid passes|Attempts each|
|---|---:|---:|---:|
|fab_router|0 / 0|0 / 0|3|
|reference engine|0 / 0|0 / 0|3|
|in-repo router|0 / 0|0 / 0|3|

Neither variant has a validated routing result at this budget. Reported engine
timeouts cannot establish relative difficulty or feasibility. No routing gain,
candidate promotion or native connection denominator adoption is claimed.

The full five-suite cohort preserves the prior 54 compatible groups, each with
three repeats (162 attempts). The two new variants, each with three compatible backends, add 18 attempts for
180 total. Existing fixture, backend, machine and external runtime observations
match the preceding cohort. No attempts are discarded or retried.

|Metric|Before: cycle 74|After: existing cases in cycle 75|
|---|---:|---:|
|Attempts|162|162|
|Engine completed|59|55|
|Timeouts|103|107|
|Validated passes|33|33|

|Suite|Router|Before completed|After completed|Before passes|After passes|Attempts each|
|---|---|---:|---:|---:|---:|---:|
|canary|fab_router|12|12|9|9|12|
|canary|reference engine|9|9|6|6|9|
|canary|capacity-mesh router|3|3|3|3|3|
|canary|in-repo router|12|12|3|3|12|
|bga|fab_router|0|0|0|0|12|
|bga|reference engine|0|0|0|0|6|
|bga|capacity-mesh router|0|0|0|0|6|
|bga|in-repo router|0|0|0|0|12|
|ladder|fab_router|5|3|3|3|18|
|ladder|reference engine|3|3|3|3|9|
|ladder|capacity-mesh router|6|6|6|6|9|
|ladder|in-repo router|9|7|0|0|18|
|dense-source|fab_router|0|0|0|0|3|
|dense-source|reference engine|0|0|0|0|3|
|dense-source|in-repo router|0|0|0|0|3|
|dense-candidate|fab_router|0|0|0|0|9|
|dense-candidate|reference engine|0|0|0|0|9|
|dense-candidate|in-repo router|0|0|0|0|9|

All-attempt outcomes, including new variants: {'timeout': 125, 'completed': 55}.
Quality observations: {'unavailable': 144, 'srj-scored': 18, 'native-drc': 18}. Changed existing per-case pass groups:
[]. Unknown quality never establishes validity. Engine
completion and validated passing are separate observations.


These are diagnostic corpus observations, not an engine modification. Exact
routing reproduction requires the separate benchmark checkout and its locally
pinned engine/runtime prerequisites; see benchmark contribution #28. The native
fixture itself is independently reproducible in this repository:

```sh
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O docs/pr-assets/agent/bga1296-keepouts/qualify.py /tmp/bga1296-qualification
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O -m unittest discover -s benchmarks/boards/bga1296 -p 'test_*.py'
bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts bun run test:unit
```

All 11 unit packages, typecheck and four optimized native tests pass. All native
variants regenerate exactly. Endpoint source/runtime observations have bounded
coverage and do not prove loaded dependencies or continuous identity. Sequential
host contention limits causal timing comparisons. The zero geometry findings
qualify the input only; the checker caps its open findings at 499 while native
connectivity observes 1,296. No complete DRC-clean routing is established, and
no frozen suite, scoring rule, engine or dependency pin changes.
