# SPDX-License-Identifier: MIT
"""Measure checker descendant cleanup and fresh native score parity."""
import argparse
import csv
import json
from pathlib import Path
import subprocess
import sys
import time
from audit import run_checker
from baseline import capture
from generate_probes import generate
from terminals import guarded_score
import audit


def legacy(argv, timeout=60):
    # Same timeout/pipe semantics as the previous snapshot implementation.
    subprocess.run(argv, check=True, timeout=timeout, capture_output=True)


def measure(out, repeats=3):
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    for mode in ('success', 'nonzero', 'timeout'):
        for repeat in range(1, repeats + 1):
            row = dict(case=mode, repeat=repeat)
            for label, invoke in [('before', legacy), ('after', run_checker)]:
                root = out / f'{mode}-{repeat}-{label}'
                root.mkdir()
                marker = root / 'survived'
                child = f'import time,pathlib; time.sleep(.7); pathlib.Path({str(marker)!r}).touch()'
                code = ('import subprocess,sys,time; '
                        f'subprocess.Popen([sys.executable,"-c",{child!r}]); ' +
                        ('time.sleep(10)' if mode == 'timeout' else f'sys.exit({7 if mode == "nonzero" else 0})'))
                argv = [sys.executable, '-c', code]
                started = time.monotonic()
                try:
                    invoke(argv, timeout=.25)
                    state = 'completed'
                except subprocess.TimeoutExpired:
                    state = 'timeout'
                except subprocess.CalledProcessError:
                    state = 'nonzero'
                elapsed = time.monotonic() - started
                time.sleep(1)
                row[label + '_child_survived'] = marker.exists()
                row[label + '_state'] = state
                row[label + '_elapsed_s'] = round(elapsed, 4)
            if not row['before_child_survived'] or row['after_child_survived']:
                raise ValueError(f'unexpected child cleanup: {row}')
            expected = dict(success='completed', nonzero='nonzero', timeout='timeout')[mode]
            if row['after_state'] != expected:
                raise ValueError(f'checker exit precedence changed: {row}')
            rows.append(row)
    write(out / 'cleanup.csv', rows)
    generate(out / 'probes')
    scores = []
    for edges, expected in ((0, 0), (1, .5), (2, 1)):
        for repeat in range(1, repeats + 1):
            run = out / f'native-{edges}-{repeat}'
            run.mkdir()
            baseline = capture(out / 'probes/t3-r0.kicad_pcb', run / 'input.json')
            candidate = out / f'probes/t3-r{edges}.kicad_pcb'
            try:
                audit.run_checker = legacy
                before = guarded_score(baseline, candidate, run / 'before.json')
            finally:
                audit.run_checker = run_checker
            after = guarded_score(baseline, candidate, run / 'after.json')
            keys = ('completion_rate', 'initial_opens', 'remaining_opens', 'native_errors', 'native_warnings')
            if any(before[k] != after[k] for k in keys) or after['completion_rate'] != expected:
                raise ValueError('checker cleanup changed native score')
            scores.append(dict(edges=edges, repeat=repeat,
                **{label + '_' + key: value[key] for label, value in [('before', before), ('after', after)]
                   for key in keys}))
    write(out / 'scores.csv', scores)
    print(json.dumps(dict(cleanup_pairs=len(rows), native_pairs=len(scores), fresh_drc=3*len(scores))))


def write(path, rows):
    with path.open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repeats', type=int, choices=range(1, 11), default=3)
    args = parser.parse_args()
    measure(args.out.resolve(), args.repeats)
