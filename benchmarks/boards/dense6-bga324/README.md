# dense6-bga324 — dense 6-layer BGA/QFN fanout stress board

A synthetic, deterministic **candidate** board for stressing autorouters well beyond the frozen 26-case suite in
`benchmarks/autorouter/` (which it does not modify). It is not part of the scored suite; see
[Promotion gate](#promotion-gate) below.

| Property                  | Value                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outline                   | 70 x 56 mm rectangle                                                                                                                                                                                   |
| Copper                    | 6 layers (F.Cu, In1-In4, B.Cu), all signal; no planes — power/ground are routed as nets                                                                                                                |
| Connections               | **439** (263 nets: 260 two-pin signals + GND 102 pins, VCCIO 54 pins, VCC_CORE 26 pins)                                                                                                                |
| Pads / footprints         | 702 / 30                                                                                                                                                                                               |
| Parts                     | U1 324-ball BGA, 0.8 mm pitch (18x18, power in the centre 8x8); U2 96-ball memory BGA, 0.8 mm; U3 QFN-64 0.5 mm; U4 QFN-48 0.4 mm; J1/J2 2x30 0.5 mm board-to-board; 24x 0402 decoupling on the bottom |
| Rules                     | 0.1 mm track, 0.1 mm clearance, through via 0.45/0.2 mm, copper-to-edge 0.3 mm — **stored in `.kicad_pro`**                                                                                            |
| Native DRC (KiCad 10.0.6) | 0 errors, 439 unconnected, 30 `lib_footprint_issues` warnings (generated footprints have no library)                                                                                                   |

Signal nets are assigned to BGA balls by direction toward their destination, with a bounded local shuffle
(windows of 4) so that pin order is realistic but imperfect and some crossings are needed. The difficulty is
concentrated under and around U1 (minimum pad-to-edge distance is 3.8 mm, so the perimeter is mostly free); this is a
fanout/escape stress board rather than a uniformly dense one.

## Read this before using the board elsewhere

- **The rules live in the `.kicad_pro`, not in the `.kicad_pcb`.** Open or convert `dense6-bga324.kicad_pcb` together
  with `dense6-bga324.kicad_pro` (or use `case/board.*`). Opened on its own, KiCad falls back to its defaults
  (0.2 mm track / 0.2 mm clearance), which is a materially different (easier) problem. The `.dsn` carries the
  0.1/0.1 mm rules and the 0.45/0.2 mm via.
- **Footprints are pads only** (no courtyard, silkscreen or fabrication outlines). "0 DRC errors" therefore means no
  copper/clearance/edge errors on the unrouted board; courtyard overlap is not checked (`missing_courtyard` is an
  ignored check).

## Analytical margins (why it is hard)

| Constraint                                            | Available     | Needed                     | Spare                                                |
| ----------------------------------------------------- | ------------- | -------------------------- | ---------------------------------------------------- |
| Channel between adjacent 0.45 mm vias at 0.8 mm pitch | 0.35 mm       | 0.30 mm (one 0.1 mm track) | 50 µm                                                |
| Dog-bone via centre to ball centre (diagonal)         | 0.566 mm      | 0.525 mm                   | 41 µm                                                |
| Per-pin vias at the 0.4 mm QFN-48                     | 0.40 mm pitch | 0.55 mm                    | none — must stagger or escape on the top layer first |

Exactly one track fits per BGA channel, so escaping the outer rings of the 324-ball array on six layers is close to
the analytical limit.

## Promotion gate

Before this board is promoted into a scored suite (`role: "scored"`), record in this README a **best-known
solution**: a complete route that passes native KiCad DRC under these exact rules, produced by any reference engine
or by hand (at least one quadrant hand-routed if no engine completes it), with the tool/version and DRC report. Until
then a low completion rate cannot distinguish a weak router from an infeasible board.

Current best known result: fab_router `69cf598`, 101 / 439 connections, 0 new native DRC errors (1 seed). Not a
proof of routability.

## Files

- `dense6-bga324.kicad_pcb` / `.kicad_pro` — the board and its rules.
- `dense6-bga324.dsn` — Specctra DSN exported by KiCad 10.0.6 (`export_dsn.py`).
- `case/` — the same board in the `benchmarks/autorouter/cases/*` fixture layout (`board.*`, `baseline-drc.json`,
  `job.json` as job J1, `LICENSE`); `job.json` records the seed and the generator's sha256.
- `gen_dense6.py` (seed 6406), `make_case.py`, `export_dsn.py`, `project-template.kicad_pro` — generator, packaging
  scripts and the vendored KiCad project template.

## Regenerate

```
python3 gen_dense6.py /tmp/d6/gen --seed 6406
/usr/bin/python3 make_case.py /tmp/d6/gen/dense6-bga324.kicad_pcb /tmp/d6/out dense6-bga324 6406
```

Geometry, nets, rules and the DSN match the committed files. Expect `job.json` `utc` and the sha256 of
`board.kicad_pcb` / `baseline-drc.json` to differ (UUIDs KiCad assigns to default footprint fields when saving, and
the DRC report date). `job.json` uses `role: "tuning"` until the promotion gate above is met.

## Run it in the harness (private copy; the frozen suite stays untouched)

Copy `benchmarks/autorouter` elsewhere, copy `case/` to `cases/dense6-bga324-j1`, append a matching entry to that
copy's `suite.json` and update its `inputs.sha256.json` entry for `suite.json`, then
`python3 benchmark.py --smoke --case dense6-bga324-j1 --router fab-router --out results/dense6`.

Licence: MIT (see `LICENSE`), covering the generator, scripts and generated board files.
