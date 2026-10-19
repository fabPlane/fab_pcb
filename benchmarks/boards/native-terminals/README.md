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

## Offline command integration

# Offline native router command runner

`route.py` captures native input evidence **before** launching an offline router,
then scores its fresh native output against the original open-edge count. The
router command receives literal `{input}` and `{output}` placeholders, runs in a
new artifact directory, and must perform any session import itself. No shell is
used. The router and its subprocesses share a bounded process group.

```sh
/usr/bin/python3 benchmarks/boards/native-terminals/route.py \
  --input /path/to/unrouted.kicad_pcb --out /tmp/native-run-001 --timeout 60 \
  -- /path/to/offline-wrapper '{input}' '{output}'
```

The output directory must not exist. It contains a private input and its project
and custom-rule sidecars, `baseline.json`, fresh input/output native JSON reports,
router stdout/stderr, the candidate board and `result.json`. A nonzero exit,
timeout, missing output, aliased board, changed input, rules, checker or terminal
geometry yields unavailable quality and a nonzero CLI exit. Failed partial output
is retained for diagnosis. There is no cache or net-count fallback. The timeout
covers the router command (including wrapper export/import); native DRC has a
separate 60-second deadline per check. Commands must not detach from their process
group. Commands are trusted local programs, not sandboxed code.

Importers must preserve project/custom-rule bytes, including absence. The runner
does not repair changed output rules to make validation pass. Terminal checking
preserves pad geometry/net/reference/number multiplicity, net names and enabled
copper stack. It ignores UUIDs and ordering. Custom pads and nonuniform pad stacks
fail closed. It does not prove preservation of outlines, keepouts, zones, arbitrary
footprint contents or all board settings.

This is an opt-in offline command path. Existing ranked adapters, cache keys and
frozen benchmark scoring remain unchanged. It reuses the MIT native baseline and
terminal helpers from the earlier audit; connecting all ranked adapters is still
required before dense native boards enter ranked suites.

Requires KiCad 10 `pcbnew` Python bindings, `kicad-cli` and Linux process groups.
Check correctness and reproduce the command-boundary measurement:

```sh
nice -n 10 taskset -c 0-5 timeout 240 /usr/bin/python3 -m unittest discover -s benchmarks/boards/native-terminals -p 'test_*.py'
nice -n 10 taskset -c 0-5 timeout 300 /usr/bin/python3 benchmarks/boards/native-terminals/measure_route.py --out /tmp/native-command-controls --repeats 3
/usr/bin/python3 benchmarks/boards/native-terminals/plot.py /tmp/native-command-controls/summary.csv /tmp/native-command-controls.png
```

The measurement uses deterministic command controls on one three-terminal net.
Its explicit unguarded countermodel reuses a prior output and ignores command
failure and input preservation. It is **not** a measurement of an existing router
or a claim that ranked adapters exhibit these failures. Valid unchanged/partial/
complete controls must retain 0%/50%/100% completion. Five invalid command outcomes
must return unavailable quality. Three repetitions run on the same machine and
native checker. Raw evidence stays in the selected output directory.

For a router accepting DSN input and writing SES, `session_command.py` exports
and imports through native bindings and restores the original rule sidecars after
Save. Invoke it through `route.py`; its engine process inherits the outer deadline:

```sh
/usr/bin/python3 benchmarks/boards/native-terminals/route.py \
  --input /path/to/unrouted.kicad_pcb --out /tmp/native-session-001 --timeout 60 \
  -- /usr/bin/python3 "$PWD/benchmarks/boards/native-terminals/session_command.py" \
  '{input}' '{output}' -- /path/to/engine -de '{dsn}' -do '{session}'
```

Engine option names are supplied by the caller. `session_command.py` requires a
successful process exit, fresh session and successful native import. It is an
example offline wrapper, independent of the existing adapters.

Compare a real DSN/SES command directly and through the runner (three fresh
repetitions of the same three-terminal fixture, with native DRC on both outputs):

```sh
nice -n 10 taskset -c 0-5 timeout 240 /usr/bin/python3 benchmarks/boards/native-terminals/measure_session.py \
  --out /tmp/native-session-pairs --repeats 3 -- \
  /usr/lib/jvm/java-25-openjdk-amd64/bin/java -XX:ActiveProcessorCount=6 \
  -jar "$HOME/bench/repos/fab_pcb/benchmarks/autorouter/runtime/c/freerouting-2.5.0.jar" \
  -de '{dsn}' -do '{session}'
```

Adjust executable/archive paths for the local installation. This verifies
completion/error parity; wall times are not compared. On the measured machine,
the three pairs each retained 100% completion, zero opens and zero geometric
errors. Other native transformations and routers are not established by this
small control.
