# dense6-bga324 — dense 6-layer BGA/QFN fanout stress board

A synthetic, deterministic board for stressing autorouters well beyond the frozen 26-case suite in
`benchmarks/autorouter/` (which it does not modify). It is meant as a candidate case for the next benchmark
round and as a shareable test board.

| Property                  | Value                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outline                   | 70 x 56 mm rectangle                                                                                                                                                                                   |
| Copper                    | 6 layers (F.Cu, In1-In4, B.Cu), all signal; no planes — power/ground are routed as nets                                                                                                                |
| Connections               | **439** (263 nets: 260 two-pin signals + GND 102 pins, VCCIO 54 pins, VCC_CORE 26 pins)                                                                                                                |
| Pads / footprints         | 702 / 30                                                                                                                                                                                               |
| Parts                     | U1 324-ball BGA, 0.8 mm pitch (18x18, power in the centre 8x8); U2 96-ball memory BGA, 0.8 mm; U3 QFN-64 0.5 mm; U4 QFN-48 0.4 mm; J1/J2 2x30 0.5 mm board-to-board; 24x 0402 decoupling on the bottom |
| Rules                     | 0.1 mm track, 0.1 mm clearance, through via 0.45/0.2 mm, copper-to-edge 0.3 mm (in `.kicad_pro`)                                                                                                       |
| Native DRC (KiCad 10.0.6) | 0 errors, 439 unconnected, 30 `lib_footprint_issues` warnings (generated footprints have no library)                                                                                                   |

Signal nets are assigned to BGA balls by direction toward their destination, with a bounded local shuffle
(windows of 4) so that pin order is realistic but imperfect and some crossings are needed.

## Files

- `dense6-bga324.kicad_pcb` / `.kicad_pro` — the board and its rules.
- `dense6-bga324.dsn` — Specctra DSN exported by KiCad 10.0.6 (`export_dsn.py`), carrying the 0.1/0.1 mm rules.
- `case/` — the same board in the `benchmarks/autorouter/cases/*` fixture layout (`board.*`, `baseline-drc.json`,
  `job.json` as job J1), so it can be dropped into a private copy of the harness.
- `gen_dense6.py` (seed 6406), `make_case.py`, `export_dsn.py` — the generator and packaging scripts.

## Regenerate

```
python3 gen_dense6.py /tmp/d6/gen
/usr/bin/python3 make_case.py /tmp/d6/gen/dense6-bga324.kicad_pcb /tmp/d6/out dense6-bga324
```

Output matches the committed files except for UUIDs that KiCad assigns to default footprint fields when saving
(and the DRC report date); geometry, nets, rules and the DSN are byte-identical.

## Run it in the harness (private copy; the frozen suite stays untouched)

Copy `benchmarks/autorouter` elsewhere, copy `case/` to `cases/dense6-bga324-j1`, append a matching entry to that
copy's `suite.json` and update its `inputs.sha256.json` entry for `suite.json`, then
`python3 benchmark.py --smoke --case dense6-bga324-j1 --router fab-router --out results/dense6`.

Licence: MIT (generator and generated board files).
