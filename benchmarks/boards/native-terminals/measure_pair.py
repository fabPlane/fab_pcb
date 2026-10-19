# SPDX-License-Identifier: MIT
"""Compare unguarded/guarded native scoring for a preserved board pair."""
import argparse
import csv
import json
from pathlib import Path
from baseline import capture, score
from terminals import guarded_score, signature


def measure(original, candidate, out, repeats):
    out.mkdir(parents=True, exist_ok=True)
    summary = out / 'summary.csv'
    summary.unlink(missing_ok=True)
    rows, evidence = [], []
    for repeat in range(1, repeats + 1):
        baseline = capture(original, out / f'input-{repeat}.json')
        before = score(baseline, candidate, out / f'before-{repeat}.json')
        after = guarded_score(baseline, candidate, out / f'after-{repeat}.json')
        fields = ('initial_opens', 'remaining_opens', 'completion_rate', 'native_errors', 'native_warnings')
        if any(before[k] != after[k] for k in fields):
            raise ValueError('guarded native result differs from preserved-board control')
        rows.append(dict(repeat=repeat, pads=len(signature(original)['pads']),
                         before_completion=before['completion_rate'],
                         after_completion=after['completion_rate'],
                         **{k: after[k] for k in fields if k != 'completion_rate'},
                         terminal_signature_sha256=after['terminal_signature_sha256']))
        evidence.append(dict(baseline=baseline, before=before, after=after))
    with summary.open('w') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader(); writer.writerows(rows)
    (out / 'provenance.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(f'{repeats} preserved-board pairs; {repeats*3} fresh native checks')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--original', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--repeats', type=int, default=3, choices=range(1, 11))
    args = p.parse_args()
    measure(args.original.resolve(), args.candidate.resolve(), args.out.resolve(), args.repeats)
