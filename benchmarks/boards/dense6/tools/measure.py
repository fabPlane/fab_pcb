# SPDX-License-Identifier: MIT
"""Reproduce native denominator evidence, without changing ranked results."""
import argparse
import csv
import json
from pathlib import Path
import tempfile
from audit import completion, snapshot
from generate_probes import generate


def measure(out, dense=None, repeats=3):
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Never retain a previous successful summary after a failed measurement.
    summary = out / 'summary.csv'
    summary.unlink(missing_ok=True)
    rows, evidence = [], []
    with tempfile.TemporaryDirectory(prefix='native-connectivity-') as temp:
        generate(temp)
        temp = Path(temp)
        for repeat in range(1, repeats + 1):
            for terminals in (2, 3):
                snapshots = [snapshot(temp / f't{terminals}-r{r}.kicad_pcb',
                                      out / f't{terminals}-r{r}-{repeat}.json')
                             for r in range(terminals)]
                if [s['opens'] for s in snapshots] != list(reversed(range(terminals))):
                    raise ValueError('unexpected native probe connectivity')
                if any(s['errors'] for s in snapshots):
                    raise ValueError('native probe DRC errors')
                for initial_edges in range(terminals):
                    for routed_edges in range(initial_edges, terminals):
                        initial, final = snapshots[initial_edges], snapshots[routed_edges]
                        rows.append(dict(case=f't{terminals}-baseline{initial_edges}-r{routed_edges}',
                                         repeat=repeat, nets=1, initial_opens=initial['opens'],
                                         remaining_opens=final['opens'], native_errors=final['errors'], native_warnings=final['warnings'],
                                         before_completion=completion(1, final['opens']),
                                         edge_completion=completion(initial['opens'], final['opens'])))
                evidence.extend(snapshots)
            if dense:
                result = snapshot(dense, out / f'dense6-{repeat}.json')
                if result['opens'] != 439 or result['errors']:
                    raise ValueError('dense6 must have 439 opens and zero native errors')
                evidence.append(result)
                rows.append(dict(case='dense6-unrouted', repeat=repeat, nets=263,
                                 initial_opens=result['opens'], remaining_opens=result['opens'],
                                 native_errors=0, native_warnings=result['warnings'], before_completion=completion(263, result['opens']),
                                 edge_completion=completion(result['opens'], result['opens'])))
    (out / 'provenance.json').write_text(json.dumps(dict(repeats=repeats, snapshots=evidence), indent=2) + '\n')
    with summary.open('w') as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f'{len(rows)} comparisons; {len(evidence)} fresh native DRC checks; {summary}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--dense', type=Path)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error('repeats must be 1..10')
    measure(args.out, args.dense, args.repeats)
