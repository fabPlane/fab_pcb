# SPDX-License-Identifier: MIT
"""Render measured native connectivity completion from summary.csv."""
import argparse
import csv
from pathlib import Path
import subprocess

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    rows = list(csv.DictReader(args.summary.open()))
    cases = [('t2-baseline0-r1', 'Two pads / connected'),
             ('t3-baseline0-r1', 'Three pads / one edge closed'),
             ('t3-baseline1-r1', 'Preconnected input / no progress'),
             ('dense6-unrouted', 'Dense6 / 439 edges open')]
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="510" viewBox="0 0 1200 510">',
             '<rect width="1200" height="510" fill="#f8fafc"/>',
             '<g font-family="sans-serif" fill="#172033">',
             '<text x="30" y="42" font-size="27">Native connectivity: connection edges versus net count</text>',
             '<text x="30" y="76" font-size="18">Same native DRC reports, three repeats. Dense6: 263 nets, 439 open edges.</text>',
             '<rect x="30" y="98" width="22" height="18" fill="#8895a7"/><text x="62" y="113" font-size="17">Net-count formula</text>',
             '<rect x="290" y="98" width="22" height="18" fill="#0b7c77"/><text x="322" y="113" font-size="17">Input-edge formula (standalone audit)</text>']
    for index, (case, label) in enumerate(cases):
        sub = [r for r in rows if r['case'] == case]
        assert len(sub) == 3 and len({(r['before_completion'], r['edge_completion']) for r in sub}) == 1
        y = 170 + index * 76
        parts.append(f'<text x="30" y="{y+12}" font-size="18">{label}</text>')
        for offset, field, color in [(0, 'before_completion', '#8895a7'), (24, 'edge_completion', '#0b7c77')]:
            value = 100 * float(sub[0][field])
            parts.append(f'<rect x="440" y="{y+offset}" width="{value*5}" height="18" fill="{color}"/>')
            parts.append(f'<text x="{450+value*5}" y="{y+offset+15}" font-size="17">{value:g}%</text>')
    parts.append('<text x="30" y="493" font-size="16">Input validity and scoring evidence only; ranked harness metrics and routing behavior are unchanged.</text></g></svg>')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    svg = args.out.with_suffix('.svg')
    svg.write_text('\n'.join(parts))
    subprocess.run(['rsvg-convert', '-w', '1600', str(svg), '-o', str(args.out)], check=True)
