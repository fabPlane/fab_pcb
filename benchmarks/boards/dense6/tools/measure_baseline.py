# SPDX-License-Identifier: MIT
"""Measure reusable baseline evidence against controlled native partial routes."""
import argparse
import csv
import json
from pathlib import Path
from audit import completion
from baseline import capture, score, verify
from generate_probes import generate


def measure(out, repeats=3, dense=None):
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    summary = out / 'summary.csv'
    summary.unlink(missing_ok=True)
    generate(out / 'inputs')
    rows, evidence = [], []
    for repeat in range(1, repeats + 1):
        cases = [(f't{terminals}-baseline{initial}-r{routed}',
                  out / 'inputs' / f't{terminals}-r{initial}.kicad_pcb',
                  out / 'inputs' / f't{terminals}-r{routed}.kicad_pcb', 1,
                  terminals - initial - 1, terminals - routed - 1)
                 for terminals in (2, 3) for initial in range(terminals)
                 for routed in range(initial, terminals)]
        if dense:
            cases.append(('dense6-unrouted', Path(dense).resolve(), Path(dense).resolve(), 263, 439, 439))
        for name, board, routed, nets, initial, remaining in cases:
            prefix = out / f'{name}-{repeat}'
            baseline = capture(board, prefix.with_suffix('.input.json'))
            record = prefix.with_suffix('.baseline.json')
            record.write_text(json.dumps(baseline, indent=2) + '\n')
            # Exercise the durable artifact boundary, rather than reuse live objects.
            restored = json.loads(record.read_text())
            result = score(restored, routed, prefix.with_suffix('.routed.json'))
            verify(restored)
            if result['initial_opens'] != initial or result['remaining_opens'] != remaining or result['native_errors']:
                raise ValueError('unexpected controlled native result')
            evidence.append(dict(baseline=restored, result=result))
            rows.append(dict(case=name, repeat=repeat, nets=nets, initial_opens=initial,
                             remaining_opens=remaining, native_errors=result['native_errors'],
                             native_warnings=result['native_warnings'],
                             before_completion=completion(nets, remaining),
                             edge_completion=result['completion_rate']))
    (out / 'provenance.json').write_text(json.dumps(dict(repeats=repeats, snapshots=evidence), indent=2) + '\n')
    with summary.open('w') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
    print(f'{len(rows)} scored baseline roundtrips; {2*len(rows)} fresh DRC checks; {summary}')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--dense', type=Path)
    p.add_argument('--repeats', type=int, default=3)
    args = p.parse_args()
    if not 1 <= args.repeats <= 10:
        p.error('repeats must be 1..10')
    measure(args.out, args.repeats, args.dense)
