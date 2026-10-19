# Preserve native terminals before scoring open edges

A decrease in native open edges can come from a missing or disconnected pad. DRC
alone does not prove that a routed board still represents its input problem.
`guarded_score` compares a canonical multiset of native pad geometry and net
ownership, the net table, and enabled copper layer order/names before and after
fresh native scoring. Duplicate pads retain their multiplicity. UUIDs, net codes,
and iteration order do not participate: editor serialization and additional
tracks are supported transformations.

This standalone experiment reuses the persisted edge-baseline helper from the
native connectivity audit, included as `baseline.py` and `audit.py` with the report-integrity checks below.
It does not modify ranked scoring, adapters, caches, or the frozen benchmark.
The new check is a prerequisite for integrating native edge counts into those
paths. It does not establish preservation of outlines, keepouts, zones, arbitrary
footprint contents or all board settings. Custom pads and nonuniform pad stacks
fail closed until their geometry can be compared completely. Matching project,
custom-rule, input-report and checker evidence remain enforced by `baseline.py`.

Reproduce with KiCad 10's Python bindings and `kicad-cli` available:

```sh
nice -n 10 taskset -c 0-5 timeout 120 /usr/bin/python3 -m unittest discover -s benchmarks/boards/native-terminals -p 'test_*.py'
nice -n 10 taskset -c 0-5 timeout 300 /usr/bin/python3 benchmarks/boards/native-terminals/measure.py --out /tmp/native-terminals --repeats 3
```

The deterministic MIT probe generator produces three connected-net terminals,
then unchanged/partial/complete/serialized controls and seven explicit terminal
mutations. Each before attempt runs fresh native DRC through the unguarded
baseline scorer. Each after attempt uses the same board, baseline, machine and
checker, rejecting terminal mutations before running routed DRC. Raw evidence is
written only to the chosen output directory; committed results contain summaries.

For an existing original/candidate board pair with matching rules, measure
three fresh before/after repetitions (the guard must accept the pair):

```sh
nice -n 10 taskset -c 0-5 timeout 300 /usr/bin/python3 benchmarks/boards/native-terminals/measure_pair.py --original /path/to/original.kicad_pcb --candidate /path/to/candidate.kicad_pcb --out /tmp/native-preserved-pair --repeats 3
```

Open-edge records must identify distinct physical endpoints and be unique even
when endpoint order is reversed. Endpoint identity includes UUID and position:
a track may legitimately contribute more than one endpoint. Shared endpoints
across distinct edges remain valid. Duplicate or self-edge reports are rejected,
not deduplicated into an apparently valid score. Previously these records could
inflate an input baseline and imply completion on an unchanged board.

Measure report integrity on nine fresh native reports (three boards, three
repeats), comparing an earlier parser with this parser:

```sh
git show bfa6330:benchmarks/boards/native-terminals/audit.py > /tmp/native-before-audit.py
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 benchmarks/boards/native-terminals/measure_edges.py --before /tmp/native-before-audit.py --out /tmp/native-edges --repeats 3
/usr/bin/python3 benchmarks/boards/native-terminals/plot.py /tmp/native-edges/summary.csv /tmp/native-edges.png
```

The measurement injects exact/reversed duplicate and self edges into fresh reports;
these are parser counterexamples, not outputs observed from the native checker.
Ranked adapters remain unchanged.
