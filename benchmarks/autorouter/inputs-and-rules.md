# Benchmark inputs and rules

This is the input index and human-readable contract for `standalone-autorouter-v1`.
All 26 prepared starting boards, task definitions, native design rules and baseline DRC reports
are committed in this directory. No board download, original evaluation workspace or model prompt
is needed. Each router receives the prepared input and its frozen per-job configuration.

## Files included for every case

Paths below are relative to `cases/CASE_ID/`. Open a case folder from the index below to see all
of its files together.

| File | What it supplies |
| --- | --- |
| `board.kicad_pcb` | Exact prepared starting input: footprints, placement, pads, nets, outline, copper layers, board setup and any retained tracks/vias/zones |
| `board.kicad_pro` | Native project design rules, net classes, widths, clearances and DRC settings |
| `board.kicad_dru` | Native custom-rule sidecar; some cases contain only `(version 1)` because no additional custom rules are needed |
| `job.json` | Job type, target nets/footprint, required power widths, retained-zone/task metadata, normalized rule values and input provenance |
| `baseline-drc.json` | Full native DRC findings before routing, used to distinguish new errors from existing findings |
| `LICENSE` | Captured source-board license |

The `.kicad_dru` file alone is not the complete rule set. Keep the project, board setup and
`job.json` with it. The runner stages native sidecars with each board before routing/checking.
Dimensions explicitly suffixed `_mm` are millimetres. Use the per-case values; do not substitute
a single width or clearance for the whole suite.

[Suite manifest](suite.json) selects the 26 cases and repeats. [Engine configurations](configs/)
and their [settings](configs/settings/) contain the frozen adapter commands and per-job router
options. [Input checksums](inputs.sha256.json) protect cases, settings and the captured harness.
[Origin](ORIGIN.json) and [engine revisions](engines.lock.json) identify the original comparison.

## Required outcomes

| Job | Cases | Input state and required result |
| --- | ---: | --- |
| J1: whole-board route | 6 | Fixed placement with tracks, vias and zones removed. Connect every required net. |
| J2: reroute after an edit | 9 | Selected nets already have their copper removed. Reconnect `target_nets` in `job.json`; preserve every untargeted track/via, including its geometry, width, layer, net and multiplicity. No removal or duplication of retained copper. |
| J3: power widths | 5 | Route the prepared board and respect each `power_nets` minimum width on every applicable track segment. |
| J4: keep a ground pour | 6 | Route while preserving the original zone definitions. The checker refills a separate output copy and requires connected ground without filled islands, orphan ground copper or isolated/island findings. |

The corrected suite excludes Aquarius J3. All remaining pair-specification lists are empty;
there is no differential-pair coupling/skew test in these 26 cases.

Every attempt must have zero native opens and zero **new native DRC errors** compared with its
baseline. New warnings are recorded. Footprints, pad properties, nets, outline, copper layers,
board setup and zone definitions must be preserved. Project/custom-rule sidecars must remain
byte-identical. The original checker permits at most 0.001 mm position displacement for footprints
and pads while preserving their other checked properties. DRC ignored-check/severity policy must
also remain unchanged. The exact executable contract is the included
[native checker v4.3](harness/native-check-v4.3.py).

Do not change inputs/rules/checker, relax gates, hand-repair returned boards or drop failed
attempts to improve a score. Candidate changes belong in a separate engine checkout or alternate
configuration directory, as described in [README.md](README.md).

## Repeats, measurements and ranking

The default run schedules all five engines on every case with seeds/repeats 1, 2 and 3: 390
attempts. Execution is sequential with a deterministic shuffled order, default engine parallelism
and a 3600-second safety stop per attempt. Installation, independent checking and visualization
are outside routing time; required export, conversion, route, import and cleanup are inside it.

A task is valid only when the router passes **3/3** repeats. Measure through-via count, total
track length and full route-path time; use medians of the three passing runs. J2 copper metrics
include retained copper. Score quality/time only on cases where at least two routers pass 3/3:

- Efficient = 50 × (best vias + 1)/(vias + 1) + 50 × best length/length.
- Fast = 100 × fastest time/time.
- A router's score averages its eligible cases. Rank by valid tasks, then Efficient, then Fast.

The report shows failures separately. One-repeat smoke runs cannot earn 3/3 task validity or
comparison scores. [Archived results](baselines.json) reproduce the original scores in the existing
tests. These are public development tasks, not hidden holdouts or manufacturing acceptance.

## All 26 inputs

The case link opens the full folder, including the native project/custom rules and baseline DRC.
The task/rules link exposes the precise net names, scope and required values for that input.

| Case folder | Job | Starting input | Task and rule values |
| --- | --- | --- | --- |
| [fan-controller-fan-controller-j1](cases/fan-controller-fan-controller-j1/) | J1 | [KiCad board](cases/fan-controller-fan-controller-j1/board.kicad_pcb) | [job.json](cases/fan-controller-fan-controller-j1/job.json) |
| [fan-controller-fan-controller-j2-large](cases/fan-controller-fan-controller-j2-large/) | J2 | [KiCad board](cases/fan-controller-fan-controller-j2-large/board.kicad_pcb) | [job.json](cases/fan-controller-fan-controller-j2-large/job.json) |
| [fan-controller-fan-controller-j2-medium](cases/fan-controller-fan-controller-j2-medium/) | J2 | [KiCad board](cases/fan-controller-fan-controller-j2-medium/board.kicad_pcb) | [job.json](cases/fan-controller-fan-controller-j2-medium/job.json) |
| [fan-controller-fan-controller-j2-small](cases/fan-controller-fan-controller-j2-small/) | J2 | [KiCad board](cases/fan-controller-fan-controller-j2-small/board.kicad_pcb) | [job.json](cases/fan-controller-fan-controller-j2-small/job.json) |
| [hellscribe-hellscribe-j1](cases/hellscribe-hellscribe-j1/) | J1 | [KiCad board](cases/hellscribe-hellscribe-j1/board.kicad_pcb) | [job.json](cases/hellscribe-hellscribe-j1/job.json) |
| [hellscribe-hellscribe-j2-large](cases/hellscribe-hellscribe-j2-large/) | J2 | [KiCad board](cases/hellscribe-hellscribe-j2-large/board.kicad_pcb) | [job.json](cases/hellscribe-hellscribe-j2-large/job.json) |
| [kitspace-aquarius-j4](cases/kitspace-aquarius-j4/) | J4 | [KiCad board](cases/kitspace-aquarius-j4/board.kicad_pcb) | [job.json](cases/kitspace-aquarius-j4/job.json) |
| [kitspace-lcr-addon-j3](cases/kitspace-lcr-addon-j3/) | J3 | [KiCad board](cases/kitspace-lcr-addon-j3/board.kicad_pcb) | [job.json](cases/kitspace-lcr-addon-j3/job.json) |
| [kitspace-solenoid-driver-j1](cases/kitspace-solenoid-driver-j1/) | J1 | [KiCad board](cases/kitspace-solenoid-driver-j1/board.kicad_pcb) | [job.json](cases/kitspace-solenoid-driver-j1/job.json) |
| [kitspace-solenoid-driver-j3](cases/kitspace-solenoid-driver-j3/) | J3 | [KiCad board](cases/kitspace-solenoid-driver-j3/board.kicad_pcb) | [job.json](cases/kitspace-solenoid-driver-j3/job.json) |
| [kitspace-solenoid-driver-j4](cases/kitspace-solenoid-driver-j4/) | J4 | [KiCad board](cases/kitspace-solenoid-driver-j4/board.kicad_pcb) | [job.json](cases/kitspace-solenoid-driver-j4/job.json) |
| [nextbusclock-nextbusclockv1-j2-large](cases/nextbusclock-nextbusclockv1-j2-large/) | J2 | [KiCad board](cases/nextbusclock-nextbusclockv1-j2-large/board.kicad_pcb) | [job.json](cases/nextbusclock-nextbusclockv1-j2-large/job.json) |
| [nextbusclock-nextbusclockv1-j2-medium](cases/nextbusclock-nextbusclockv1-j2-medium/) | J2 | [KiCad board](cases/nextbusclock-nextbusclockv1-j2-medium/board.kicad_pcb) | [job.json](cases/nextbusclock-nextbusclockv1-j2-medium/job.json) |
| [nextbusclock-nextbusclockv1-j2-small](cases/nextbusclock-nextbusclockv1-j2-small/) | J2 | [KiCad board](cases/nextbusclock-nextbusclockv1-j2-small/board.kicad_pcb) | [job.json](cases/nextbusclock-nextbusclockv1-j2-small/job.json) |
| [nextbusclock-nextbusclockv1-j3](cases/nextbusclock-nextbusclockv1-j3/) | J3 | [KiCad board](cases/nextbusclock-nextbusclockv1-j3/board.kicad_pcb) | [job.json](cases/nextbusclock-nextbusclockv1-j3/job.json) |
| [paperino-hw-paperino-shield-j4](cases/paperino-hw-paperino-shield-j4/) | J4 | [KiCad board](cases/paperino-hw-paperino-shield-j4/board.kicad_pcb) | [job.json](cases/paperino-hw-paperino-shield-j4/job.json) |
| [photon-sprinkler-sprinkler-j1](cases/photon-sprinkler-sprinkler-j1/) | J1 | [KiCad board](cases/photon-sprinkler-sprinkler-j1/board.kicad_pcb) | [job.json](cases/photon-sprinkler-sprinkler-j1/job.json) |
| [photon-sprinkler-sprinkler-j3](cases/photon-sprinkler-sprinkler-j3/) | J3 | [KiCad board](cases/photon-sprinkler-sprinkler-j3/board.kicad_pcb) | [job.json](cases/photon-sprinkler-sprinkler-j3/job.json) |
| [qrpcard-qrpcard-j1](cases/qrpcard-qrpcard-j1/) | J1 | [KiCad board](cases/qrpcard-qrpcard-j1/board.kicad_pcb) | [job.json](cases/qrpcard-qrpcard-j1/job.json) |
| [qrpcard-qrpcard-j2-medium](cases/qrpcard-qrpcard-j2-medium/) | J2 | [KiCad board](cases/qrpcard-qrpcard-j2-medium/board.kicad_pcb) | [job.json](cases/qrpcard-qrpcard-j2-medium/job.json) |
| [qrpcard-qrpcard-j2-small](cases/qrpcard-qrpcard-j2-small/) | J2 | [KiCad board](cases/qrpcard-qrpcard-j2-small/board.kicad_pcb) | [job.json](cases/qrpcard-qrpcard-j2-small/job.json) |
| [qrpcard-qrpcard-j4](cases/qrpcard-qrpcard-j4/) | J4 | [KiCad board](cases/qrpcard-qrpcard-j4/board.kicad_pcb) | [job.json](cases/qrpcard-qrpcard-j4/job.json) |
| [rufs-smart-psu-j1](cases/rufs-smart-psu-j1/) | J1 | [KiCad board](cases/rufs-smart-psu-j1/board.kicad_pcb) | [job.json](cases/rufs-smart-psu-j1/job.json) |
| [rufs-smart-psu-j3](cases/rufs-smart-psu-j3/) | J3 | [KiCad board](cases/rufs-smart-psu-j3/board.kicad_pcb) | [job.json](cases/rufs-smart-psu-j3/job.json) |
| [rufs-smart-psu-j4](cases/rufs-smart-psu-j4/) | J4 | [KiCad board](cases/rufs-smart-psu-j4/board.kicad_pcb) | [job.json](cases/rufs-smart-psu-j4/job.json) |
| [sv650sds-sds-tool-j4](cases/sv650sds-sds-tool-j4/) | J4 | [KiCad board](cases/sv650sds-sds-tool-j4/board.kicad_pcb) | [job.json](cases/sv650sds-sds-tool-j4/job.json) |
