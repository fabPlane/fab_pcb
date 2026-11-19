# SPDX-License-Identifier: MIT
"""Render the measured checker process cleanup comparison."""
import argparse
import csv
from pathlib import Path
import subprocess
import tempfile


def plot(source, output):
    rows = list(csv.DictReader(source.open()))
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="600">',
           '<rect width="1100" height="600" fill="#fafafa"/>',
           '<g font-family="sans-serif" fill="#202735">',
           '<text x="40" y="50" font-size="28">Checker descendants surviving the invocation</text>',
           '<text x="40" y="88" font-size="18">Three repeats per exit mode; identical child workload and 0.25-second deadline</text>']
    for index, mode in enumerate(('success', 'nonzero', 'timeout')):
        group = [r for r in rows if r['case'] == mode]
        if sorted(r['repeat'] for r in group) != ['1', '2', '3']:
            raise ValueError('plot requires three unique repeats per mode')
        y = 140 + index * 130
        svg.append(f'<text x="40" y="{y}" font-size="22">Parent exit: {mode}</text>')
        for j, (label, color) in enumerate([('before', '#c36337'), ('after', '#21877a')]):
            values = [r[label + '_child_survived'] for r in group]
            if any(v not in ('True', 'False') for v in values):
                raise ValueError('unknown cleanup evidence')
            count = values.count('True')
            yy = y + 12 + 32*j
            svg.append(f'<text x="60" y="{yy+20}" font-size="18">{label.title()}</text>')
            svg.append(f'<rect x="180" y="{yy}" width="{count*200}" height="24" fill="{color}"/>')
            svg.append(f'<text x="{195+count*200}" y="{yy+20}" font-size="18">{count}/3 survived</text>')
    svg.append('<text x="40" y="565" font-size="17">Native score controls are separate: 0%, 50%, 100% completion unchanged across three repeats each.</text></g></svg>')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / 'plot.svg'
        path.write_text('\n'.join(svg))
        subprocess.run(['rsvg-convert', '-w', '1600', str(path), '-o', str(output)], check=True, timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    plot(args.summary, args.output)
