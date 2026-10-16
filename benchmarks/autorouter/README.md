# Standalone autorouter benchmark

Run from the FabPCB repository root:

```bash
bun run benchmark:autorouter
```

This runs **26 fixed tasks × five routers × three repeats = 390 attempts**, then writes
`report.html`, `summary.json`, `results.json`, and full native evidence under a new
`benchmarks/autorouter/results/<timestamp>/` directory. Open `report.html` for the comparison
visualization: overall results, task outcomes, selectable input/output boards and expandable
failure evidence. Keep its adjacent `boards/` and `runs/` directories with it when sharing.
No LLM is launched. This folder is independent of FabPCB's routing API and Fabdesk.

The five engines are **Freerouting 2.5.0, fastroute 0.1.13, fab_router at 69cf598,
TraceMaker 0.9.0 (CPU), and KiCadRoutingTools 0.23.0**. The inputs, per-job settings,
standalone adapters, checker v4.3 and scoring are from the corrected second comparison.
Zap! remains excluded because its study was paused incomplete. Parked routers are not added.

## Setup

Supported environment: **Linux x86-64**, Python 3.12 with stock KiCad **10.0.6** `pcbnew` and
`/usr/bin/kicad-cli`, and **Bun 1.4+**. The checker verifies the original KiCad binary hash.
First-time router installation also needs `python3-venv`, CMake, a C++20 compiler, CLI11,
nlohmann-json, Eigen 3.4, Boost 1.81+, SQLite3, zstd and the dependencies in TraceMaker's pinned CMake project. Existing FabPCB or
Fabdesk KiCad bundles are not used. Install system prerequisites once before invoking the command.

If router assets are absent, the command downloads checksum-verified archives at the versions
in `engines.lock.json`, builds TraceMaker's CPU target, and prepares KRT's Python environment.
Installation is outside measured routing time. Binaries/caches/results are ignored by Git.
Compiled TraceMaker binary hashes may differ across toolchains; source and actual binary
identities are recorded. A different checker version needs a separately versioned benchmark.

An existing original-comparison runtime can be copied once without network access:

```bash
python3 benchmarks/autorouter/setup.py --from-comparison /path/to/original/standalone-runtime
```

Check setup without routing, or run the quick setup smoke:

```bash
bun run benchmark:autorouter --check
bun run benchmark:autorouter --smoke
```

The smoke runs one small case once per router. It is explicitly labeled as a smoke in JSON and
HTML; no 3/3 validity or comparison score is claimed. A complete 390-run baseline has not been
collected for this new entry point. The five-router smoke passed 5/5 with native checks.

## Using it with Claude or another agent

Point the agent at this directory. Its job is to run a baseline, inspect failures, change the
candidate engine in a separate checkout, and rerun. The benchmark provides measurements;
the agent chooses how to improve the router. Do not edit fixtures/checker or weaken rules.

For a modified standalone fab_router checkout:

```bash
bun run benchmark:autorouter --fab-router-source /path/to/fab_router
```

The other four routers retain their original paths/settings. Every run records the candidate
commit, source hashes, runtime hashes, settings and commands. Keep code/runtime unchanged while
a run is active. For another engine, copy `configs/` to a new directory, change only that engine's
executable/source paths, and pass `--config-dir /path/to/configs`. Overrides are recorded.

For a focused check, combine `--router fab-router --case kitspace-solenoid-driver-j1 --smoke`.
Omit `--smoke` for three repeats. `--list` prints the frozen cases. `--out NEW_DIRECTORY` chooses
the results destination; existing results are never overwritten.

Read `summary.json` first: completion/full-suite status, per-router valid runs and 3/3 task
counts, task outcomes, scores and failures with evidence pointers. `results.json` preserves
every attempt. `controls.json` identifies exact inputs, versions and settings. A complete run
may contain invalid boards; exit 0 means execution/checking completed, not that every board passed.
Setup/execution failures return 2 and retain logs. Interrupted runs remain incomplete.

Regenerate HTML from saved results without routing:

```bash
bun run benchmark:autorouter --report benchmarks/autorouter/results/RUN_TIMESTAMP
```

## Fixed contract

| Job | Cases | Required outcome |
| --- | ---: | --- |
| Whole-board route | 6 | Complete routing with placement and board truth preserved |
| Reroute after an edit | 9 | Reconnect selected nets; preserve other copper, including multiplicity |
| Power widths | 5 | Respect each declared power-net minimum width |
| Keep a ground pour | 6 | Preserve zone definitions; native refill; connected ground without islands |

All cases require zero native opens and zero new native errors, and preserved footprints,
pads, nets, outline, layers and rules. Warnings are retained. A task counts as valid only at
**3/3**. Aquarius J3 remains excluded, so this suite does not test USB coupling.

Routing is sequential, with default engine parallelism and a 60-minute safety stop per attempt.
Time includes each engine's required export, conversion, route, import and cleanup; independent
checking and final visualization rendering are separate. J2 final refill happens during checking,
as in the original comparison. Run on an otherwise idle machine for useful speed comparisons.

Ranking follows the original final study: valid tasks, then Efficient, then Fast. Per case,
use each router's medians over its three passing repeats, and score only cases where at least
two routers pass 3/3. Efficient = 50 × (best vias + 1)/(vias + 1) + 50 × best length/length;
Fast = 100 × fastest time/time. Each router's final score averages its eligible cases.
J2 vias/length include kept copper. Validity, quality and time remain separately visible.

The archived 390 baseline results reproduce the original published scores in `test_benchmark.py`.
These public development tasks are not hidden holdouts or electrical/manufacturing acceptance.
Used inputs and completed records are immutable. Version the suite rather than repairing old
evidence. `ORIGIN.json`, per-case source/license metadata and `engines.lock.json` preserve provenance.
