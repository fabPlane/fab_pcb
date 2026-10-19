# Component-anchor recovery results

All frozen measurements use the same 26 cases × three repeats, native 10.0.6 checker, host and cores 12–19. Both modes enable the actual public `localRecovery` setting. Before source matches the previous consumer pin; only two engine modules change. Tests and stress jobs overlap the sequential sweeps. Times are descriptive; no causal speed improvement is claimed.

| Native mode | Passed /78 | Valid /26 | Opens | Known new errors | Median / p95 s | Total s | Vias | Length sum mm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Previous enabled | 39 | 13 | 99 | 27 | 1.471844 / 22.507827 | 501.342753 | 2826 | 60080.812022 |
| Component anchors enabled | 42 | 14 | 96 | 27 | 1.183059 / 17.678827 | 432.459169 | 2826 | 60129.943370 |

Exactly 75/78 session files are identical. Only the three power-supply J4 sessions change: each closes its final GNDA connection with no added vias, 16.377116 mm of full-width track, and zero new native errors. Existing 27 native thermal errors remain unresolved; the whole suite is not DRC clean. Structured error multiplicity, warning geometry and fidelity are compared per attempt; there are zero regressions.

## Every frozen case

Three repeats per cell; p95 of three observations is their maximum. Opens, errors, vias and lengths below are totals across the same three attempts.

| Case | Passed before→after /3 | Opens | Errors | Vias | Length sum mm | Median s before→after | p95 s before→after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fan-controller-fan-controller-j1 | 0→0 | 12→12 | 0→0 | 306→306 | 2883.013→2883.013 | 6.092953→4.825654 | 6.328155→4.914819 |
| fan-controller-fan-controller-j2-large | 3→3 | 0→0 | 0→0 | 78→78 | 1685.579→1685.579 | 1.046957→0.840791 | 1.108417→0.852256 |
| fan-controller-fan-controller-j2-medium | 3→3 | 0→0 | 0→0 | 81→81 | 1595.992→1595.992 | 1.095028→0.727465 | 1.208094→0.752109 |
| fan-controller-fan-controller-j2-small | 0→0 | 3→3 | 0→0 | 66→66 | 1486.700→1486.700 | 4.977486→3.921759 | 5.182980→5.867422 |
| hellscribe-hellscribe-j1 | 0→0 | 9→9 | 0→0 | 300→300 | 3947.358→3947.358 | 5.086339→3.877764 | 5.092893→4.134860 |
| hellscribe-hellscribe-j2-large | 0→0 | 3→3 | 0→0 | 333→333 | 4107.846→4107.846 | 1.290657→0.980467 | 1.447569→0.992680 |
| kitspace-aquarius-j4 | 0→0 | 45→45 | 18→18 | 390→390 | 5193.339→5193.339 | 62.503945→51.178447 | 66.148324→67.613930 |
| kitspace-lcr-addon-j3 | 3→3 | 0→0 | 0→0 | 120→120 | 2536.458→2536.458 | 2.564209→2.045754 | 3.192429→2.145253 |
| kitspace-solenoid-driver-j1 | 3→3 | 0→0 | 0→0 | 36→36 | 1058.072→1058.072 | 0.905826→0.722033 | 0.906569→0.856496 |
| kitspace-solenoid-driver-j3 | 3→3 | 0→0 | 0→0 | 36→36 | 1062.529→1062.529 | 0.958785→0.731139 | 0.996772→0.731222 |
| kitspace-solenoid-driver-j4 | 3→3 | 0→0 | 0→0 | 27→27 | 719.054→719.054 | 1.054340→0.720507 | 1.070036→0.736413 |
| nextbusclock-nextbusclockv1-j2-large | 3→3 | 0→0 | 0→0 | 123→123 | 4566.178→4566.178 | 3.782627→3.090175 | 4.004793→3.370338 |
| nextbusclock-nextbusclockv1-j2-medium | 3→3 | 0→0 | 0→0 | 3→3 | 4452.316→4452.316 | 1.203387→0.993149 | 1.206707→1.041998 |
| nextbusclock-nextbusclockv1-j2-small | 3→3 | 0→0 | 0→0 | 6→6 | 4494.818→4494.818 | 0.908821→0.729829 | 0.989080→0.741153 |
| nextbusclock-nextbusclockv1-j3 | 0→0 | 3→3 | 0→0 | 195→195 | 4685.449→4685.449 | 10.790172→9.625869 | 11.123241→9.786461 |
| paperino-hw-paperino-shield-j4 | 0→0 | 12→12 | 0→0 | 3→3 | 845.376→845.376 | 21.244864→16.264600 | 22.507827→17.024562 |
| photon-sprinkler-sprinkler-j1 | 0→0 | 3→3 | 0→0 | 36→36 | 1948.735→1948.735 | 14.190120→12.263156 | 14.608742→12.966254 |
| photon-sprinkler-sprinkler-j3 | 0→0 | 3→3 | 0→0 | 36→36 | 1960.058→1960.058 | 18.676320→15.250993 | 18.743769→17.678827 |
| qrpcard-qrpcard-j1 | 3→3 | 0→0 | 0→0 | 177→177 | 2484.703→2484.703 | 1.638696→1.390823 | 1.650476→1.415257 |
| qrpcard-qrpcard-j2-medium | 3→3 | 0→0 | 0→0 | 60→60 | 1418.744→1418.744 | 0.915116→0.865754 | 1.046794→0.911727 |
| qrpcard-qrpcard-j2-small | 0→0 | 0→0 | 6→6 | 51→51 | 1441.299→1441.299 | 0.802687→0.731811 | 0.924626→0.781233 |
| qrpcard-qrpcard-j4 | 0→0 | 0→0 | 3→3 | 114→114 | 1569.597→1569.597 | 1.319693→0.993454 | 1.404927→1.275383 |
| rufs-smart-psu-j1 | 3→3 | 0→0 | 0→0 | 81→81 | 1162.303→1162.303 | 0.926084→0.726964 | 0.978711→0.882762 |
| rufs-smart-psu-j3 | 0→0 | 3→3 | 0→0 | 78→78 | 1137.054→1137.054 | 2.279836→2.052185 | 2.388199→2.062071 |
| rufs-smart-psu-j4 | 0→3 | 3→0 | 0→0 | 48→48 | 966.021→1015.152 | 1.627598→1.259050 | 1.632471→1.262091 |
| sv650sds-sds-tool-j4 | 3→3 | 0→0 | 0→0 | 42→42 | 672.225→672.225 | 1.062218→0.863648 | 1.121217→0.894395 |

## Larger inputs

One exploratory pair per supplied DSN, with two normal passes, 600-second route budget, strict DRC, optimiser/fanout disabled and neck width zero. These are engine checks, not native scores or three-repeat timing studies. All three inputs have zero imported pours; every paired session and complete statistics object is identical.

| Input | Incomplete before→after | Exact added / total | Vias | Length mm | Seconds before→after |
| --- | ---: | ---: | ---: | ---: | ---: |
| dense6-bga324.dsn | 190→190 | 0 / 0 | 266 | 2032.379268 | 198.731188→195.791106 |
| l2-cycle18.dsn | 21→21 | 0 / 0 | 51 | 1094.342601 | 27.742361→26.572265 |
| l3-cycle18.dsn | 153→153 | 0 / 0 | 93 | 1688.604896 | 227.223600→230.887597 |

Prepared Dense6 native export is separate from the supplied DSN above: three repeats/source, same two-pass/600-second budgets.

| Prepared Dense6 native | Passed /3 | Opens per repeat | New errors per repeat | Vias per repeat | Length mm per repeat | Median / p95 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before | 0 | [181, 181, 181] | [0, 0, 0] | [315, 315, 315] | [2317.561458085628, 2317.561458085628, 2317.561458085628] | 211.024244 / 222.994161 |
| After | 0 | [181, 181, 181] | [0, 0, 0] | [315, 315, 315] | [2317.561458085628, 2317.561458085628, 2317.561458085628] | 212.790283 / 213.122907 |

All prepared Dense6 session hashes match; zero introduced findings, warning geometry or fidelity differences. This board remains incomplete, with 181 opens in every repeat. Native prepared input also imports zero pours; this is a nonregression control, not a second pour-recovery gain.

## Slow acceptance

One current evaluation per unchanged slow case, recovery enabled. Comparison is against the historical enabled sweep; original timed budgets and expectations are retained. These runs cannot establish causal timing or all-input nonregression.

| Mode | Passed /63 | Failed | Advisory | Stubs | Sum seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 51 | 12 | 14 | 0 | 2482.057464 |
| After | 51 | 12 | 14 | 0 | 2436.360872 |

Observed adverse per-case differences: 1. Every difference, including timed adverse outcomes, remains in slow-comparison.json. These observations do not justify default promotion.
- `routing-slow-issue230-cnh-plane-layers`: `{"addedBarrels": {"after": 181, "before": 185}, "addedTracks": {"after": 316, "before": 325}, "barrels": {"after": 181, "before": 185}, "completed": {"after": 199, "before": 206}, "incomplete": {"after": 19, "before": 17}, "passes": {"after": 8, "before": 9}, "traceLengthMm": {"after": 4657.9703453457505, "before": 4658.291082960436}, "vias": {"after": 181, "before": 185}, "wallClockMs": {"after": 300048, "before": 300050}}`

The final larger and custom native Dense6 driver tool sessions returned 143 after all six case records were written. All per-case native steps exit zero without timeouts; outputs/statistics/source hashes are audited. A successful whole-driver exit is not claimed; see supervisor-observations.json.

## Additional retained evidence

The preliminary native three-repeat J4 subset and first candidate full sweep are retained separately. The first candidate validated alternate anchors rather than the original terminal pair; the final scheduler strengthens that acceptance gate. Neither preliminary execution is relabelled as the final source. Earlier larger-input pairs are also retained separately. See source-audit.json and the frozen hashes for source identity.

The real residual is replayed three times/source with all retained copper unchanged: before 1 open each, after 0 each; exact violations zero throughout, deterministic sessions. The final search uses 3,129 charged work units and closes at margin 4. Seven targeted tests are repeated three times/source: before 2 pass /5 fail, after 7 pass /0 fail. They include both endpoint orientations, isolated copper in a pour hole, sheet incompatibility, a barrel component anchor, rejection of wrong-component anchors, and rollback when an alternate anchor loses its original pour connection.

No new CPU profile is claimed. The profile summary for this change is the recorded recovery work: no normal-pass search changes; a previously unsupported target reaches the existing bounded visibility graph. Full widths, clearances, via sizes, lattice and scheduler budgets remain unchanged. Direct pour contacts, pour-to-pour search, general relaxation and default promotion remain unfinished.
