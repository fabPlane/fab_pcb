Add an original deterministic eight-layer escape candidate: a 20 × 20 BGA at 0.65 mm pitch, 400 two-terminal nets, 800 pads, and four destination banks. The companion project specifies 0.10 mm tracks/clearance and 0.30/0.10 mm vias/drills. Every layer is signal copper; there are no plane, pair or length constraints.

This adds geometry and layer-count coverage beyond the six-layer candidate. Native input admission does not establish routed feasibility, monotonic routing difficulty, or an engine gain. Scoring and frozen fixtures are unchanged.

Native before/after qualification on hyper-ms-lin, cores 0–5, nice 10, checker 10.0.6; the same candidate and rules, three independent fresh DRCs per column:

| Check                      | Before: committed input, 3 repeats | After: regenerated input, 3 repeats |
| -------------------------- | ---------------------------------: | ----------------------------------: |
| Native errors              |                          0 / 0 / 0 |                           0 / 0 / 0 |
| Native warnings            |                          0 / 0 / 0 |                           0 / 0 / 0 |
| Native opens               |                    400 / 400 / 400 |                     400 / 400 / 400 |
| Board/project/DSN identity |                    Reference bytes |                   3/3 exact matches |

The generator checks native topology, stack and loaded project rules before export and fresh DRC. Checks use explicit exceptions under optimized Python. Source is original and MIT licensed; all generation parameters and seed 6408 are recorded.

The candidate lives under `benchmarks/boards/bga400/`, outside the frozen autorouter suite. No runtime adapter changes.

Reproduce from this checkout (new output directory):

```sh
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O benchmarks/boards/bga400/generate.py /tmp/bga400-new --seed 6408
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O benchmarks/boards/bga400/test_generate.py
bun install --frozen-lockfile
nice -n 10 taskset -c 0-5 timeout 180 bun run typecheck
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts nice -n 10 taskset -c 0-5 timeout 180 bun run test:unit
```

Validation: native test passes with three fresh regenerations and exact artifact comparisons; typecheck passes; 11/11 unit packages pass. This repository defines no layer-check script. The first unit invocation selected the wrong local module entrypoint; the command above passes.

![Eight-layer escape candidate](https://github.com/fabPlane/fab_pcb/blob/agent/eight-layer-bga400/docs/pr-assets/agent/eight-layer-bga400/board.png?raw=true)

Additional retained corpus qualification on the same machine, three routing
repeats per compatible case, ten-second route budget, unchanged routing/scoring
code. Existing cases and the added candidate are separated:

| Cohort                        |                        Before |                         After |
| ----------------------------- | ----------------------------: | ----------------------------: |
| Existing corpus attempts      |                           144 |                           144 |
| Existing validated passes     |                            33 |                            33 |
| New board timeouts / attempts | 9 / 9, implicit default rules | 9 / 9, intended project rules |

The external harness initially dropped the bundled project. That cohort is
retained as a control. Its fetch boundary was corrected before a separate fresh
candidate cohort. Normalized rules changed from clearance/track/via/drill
0.20/0.20/0.60/0.30 mm to the intended 0.10/0.10/0.30/0.10 mm, with exact companion
project digest and eight layers verified. The input rule profiles differ;
there is no measured routing gain or feasibility claim. This public contribution
provides the complete board/project/DSN fixture outside the frozen suite.

Exact commands on the retained local reference-harness installation (dependency
and engine prerequisites must already be configured):

```sh
export JS_AUTOROUTER=$HOME/bench/wt/js_autorouter
export FAB_ROUTER_SOURCE=$HOME/bench/repos/fab_router
export FREEROUTING_JAR=$HOME/bench/repos/fab_pcb/benchmarks/autorouter/runtime/c/freerouting-2.5.0.jar
export _JAVA_OPTIONS=-XX:ActiveProcessorCount=6
cd "$HOME/bench/agents/codex-bench-boards/scratch/cycle64/run"
for suite in canary bga ladder dense-source dense-candidate; do
 nice -n 10 taskset -c 0-5 timeout 600 bun scripts/measure-current.ts "$suite" 3
 bun run compare --suite "$suite"
done
cd "$HOME/bench/agents/codex-bench-boards/scratch/cycle64/corrected-run"
nice -n 10 taskset -c 0-5 timeout 600 bun scripts/measure-current.ts dense-candidate 3
bun run compare --suite dense-candidate
```

The full installation uses primary harness pin `73e281f`; the second checkout
adds only the bundled fetch fix and focused candidate manifest. These external
measurements require that harness checkout and are supplemental; the native
fixture/test commands above are self-contained in this public repository.
