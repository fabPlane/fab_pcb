# SPDX-License-Identifier: MIT
"""Render terminal-preservation measurement summaries with the standard library."""
import argparse
import csv
from pathlib import Path
import subprocess


def plot(source, output):
    rows = list(csv.DictReader(source.open()))
    edge_report = 'valid' in rows[0]
    valid = lambda r: r['valid'] == 'True' if edge_report else r['case'] in {
        'unchanged', 'partial-route', 'complete-route', 'reserialized'}
    groups = [('Valid controls', [r for r in rows if valid(r)]),
              ('Invalid edge reports' if edge_report else 'Changed terminals',
               [r for r in rows if not valid(r)])]
    title = ('Native scoring: reject duplicate and self edges' if edge_report else
             'Native scoring: preserve terminals before counting opens')
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="480" viewBox="0 0 1100 480">',
           '<rect width="1100" height="480" fill="#fafafa"/>',
           '<g font-family="sans-serif" fill="#202735">',
           f'<text x="50" y="50" font-size="27">{title}</text>',
           '<text x="50" y="85" font-size="18">Same boards and checker; three repeats; accepted attempts</text>']
    for i, (name, cohort) in enumerate(groups):
        y = 150 + i * 145
        svg.append(f'<text x="50" y="{y}" font-size="21">{name} ({len(cohort)} attempts)</text>')
        for j, (label, key, color) in enumerate([('Before', 'before_accepted', '#c36337'),
                                                 ('After', 'after_accepted', '#21877a')]):
            count = sum(r[key] == 'True' for r in cohort)
            yy = y + 20 + j * 37
            svg.append(f'<text x="70" y="{yy+21}" font-size="18">{label}</text>')
            svg.append(f'<rect x="160" y="{yy}" width="{650*count/len(cohort)}" height="27" fill="{color}"/>')
            svg.append(f'<text x="{175+650*count/len(cohort)}" y="{yy+21}" font-size="18">{count}/{len(cohort)}</text>')
    svg.append('<text x="50" y="450" font-size="16">Standalone guard measurement; no routing or speed improvement claimed.</text></g></svg>')
    svg_path = output.with_suffix('.svg')
    svg_path.parent.mkdir(parents=True, exist_ok=True)
    svg_path.write_text('\n'.join(svg) + '\n')
    subprocess.run(['rsvg-convert', '-w', '1600', str(svg_path), '-o', str(output)], check=True, timeout=30)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('summary', type=Path)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    plot(args.summary, args.output)
