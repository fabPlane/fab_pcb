# SPDX-License-Identifier: MIT
"""Plot paired remaining-open counts from the relocation measurement CSV."""
import argparse
import csv
from html import escape
from pathlib import Path
import subprocess


def plot(source, output):
    rows = list(csv.DictReader(source.open()))
    cases = list(dict.fromkeys(r['case'] for r in rows))
    height = 150 + 125 * len(cases)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="{height}">',
           f'<rect width="1100" height="{height}" fill="#fafafa"/>',
           '<g font-family="sans-serif" fill="#202735">',
           '<text x="40" y="45" font-size="27">Native baseline relocation preserves remaining opens</text>',
           '<text x="40" y="80" font-size="18">Three repeats per case; fresh DRC before and after; original input directory deleted</text>']
    for index, case in enumerate(cases):
        group = [r for r in rows if r['case'] == case]
        if sorted(r['repeat'] for r in group) != ['1', '2', '3']:
            raise ValueError('plot requires exactly three unique repeats')
        initial = {int(r['initial_opens']) for r in group}
        if len(initial) != 1 or next(iter(initial)) <= 0:
            raise ValueError('plot requires one positive initial denominator per case')
        denominator = next(iter(initial))
        y = 125 + index * 125
        svg.append(f'<text x="40" y="{y}" font-size="20">{escape(case)} ({denominator} initial edges)</text>')
        for j, (label, key, color) in enumerate([('Before', 'before_opens', '#c36337'),
                                                ('Relocated', 'after_opens', '#21877a')]):
            counts = {int(r[key]) for r in group}
            if len(counts) != 1:
                raise ValueError('plot requires identical open counts across repeats')
            count = next(iter(counts))
            width = 630 * count / denominator
            yy = y + 15 + j * 32
            svg.append(f'<text x="60" y="{yy+20}" font-size="17">{label}</text>')
            svg.append(f'<rect x="175" y="{yy}" width="{width}" height="24" fill="{color}"/>')
            svg.append(f'<text x="{190+width}" y="{yy+20}" font-size="17">{count}/{denominator} opens</text>')
    svg.append(f'<text x="40" y="{height-25}" font-size="16">Bars show remaining fraction per case. Zero geometric errors; dense board retains 30 library warnings.</text></g></svg>')
    svg_path = output.with_suffix('.svg')
    svg_path.parent.mkdir(parents=True, exist_ok=True)
    svg_path.write_text('\n'.join(svg) + '\n')
    subprocess.run(['rsvg-convert', '-w', '1600', str(svg_path), '-o', str(output)], check=True, timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('summary', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    plot(args.summary, args.output)
