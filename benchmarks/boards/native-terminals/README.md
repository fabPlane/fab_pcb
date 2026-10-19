# Preserve native terminals before scoring open edges

A decrease in native open edges can come from a missing or disconnected pad. DRC
alone does not prove that a routed board still represents its input problem.
`guarded_score` compares a canonical multiset of native pad geometry and net
ownership, the net table, and enabled copper layer order/names before and after
fresh native scoring. Duplicate pads retain their multiplicity. UUIDs, net codes,
and iteration order do not participate: editor serialization and additional
tracks are supported transformations.

This standalone experiment reuses the persisted edge-baseline helper from the
native connectivity audit, included verbatim as `baseline.py` and `audit.py`.
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
