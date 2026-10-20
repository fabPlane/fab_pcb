# Fresh paired native measurements

Same 26 frozen cases, three repeats per source, host and cores 12–19. Recovery enabled in both modes. Before source: `4b577bb` (runtime identical to the prior consumer pin `c9f946d`); after source: `8e53e7d`. Concurrent acceptance/stress/unit jobs and sequential sweep order prevent a causal speed claim.

| Native mode                    | Passed /78 | Valid /26 | Opens | Known new errors |       Median / p95 s |    Total s | Vias | Length sum mm |
| ------------------------------ | ---------: | --------: | ----: | ---------------: | -------------------: | ---------: | ---: | ------------: |
| Original point pair            |         42 |        14 |    96 |               27 | 1.329552 / 19.184059 | 458.374824 | 2826 |  60129.943370 |
| Bounded component alternatives |         48 |        16 |    90 |               27 | 1.386415 / 21.092039 | 484.539243 | 2826 |  60450.378202 |

Unchanged sessions: 72/78. Structured-error, warning-geometry, fidelity and completion regressions: 0. Existing errors remain unresolved; the suite is not DRC clean.

Three repeats per case. p95 for three observations is their maximum; opens/errors/vias/length are totals over the same three attempts.

| Case                                    | Passed before→after /3 | Opens | Errors |    Vias |     Length sum mm | Median s before→after |  p95 s before→after |
| --------------------------------------- | ---------------------: | ----: | -----: | ------: | ----------------: | --------------------: | ------------------: |
| fan-controller-fan-controller-j1        |                    0→0 | 12→12 |    0→0 | 306→306 | 2883.013→2883.013 |     5.713657→5.538798 |   5.964621→6.162119 |
| fan-controller-fan-controller-j2-large  |                    3→3 |   0→0 |    0→0 |   78→78 | 1685.579→1685.579 |     0.890519→0.916463 |   0.899771→0.925835 |
| fan-controller-fan-controller-j2-medium |                    3→3 |   0→0 |    0→0 |   81→81 | 1595.992→1595.992 |     0.762133→0.897600 |   0.877252→0.907624 |
| fan-controller-fan-controller-j2-small  |                    0→0 |   3→3 |    0→0 |   66→66 | 1486.700→1486.700 |     4.487530→5.133559 |   4.582416→5.167459 |
| hellscribe-hellscribe-j1                |                    0→0 |   9→9 |    0→0 | 300→300 | 3947.358→3947.358 |     4.015496→4.721006 |   4.128268→4.959883 |
| hellscribe-hellscribe-j2-large          |                    0→0 |   3→3 |    0→0 | 333→333 | 4107.846→4107.846 |     1.021369→1.128514 |   1.051804→1.374700 |
| kitspace-aquarius-j4                    |                    0→0 | 45→45 |  18→18 | 390→390 | 5193.339→5193.339 |   59.434455→64.543824 | 61.704851→65.620307 |
| kitspace-lcr-addon-j3                   |                    3→3 |   0→0 |    0→0 | 120→120 | 2536.458→2536.458 |     2.313750→2.349784 |   2.388914→2.350928 |
| kitspace-solenoid-driver-j1             |                    3→3 |   0→0 |    0→0 |   36→36 | 1058.072→1058.072 |     0.738252→0.893580 |   1.033541→0.894130 |
| kitspace-solenoid-driver-j3             |                    3→3 |   0→0 |    0→0 |   36→36 | 1062.529→1062.529 |     0.885261→0.747944 |   0.904290→0.948731 |
| kitspace-solenoid-driver-j4             |                    3→3 |   0→0 |    0→0 |   27→27 |   719.054→719.054 |     0.766531→0.741407 |   0.884638→1.037630 |
| nextbusclock-nextbusclockv1-j2-large    |                    3→3 |   0→0 |    0→0 | 123→123 | 4566.178→4566.178 |     3.394206→3.554464 |   3.733007→3.643050 |
| nextbusclock-nextbusclockv1-j2-medium   |                    3→3 |   0→0 |    0→0 |     3→3 | 4452.316→4452.316 |     1.004171→1.013245 |   1.158553→1.024465 |
| nextbusclock-nextbusclockv1-j2-small    |                    3→3 |   0→0 |    0→0 |     6→6 | 4494.818→4494.818 |     0.753988→0.910665 |   0.876379→0.920120 |
| nextbusclock-nextbusclockv1-j3          |                    0→0 |   3→3 |    0→0 | 195→195 | 4685.449→4685.449 |    9.469286→10.187023 | 10.751269→10.711069 |
| paperino-hw-paperino-shield-j4          |                    0→0 | 12→12 |    0→0 |     3→3 |   845.376→845.376 |   17.819722→20.870109 | 19.184059→21.092039 |
| photon-sprinkler-sprinkler-j1           |                    0→3 |   3→0 |    0→0 |   36→36 | 1948.735→2108.952 |   13.209095→13.367877 | 14.199350→13.953761 |
| photon-sprinkler-sprinkler-j3           |                    0→3 |   3→0 |    0→0 |   36→36 | 1960.058→2120.275 |   16.241304→17.907883 | 16.541453→18.576084 |
| qrpcard-qrpcard-j1                      |                    3→3 |   0→0 |    0→0 | 177→177 | 2484.703→2484.703 |     1.594156→1.574645 |   1.715808→1.746196 |
| qrpcard-qrpcard-j2-medium               |                    3→3 |   0→0 |    0→0 |   60→60 | 1418.744→1418.744 |     0.876814→0.906825 |   0.882648→0.907393 |
| qrpcard-qrpcard-j2-small                |                    0→0 |   0→0 |    6→6 |   51→51 | 1441.299→1441.299 |     0.777624→0.749990 |   0.788945→0.893402 |
| qrpcard-qrpcard-j4                      |                    0→0 |   0→0 |    3→3 | 114→114 | 1569.597→1569.597 |     1.128243→1.155325 |   1.248444→1.182077 |
| rufs-smart-psu-j1                       |                    3→3 |   0→0 |    0→0 |   81→81 | 1162.303→1162.303 |     0.758684→0.914776 |   0.884560→0.916733 |
| rufs-smart-psu-j3                       |                    0→0 |   3→3 |    0→0 |   78→78 | 1137.054→1137.054 |     2.043160→2.449266 |   2.111911→2.612403 |
| rufs-smart-psu-j4                       |                    3→3 |   0→0 |    0→0 |   48→48 | 1015.152→1015.152 |     1.426731→1.450939 |   1.434019→1.482967 |
| sv650sds-sds-tool-j4                    |                    3→3 |   0→0 |    0→0 |   42→42 |   672.225→672.225 |     0.867902→1.024011 |   0.897242→1.167888 |

## Larger direct DSN controls

Three paired repeats/input, identical two-pass / 600-second budgets; all 18 sessions match across sources, full engine statistics match, exact total/added violations zero, no timeout. These are engine checks. Native Dense6 below uses its separately exported prepared input. Larger driver exit 0. Times describe shared-host observations.

| Input             | Opens/run before→after | Vias/run |           Length/run mm | Median s before→after |    p95 s before→after |
| ----------------- | ---------------------: | -------: | ----------------------: | --------------------: | --------------------: |
| dense6-bga324.dsn |                190→190 |  266→266 | 2032.379268→2032.379268 | 198.199891→202.210447 | 201.552778→231.000445 |
| l2-cycle18.dsn    |                  21→21 |    51→51 | 1094.342601→1094.342601 |   24.518541→23.873341 |   26.453974→25.391592 |
| l3-cycle18.dsn    |                153→153 |    93→93 | 1688.604896→1688.604896 | 224.083750→207.421229 | 224.846073→230.190610 |

## Prepared Dense6 native control

Three repeats/source, fixed two-pass / 600-second settings. All six sessions are identical. No introduced error or warning geometry, fidelity regression or timeout. Every case is still incomplete.

| Mode   | Passed /3 | Opens/run | New native errors/run | Vias/run | Length/run mm |          Median / p95 s |
| ------ | --------: | --------: | --------------------: | -------: | ------------: | ----------------------: |
| before |         0 |       181 |                     0 |      315 |   2317.561458 | 206.380366 / 207.034382 |
| after  |         0 |       181 |                     0 |      315 |   2317.561458 | 216.988154 / 237.507454 |

Dense supervisor status: **143 after all six records were written**. Every recorded routing/export/import/check command exited zero without timing out. Source, session, statistics, warning and error audits pass. The table represents completed per-case evidence; the supervisor status remains 143.

## Slow acceptance, unchanged expectations

Each policy completes all 63 slow cases once, with the public recovery flag enabled. Sources run as independently supervised concurrent jobs within cores12–19. Both actual supervisors exit zero. Default-off standard acceptance separately completes63 and exits1 because12 expectations fail. None of these are native benchmark scores.

| Mode                   | Passed /63 | Failed | Advisory | Stubbed | Total case s |
| ---------------------- | ---------: | -----: | -------: | ------: | -----------: |
| Enabled before         |         51 |     12 |       14 |       0 |  2472.876769 |
| Enabled after          |         51 |     12 |       14 |       0 |  2488.514762 |
| Default off, candidate |         51 |     12 |       14 |       0 |  See raw CSV |

The completed comparison finds zero adverse changes under its completion, hard-pass, added-violation, abort and invariant checks. Existing failed expectations remain. Four engine pending-link counts improve:

| Case                                         | Before → after engine opens |
| -------------------------------------------- | --------------------------: |
| routing-slow-dac2020-bm01-p1-maxitems111     |                   110 → 109 |
| routing-slow-dac2020-bm01-p1-maxitems151     |                   110 → 109 |
| routing-slow-issue229-display-p1-optimizer   |                       1 → 0 |
| routing-slow-issue269-caniot-tiny-arm-planes |                     87 → 86 |

These are engine-only observations from one evaluation/case; they do not add native completion scores or establish causal timing effects. Full expected/measured values and all failed cases remain in the compressed raw results.

Private queue placeholders accidentally reused the slow stdout filenames and truncated earlier console text. Complete per-case JSON was unaffected. The raw partial streams are retained as gzip; readable text summaries are explicitly derived from all63 JSON rows. See scheduling-observations.json.
