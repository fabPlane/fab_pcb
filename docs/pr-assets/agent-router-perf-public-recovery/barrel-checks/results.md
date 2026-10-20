# Measured barrel recovery results

Three repeats per source/input on the same host and cores 12–19. Frozen sweeps execute off, new enabled, then previous enabled; stress jobs overlap. Per-case p95 for three samples is the maximum. No speed gain is claimed. No new CPU profile was collected for this closure experiment. The known 27 native thermal errors remain unresolved; the frozen suite is not DRC clean.

| Frozen native mode             | Passed /78 | Valid /26 | Opens | Known new errors | Median / p95 s | Total s |
| ------------------------------ | ---------: | --------: | ----: | ---------------: | -------------: | ------: |
| Recovery off                   |         39 |        13 |   120 |               27 | 1.337 / 18.912 | 449.124 |
| Previous recovery enabled      |         39 |        13 |    99 |               27 | 1.200 / 19.508 | 444.866 |
| Recovery enabled, with barrels |         39 |        13 |    99 |               27 | 1.312 / 20.028 | 473.619 |

| Input / check              | Incomplete or native opens, before → after (each repeat) |      Vias | Length mm, before → after | Median s, before → after | p95 s, before → after |
| -------------------------- | -------------------------------------------------------: | --------: | ------------------------: | -----------------------: | --------------------: |
| dense6-bga324, engine only |                                                190 → 190 | 266 → 266 |       2032.379 → 2032.379 |        171.690 → 190.281 |     172.097 → 215.453 |
| l2-cycle18, engine only    |                                                  24 → 21 |   51 → 51 |        992.605 → 1094.343 |          25.642 → 25.463 |       33.579 → 29.794 |
| l3-cycle18, engine only    |                                                153 → 153 |   93 → 93 |       1688.605 → 1688.605 |        220.835 → 209.459 |     224.605 → 211.232 |
| Prepared Dense6, native    |                                                182 → 181 | 315 → 315 |       2305.476 → 2317.561 |        199.709 → 199.034 |     216.786 → 200.243 |

Complete slow acceptance: 51/63 passed, 12 failed, 14 advisory, 0 stubs; unchanged expectations and original budgets, one evaluation per case. The retained prior enabled run was 51/63 passed and 12 failed. All current exact violationsAdded are zero and invariants pass. There are 2 observed adverse per-case differences against that historical run; these are observations under timed/shared-host execution, not causal attribution. Adverse cases: `routing-slow-issue555-bbd-mars64-timebudget`, `routing-slow-issue555-cnh-maxpasses40`. Fresh original-budget process pairs: routing-slow-issue555-bbd-mars64-timebudget: 74→74 incomplete; routing-slow-issue555-cnh-maxpasses40: 21→21 incomplete. Both versions time out, add zero exact violations, and preserve invariants. These are two targeted single-evaluation pairs, not another full slow sweep; they do not erase the original adverse observations or prove all-input nonregression.

| Case                                    | Passed off → on /3 | Opens off → on | Errors off → on | Median s off → on |  p95 s off → on |
| --------------------------------------- | -----------------: | -------------: | --------------: | ----------------: | --------------: |
| fan-controller-fan-controller-j1        |              0 → 0 |        15 → 12 |           0 → 0 |     4.373 → 5.739 |   4.608 → 6.029 |
| fan-controller-fan-controller-j2-large  |              3 → 3 |          0 → 0 |           0 → 0 |     1.043 → 0.887 |   1.125 → 0.897 |
| fan-controller-fan-controller-j2-medium |              3 → 3 |          0 → 0 |           0 → 0 |     0.897 → 0.781 |   0.910 → 0.792 |
| fan-controller-fan-controller-j2-small  |              0 → 0 |          3 → 3 |           0 → 0 |     4.029 → 4.500 |   4.198 → 4.633 |
| hellscribe-hellscribe-j1                |              0 → 0 |          9 → 9 |           0 → 0 |     2.389 → 4.427 |   2.509 → 4.510 |
| hellscribe-hellscribe-j2-large          |              0 → 0 |          3 → 3 |           0 → 0 |     1.028 → 1.161 |   1.337 → 1.310 |
| kitspace-aquarius-j4                    |              0 → 0 |        45 → 45 |         18 → 18 |   56.395 → 61.054 | 61.711 → 61.129 |
| kitspace-lcr-addon-j3                   |              3 → 3 |          0 → 0 |           0 → 0 |     2.518 → 2.478 |   2.707 → 2.789 |
| kitspace-solenoid-driver-j1             |              3 → 3 |          0 → 0 |           0 → 0 |     0.764 → 0.874 |   0.917 → 0.879 |
| kitspace-solenoid-driver-j3             |              3 → 3 |          0 → 0 |           0 → 0 |     0.908 → 0.753 |   0.912 → 0.933 |
| kitspace-solenoid-driver-j4             |              3 → 3 |          0 → 0 |           0 → 0 |     0.881 → 0.879 |   0.903 → 1.077 |
| nextbusclock-nextbusclockv1-j2-large    |              3 → 3 |          0 → 0 |           0 → 0 |     3.597 → 3.414 |   3.700 → 3.708 |
| nextbusclock-nextbusclockv1-j2-medium   |              3 → 3 |          0 → 0 |           0 → 0 |     1.022 → 1.005 |   1.061 → 1.022 |
| nextbusclock-nextbusclockv1-j2-small    |              3 → 3 |          0 → 0 |           0 → 0 |     0.893 → 0.837 |   0.997 → 1.003 |
| nextbusclock-nextbusclockv1-j3          |              0 → 0 |          9 → 3 |           0 → 0 |     9.177 → 9.648 |  9.305 → 11.310 |
| paperino-hw-paperino-shield-j4          |              0 → 0 |        18 → 12 |           0 → 0 |   18.413 → 19.757 | 18.912 → 20.028 |
| photon-sprinkler-sprinkler-j1           |              0 → 0 |          6 → 3 |           0 → 0 |   13.335 → 12.540 | 13.820 → 13.973 |
| photon-sprinkler-sprinkler-j3           |              0 → 0 |          6 → 3 |           0 → 0 |   16.617 → 16.865 | 17.405 → 17.706 |
| qrpcard-qrpcard-j1                      |              3 → 3 |          0 → 0 |           0 → 0 |     1.624 → 1.560 |   1.723 → 1.622 |
| qrpcard-qrpcard-j2-medium               |              3 → 3 |          0 → 0 |           0 → 0 |     0.895 → 0.879 |   0.936 → 0.940 |
| qrpcard-qrpcard-j2-small                |              0 → 0 |          0 → 0 |           6 → 6 |     0.772 → 0.750 |   0.822 → 0.760 |
| qrpcard-qrpcard-j4                      |              0 → 0 |          0 → 0 |           3 → 3 |     1.334 → 1.163 |   1.344 → 1.303 |
| rufs-smart-psu-j1                       |              3 → 3 |          0 → 0 |           0 → 0 |     0.790 → 0.881 |   0.948 → 0.905 |
| rufs-smart-psu-j3                       |              0 → 0 |          3 → 3 |           0 → 0 |     2.134 → 2.068 |   2.155 → 2.207 |
| rufs-smart-psu-j4                       |              0 → 0 |          3 → 3 |           0 → 0 |     1.337 → 1.413 |   1.462 → 1.417 |
| sv650sds-sds-tool-j4                    |              3 → 3 |          0 → 0 |           0 → 0 |     0.896 → 0.889 |   0.900 → 0.893 |
