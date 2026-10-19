# Dense six-layer connection-edge fixture

MIT deterministic seed-6406 input: 70 × 56 mm, six signal copper layers, 263 nets,
702 pads, 439 initial native open edges. Components include 0.8 mm BGA324/BGA96,
0.5 mm QFN64, 0.4 mm QFN48 and two 0.5 mm two-row connectors. Source project rules
use 0.1 mm minimum track width and clearance. There are no planes or pair/length
constraints. This preserves the existing shared dense generator rather than
creating another dense board.

This fixture is outside the frozen autorouter benchmark. It is a standalone input
and connectivity audit; it is not added to ranked suites while the harness still
uses net count as its native completion denominator. There is no routing or
speed improvement claim. The adapter/cache metadata integration remains follow-up
work.

```sh
python3 benchmarks/boards/dense6/generate.py /tmp/dense6-generated
/usr/bin/python3 benchmarks/boards/dense6/export.py \
  /tmp/dense6-generated/dense6-bga324.kicad_pcb /tmp/dense6-generated/dense6-bga324.dsn
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover \
  -s benchmarks/boards/dense6/tools -p 'test_*.py'
nice -n 10 taskset -c 0-5 timeout 1800 env PYTHONDONTWRITEBYTECODE=1 \
  /usr/bin/python3 benchmarks/boards/dense6/validate.py --out /tmp/dense6-validation
python3 benchmarks/boards/dense6/tools/plot.py \
  /tmp/dense6-validation/bundled/summary.csv /tmp/dense6-completion.png
```

Requires KiCad CLI and Python `pcbnew` (measured with 10.0.6), plus `rsvg-convert`
for charts. `validate.py` checks pinned original/generated hashes, geometry and
rule identity, then audits bundled and regenerated inputs with three repeats.
Each side runs 18 native checks and produces 30 formula comparisons. All native
probe routes have zero DRC errors. Dense6 has zero DRC errors, 439 open edges and
30 missing-library warnings, preserved in the results. No source rule is relaxed.

The original generator emits byte-stable raw board text. The bundled shared board
was saved by the native editor, so its serialization and automatically generated
non-copper property UUIDs differ. Both hashes are pinned separately. The validator
compares all 702 loaded pad positions, sizes, shapes, layers and net ownership;
project rules are byte-identical. DSN exports can reorder component/image blocks
when the board serialization changes; they are not asserted byte-identical.

For a three-terminal net, two initial native open edges and one remaining edge
mean 50% completion. The net-count formula incorrectly reports 0%. Preconnected
inputs use their actual remaining edges as the baseline; zero initial opens
produce 100% only when no output opens exist. This connectivity fraction says
nothing about clearance validity, which stays a separate native result.

`tools/audit.py` uses fresh native reports, verifies source/severities/sections,
records board/project/custom-rule/executable digests, detects mutation during DRC,
and rejects missing reports or failed checks. Each native command has a 60-second
deadline. It is evidence tooling, not a replacement for production scoring.

To render the input:

```sh
kicad-cli pcb export svg --mode-single --layers F.Cu,B.Cu,Edge.Cuts \
  --page-size-mode 2 --exclude-drawing-sheet --output /tmp/dense6.svg \
  benchmarks/boards/dense6/dense6-bga324.kicad_pcb
rsvg-convert -w 1600 /tmp/dense6.svg -o /tmp/dense6.png
```

Replay the three-repeat failed-export comparison from the published prior exporter:

```sh
git show 2cdd154:benchmarks/boards/dense6/export.py > /tmp/dense6-export-before.py
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 benchmarks/boards/dense6/tools/measure_export_freshness.py \
  --before /tmp/dense6-export-before.py --out /tmp/dense6-export-freshness.csv
```

The evidence CSV records both script digests. Failed board loads retain old DSNs
3/3 before and 0/3 after. The exporter also rejects a source/destination alias
while preserving the input, covered by its regression test.


Report destination safety (cycle 27): the native checker rejects direct,
symlink and hard-link aliases of the board, project/custom rules or checker
executable before deleting stale output or launching the checker. In 36
same-machine disposable-file cases (four protected paths × three alias types ×
three repeats), all inputs survived 12/36 before and 36/36 after. Alias rejection
before launch improved 0/36 to 36/36. A separate valid-output-path regression
still requires failed checks to remove stale reports. No input rules or ranked
scoring changed.

```sh
git show 76b4637:benchmarks/boards/dense6/tools/audit.py > /tmp/native-output-before.py
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/boards/dense6/tools/measure_output_safety.py --audit /tmp/native-output-before.py --out /tmp/native-output-before.csv
PYTHONDONTWRITEBYTECODE=1 python3 benchmarks/boards/dense6/tools/measure_output_safety.py --out /tmp/native-output-after.csv
python3 benchmarks/boards/dense6/tools/plot_output_safety.py /tmp/native-output-before.csv /tmp/native-output-after.csv /tmp/native-output-safety.png
```
