# Eight-layer 1,024-net candidate and report-limit control

Original MIT synthetic fixture, seed 6512. Requires native `pcbnew`, `kicad-cli`
10.0.6 and an output directory that does not exist:

```sh
/usr/bin/python3 -O benchmarks/boards/bga1024/generate.py /tmp/bga1024-new --seed 6512
bun run typecheck
/usr/bin/python3 -O benchmarks/boards/bga1024/test_generate.py
FAB_ROUTER_MODULE=$HOME/bench/repos/fab_router/src/api.ts bun run test:unit
```

The 90 × 90 mm board has eight signal copper layers, a 32 × 32 BGA at 0.5 mm
pitch with 0.2 mm round pads, and four 4 × 64 destination banks with 0.4 mm pads,
0.8 mm horizontal pitch and 1.5 mm row pitch. Each of 1,024 nets has exactly two
terminals (2,048 pads total); destinations are shuffled by the recorded seed.
Track/clearance are 0.10/0.10 mm; through-via diameter/drill are 0.30/0.10 mm.
The companion project is required. There are no planes, pair constraints,
length groups or external footprint libraries. This is an unrouted candidate;
input admission establishes neither routed feasibility nor relative difficulty.

The generator reloads the board and checks net ownership, copper layers,
effective project rules, no tracks/zones, and a fresh native DRC with zero
geometry violations. It exports DSN with a stable root filename. The board,
project and DSN reproduce byte for byte across output directories.

## Native report limit discovered by this board

Native connectivity reports **1,024 opens**, while the fresh DRC JSON report
contains **499 unconnected findings**. These are distinct observations, both
recorded in `summary.json`. KiCad 10.0.6 caps unconnected and clearance findings
at 499 and most other types at 199 in
[its DRC engine](https://github.com/KiCad/kicad-source-mirror/blob/10.0.6/pcbnew/drc/drc_engine.cpp).
A report at the boundary cannot prove an exact count: 499 observed findings
may represent 499 or more actual opens. The fixture remains a diagnostic candidate.
The generator intentionally admits this known report-limited control; it does
not substitute the report count for native connectivity or publish completion.

The benchmark contribution rejects reports at or above the per-type thresholds
before native quality publication and changes cache identity. It conservatively
rejects exact-boundary reports too. Reports below the thresholds are not thereby
proven complete; ignored checks and checker/dependency policy remain separate.
Production native baseline adoption remains pending. The frozen benchmark is
unchanged.

This public contribution contains only the original board, deterministic generator,
native admission test and measurement evidence outside the frozen suite. It does
not change any production router, native checker, scoring or ranked cache policy.
The report-limit rejection was measured in the separate benchmark harness.

Report admission also requires the expected report schema and board name, a
nonempty checker version, error/warning/exclusion coverage, all finding lists,
empty schematic parity and correctly typed error opens. Missing or inconsistent
evidence cannot support the generator's zero-violation diagnostic. Three paired
controls preserve valid admission3/3 while reducing acceptance of nine malformed
variants27/27 to0/27. The mutations apply to fresh reports, not native boards.

```sh
nice -n 10 taskset -c 0-5 timeout 120 /usr/bin/python3 -O benchmarks/boards/bga1024/test_report.py --measure /tmp/bga1024-admission-controls
```

Use a new output directory. The full evidence and limits are retained under
`docs/pr-assets/agent/bga1024-candidate/`.
