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
nice -n 10 taskset -c 0-5 timeout 240 /usr/bin/python3 -m unittest discover -s scripts/native-terminals -p 'test_*.py'
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

Each runner directory now also contains `baseline-archive/`: byte copies of the
original board, present rule sidecars and original native report, plus the
verbatim baseline in `archive.json`. You can move this directory without keeping
the original absolute input paths. The checker stays external at its original
path and must retain the same digest; relocating or upgrading the checker is not
supported. No checker executable is bundled.

To archive an existing verified baseline:

```sh
/usr/bin/python3 benchmarks/boards/native-terminals/archive.py \
  --baseline /path/to/run/baseline.json --out /tmp/fresh-baseline-archive
```

From Python, `archive.load('/path/to/moved/archive')` verifies the copied bytes,
counts and current checker, then returns a baseline usable by
`terminals.guarded_score`. It remaps only the three known input paths and report;
it never follows the original input paths. Missing sidecars must remain absent.
Symbolic links in the archive root, manifest, input directory and evidence files
are rejected. The original baseline ID remains in the manifest; relocation
creates a **new path-bound baseline ID**. This is an integrity/provenance check,
not a signature or an authentication boundary. The manifest must come from a
trusted run. Cached scores and relocated output reports are not accepted by this
helper: score the candidate with fresh DRC. Ranked cache integration remains
pending.

Measure relocation with three-terminal unchanged/partial/complete controls and,
optionally, the existing 439-edge dense fixture. Each pair scores before and after
moving its archive and deleting the original private input directory:

```sh
nice -n 10 taskset -c 0-5 timeout 300 /usr/bin/python3 benchmarks/boards/native-terminals/measure_archive.py \
  --out /tmp/native-archive-pairs --repeats 3 \
  --dense "$HOME/bench/boards/dense/dense6-bga324.kicad_pcb"
```

The dense fixture is supplied by the caller; it is not generated or changed here.
The measurement preserves 0%/50%/100% three-terminal completion and the dense
439-open denominator, zero geometric errors and 30 library warnings. This is
evidence relocation, not a routing or speed improvement.

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
