# SPDX-License-Identifier: MIT
"""Measure constructed cross-backend mismatches, without executing routers."""
import csv
import json
from pathlib import Path
import subprocess
import sys
from repeat_identity import single_identity, batch_identities


def controls():
    for label, field, key, value in [('fixture hash', 'fixture', 'sha256', 'b'),
                                    ('fixture tier', 'fixture', 'tier', 'C2'),
                                    ('CPU', 'system', 'cpu_name', 'cpu-b'),
                                    ('unchanged', 'system', 'cpu_name', 'cpu-a')]:
        for changed_backend in range(3):
            runs = [dict(cache_key=f'{backend}-{repeat}',
                         backend={'id': backend, 'version': 'one'},
                         fixture={'id': 'case', 'suite': 'canary', 'tier': 'C1', 'sha256': 'a'},
                         system={'cpu_name': 'cpu-a'}, exit={'state': 'completed'},
                         quality_validation='native-drc', quality={'completion_rate': 1,
                         'unrouted_connections': 0, 'drc_errors': 0}, timing={'wall_ms': 1})
                    for backend in range(3) for repeat in range(3)]
            for r in runs:
                if r['backend']['id'] == changed_backend:
                    r[field][key] = value
            yield label, changed_backend, runs


def prior_admission(runs):
    for backend in range(3):
        group = [r for r in runs if r['backend']['id'] == backend]
        single_identity((r['fixture'] for r in group), 'fixture')
        single_identity((r['system']['cpu_name'] for r in group), 'CPU')


def measure(output):
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for label, changed_backend, runs in controls():
        prior_admission(runs)
        try:
            batch_identities(runs)
            accepted = 1
        except ValueError:
            accepted = 0
        rows.append([label, changed_backend, 1, accepted])
    assert sum(r[3] for r in rows[:9]) == 0
    assert sum(r[3] for r in rows[9:]) == 3
    with (output / 'controls.csv').open('w') as f:
        writer = csv.writer(f, lineterminator='\n')
        writer.writerow(['control', 'changed_backend', 'accepted_before', 'accepted_after'])
        writer.writerows(rows)
    (output / 'controls.json').write_text(json.dumps([
        dict(control=label, changed_backend=backend, runs=runs)
        for label, backend, runs in controls()], indent=2) + '\n')
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="330"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" fill="#203040"><text x="30" y="40" font-size="24">Batch identity controls: accepted comparisons</text><text x="30" y="75" font-size="17">Constructed mismatches across backends; three repeats per backend</text>'
    for i, label in enumerate(('fixture hash', 'fixture tier', 'CPU', 'unchanged')):
        y = 110 + i * 50
        count = sum(r[3] for r in rows if r[0] == label)
        svg += f'<text x="30" y="{y+20}" font-size="18">{label}</text><rect x="210" y="{y}" width="240" height="15" fill="#b96b44"/><rect x="510" y="{y}" width="{count*80}" height="15" fill="#21877a"/><text x="770" y="{y+18}" font-size="17">3 before / {count} after</text>'
    (output / 'controls.svg').write_text(svg + '</g></svg>')
    subprocess.run(['rsvg-convert', str(output / 'controls.svg'), '-o', str(output / 'controls.png')], check=True, timeout=30)


if __name__ == '__main__':
    measure(Path(sys.argv[1]))
