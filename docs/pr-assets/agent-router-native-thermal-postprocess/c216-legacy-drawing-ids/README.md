# Select thermal proposal generation with legacy drawing support

Pin the engine to `a8f7762467b97863032a55e3b924dfd199456dac`. The selected change fixes a real generator exception:
three immutable drawing circles in a retained source share a UUID. Duplicate IDs
are allowed only entirely among recognized drawing objects, which stay unchanged.
Copper/footprint/zone/unknown collisions and every native acceptance requirement
still reject. Source text-routing code is unchanged. Three generation trials on the
same complete-board power-net control change 0/3 success/zero candidates to 3/3
success/158 candidates. A fail-first regression and all native guards pass.

Same host `hyper-ms-lin`, cores 20–25, native 10.0.6, 26 frozen cases × three seeds
in EACH fresh complete single-engine opt-in run:

| Measure | Before | Selected pin |
|---|---:|---:|
| Passed attempts | 45/78 | 45/78 |
| Cases passing 3/3 | 15/26 | 15/26 |
| Opens | 120 | 120 |
| New native thermal errors | 18 | 18 |
| Observed median route-path seconds | 9.178637 | 9.448480 |

All 156 attempts completed and were checked. All 78 outcome/fidelity/integrity/
warning/policy results, physical copper, DSNs/sessions and six successful repair
sequences/checkpoint geometries match. Controls and copied configurations match
apart from the selected engine checkout. Before used `926485d2`, whose executable
src/tools match old pin `34f33a19`. Concurrent work prevents a speed inference.
No new scored routing gain is claimed. Fresh stock control remains 39/78,
13/26 valid, 120 opens and 27 thermals.

The newly unblocked standalone power-net search checks 270 candidates, removes one
thermal in a private intermediate, then declines publication with one remaining.
It retains 95 opens and all source/current pairs/ownership; caller boards stay
unchanged. This does not establish adapter recovery within its unchanged 600-second
cap. The full-context diagnostic also stays rejected for 235 lost source pairs.
The picture shows the one-track thermal reduction, not a publishable routed board.

Package checks with the selected pin: typecheck and 109 tests pass, six existing
native-server/jar availability skips, zero failures, 416 assertions, 24.18 seconds.
Engine checks: typecheck/layers65zero/931tests0fail398961assertions. Initial setup
used a repo-relative pin path from the package directory and omitted the explicit
engine module, yielding an unchanged old pin and a corpus-availability failure.
Both logs are retained; the absolute pin write and correctly configured complete
package command then passed. No test/assertion/timeout/native policy was weakened.

```sh
cd /home/hyper/bench/wt/fp-bugs/packages/router
env -u KICAD_CLI FAB_ROUTER_MODULE=/home/hyper/bench/wt/fr-bugs/src/api.ts FAB_ROUTER_NATIVE_SEARCH_SOURCE=/home/hyper/bench/wt/fr-bugs taskset -c 20-25 nice -n 10 timeout 900 bash -c 'bun run typecheck && bun run test'
cd /home/hyper/bench/wt/fp-bugs
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c216/before-control --out /tmp/c216-pin-before-configs
taskset -c 20-25 nice -n 10 timeout 7200 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/agents/codex-fabpcb-bugs/scratch/c216/before-control --config-dir /tmp/c216-pin-before-configs --out /tmp/c216-pin-before
python3 packages/router/bench/native-thermal-config.py --engine /home/hyper/bench/wt/fr-bugs --out /tmp/c216-pin-after-configs
taskset -c 20-25 nice -n 10 timeout 7200 python3 benchmarks/autorouter/benchmark.py --router fab-router --fab-router-source /home/hyper/bench/wt/fr-bugs --config-dir /tmp/c216-pin-after-configs --out /tmp/c216-pin-after
```

[Complete engine evidence, commands, raw archives, licenses and replay](https://github.com/fabPlane/fab_router/tree/agent/fab-router-native-drc-gate/docs/pr-assets/agent-fab-router-native-drc-gate/c216-legacy-drawing-ids).
This pin depends on [the engine change](https://github.com/fabPlane/fab_router/pull/44).
The frozen benchmark, checker, scoring, default configuration and live editor are unchanged.

![One-track native thermal reduction](https://github.com/fabPlane/fab_pcb/blob/agent/router-native-thermal-postprocess/docs/pr-assets/agent-router-native-thermal-postprocess/c216-legacy-drawing-ids/comparison.png?raw=true)
