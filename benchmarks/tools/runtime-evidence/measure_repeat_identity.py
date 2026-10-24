# SPDX-License-Identifier: MIT
"""Construct same-mixed-set controls; does not execute a router."""
import csv
import json
from pathlib import Path
import subprocess
import sys
from repeat_identity import single_identity


def measure(output):
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for label, original, changed in [('fixture hash', {'hash': 'a'}, {'hash': 'b'}),
                                     ('fixture tier', {'tier': 'L1'}, {'tier': 'L2'}),
                                     ('CPU', 'cpu-a', 'cpu-b'), ('unchanged', {'hash': 'a'}, {'hash': 'a'})]:
        for repeat in range(3):
            values = [original] * 3
            values[repeat] = changed
            # Prior comparison accepted equal sets even if each batch was mixed.
            old = {json.dumps(v, sort_keys=True) for v in values} == {json.dumps(v, sort_keys=True) for v in reversed(values)}
            try:
                new = single_identity(values, label) == single_identity(reversed(values), label)
            except ValueError:
                new = False
            rows.append([label, repeat, int(old), int(new)])
    with (output / 'controls.csv').open('w') as f:
        writer = csv.writer(f, lineterminator='\n')
        writer.writerow(['control', 'repeat', 'accepted_before', 'accepted_after'])
        writer.writerows(rows)
    assert sum(r[2] for r in rows[:9]) == 9 and sum(r[3] for r in rows[:9]) == 0
    assert sum(r[3] for r in rows[9:]) == 3
    svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="330"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" fill="#203040"><text x="30" y="40" font-size="24">Repeat identity controls: accepted comparisons</text><text x="30" y="75" font-size="17">Constructed controls, three repeats per row; no routing performance claim</text>'''
    for i, label in enumerate(('fixture hash', 'fixture tier', 'CPU', 'unchanged')):
        y = 110 + i * 50
        count = sum(r[3] for r in rows if r[0] == label)
        svg += f'<text x="30" y="{y+20}" font-size="18">{label}</text><rect x="210" y="{y}" width="240" height="15" fill="#b96b44"/><rect x="510" y="{y}" width="{count*80}" height="15" fill="#21877a"/><text x="770" y="{y+18}" font-size="17">3 before / {count} after</text>'
    svg += '</g></svg>'
    (output / 'controls.svg').write_text(svg)
    subprocess.run(['rsvg-convert', str(output / 'controls.svg'), '-o', str(output / 'controls.png')], check=True, timeout=30)


if __name__ == '__main__':
    measure(Path(sys.argv[1]))
