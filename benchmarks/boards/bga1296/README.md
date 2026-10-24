# Eight-layer 1,296-net BGA keepout candidate

Original MIT fixture, seed 6596. A 36 × 36 BGA at 0.5 mm pitch drives
1,296 shuffled two-terminal nets to four destination banks (2,592 pads total).
The 90 × 90 mm board has eight signal copper layers, 0.10/0.10 mm track/clearance
and 0.30/0.10 mm through vias. Two 3 × 28 mm routing keepouts at x=29–32 and
x=58–61, y=31–59 forbid tracks and vias on every copper layer. Routes can pass
around their ends. This increases input size and adds constraints relative to
the earlier 1,024-net candidate; relative routing difficulty is not established.

The companion project is required. No planes, differential pairs, matched
lengths, footprint libraries or external board sources are used. The generator
loads the board, checks net ownership, stack, effective rules, rule-area masks,
and native connectivity, then runs a fresh native DRC. It also requires all 16
keepout polygons in the exported DSN, with exact micrometre coordinates,
layer multiplicity, zero aperture, and closed rectangular vertex sequences.
This fixture-specific check intentionally rejects alternate export grammars. Board, project and DSN are deterministic
across output directories.

KiCad 10.0.6 reports 1,296 native connectivity opens but caps the DRC JSON at
499 unconnected findings. The zero geometry errors and warnings admit the input;
the capped report does not establish exact routed opens or native completion.
There is no best-known complete, DRC-clean routing yet. Keep this board outside
the frozen suite and do not promote it to a feasible scored tier.

## Generate and verify

Requires `/usr/bin/python3` with `pcbnew`, and `kicad-cli` 10.0.6. Use a fresh output
directory. No network access is needed.

```sh
nice -n 10 taskset -c 0-5 timeout 150 /usr/bin/python3 -O benchmarks/boards/bga1296/generate.py /tmp/bga1296-new --seed 6596
nice -n 10 taskset -c 0-5 timeout 180 /usr/bin/python3 -O -m unittest discover -s benchmarks/boards/bga1296 -p 'test_*.py'
```

The measurement compares the same placement, nets, seed and rules with and
without the two keepouts, three fresh runs per router and variant. Full-corpus
measurements preserve the existing five bundled suites. See the PR assets for
exact source pins, results and limitations. Native baseline denominator adoption
remains pending; this fixture does not change scoring or ranking.
