# SPDX-License-Identifier: MIT
"""Three-repeat constructed numeric admission controls; no routing engine runs."""
import copy
import csv
import json
from pathlib import Path
import subprocess
import sys
from repeat_identity import quality_values, batch_identities


def controls():
    invalid = {
        'completion_rate': [-1, 1.1, True, float('nan'), float('inf'), '1', None],
        'unrouted_connections': [-1, 0.5, True, '0', None],
        'drc_errors': [-1, 0.5, True, '0', None],
    }
    for field, values in invalid.items():
        for index, value in enumerate(values):
            yield f'{field}-{index}', field, value, False
    for rate in (0, 0.5, 1):
        yield f'valid-{rate}', 'completion_rate', rate, True


def measure(output):
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for name, field, value, valid in controls():
        for repeat in range(3):
            run = dict(fixture={'id': 'control'}, system={'cpu_name': 'control-cpu'},
                       exit={'state': 'completed'}, quality_validation='native-drc',
                       quality=dict(completion_rate=1, unrouted_connections=0, drc_errors=0))
            run['quality'][field] = value
            # Execute the previous identity admission boundary; it does not
            # inspect quality. Numeric admission is added after this boundary.
            batch_identities([copy.deepcopy(run) for _ in range(3)])
            try:
                quality_values(copy.deepcopy(run))
                accepted = True
            except ValueError:
                accepted = False
            assert accepted == valid
            rows.append([name, repeat, int(valid), 1, int(accepted)])
    with (output / 'controls.csv').open('w') as f:
        writer = csv.writer(f, lineterminator='\n')
        writer.writerow(['control', 'repeat', 'valid', 'accepted_before', 'accepted_after'])
        writer.writerows(rows)
    counts = {str(valid): dict(before=sum(r[3] for r in rows if r[2] == valid),
                              after=sum(r[4] for r in rows if r[2] == valid)) for valid in (0, 1)}
    (output / 'counts.json').write_text(json.dumps(counts, indent=2) + '\n')
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="300"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" fill="#203040"><text x="30" y="40" font-size="24">Numeric quality admission: accepted controls</text><text x="30" y="75" font-size="17">Constructed evidence; three repeats per mutation; no routing gain claimed</text>'
    for i, valid in enumerate((0, 1)):
        y = 120 + i * 70
        before, after = counts[str(valid)]['before'], counts[str(valid)]['after']
        svg += f'<text x="30" y="{y+20}" font-size="18">{"valid" if valid else "malformed"}</text><rect x="210" y="{y}" width="{before*6}" height="20" fill="#b96b44"/><rect x="550" y="{y}" width="{after*6}" height="20" fill="#21877a"/><text x="870" y="{y+18}" font-size="17">{before} before / {after} after</text>'
    (output / 'controls.svg').write_text(svg + '</g></svg>')
    subprocess.run(['rsvg-convert', str(output / 'controls.svg'), '-o', str(output / 'controls.png')], check=True, timeout=30)
    print(json.dumps(counts))


if __name__ == '__main__':
    measure(Path(sys.argv[1]))
