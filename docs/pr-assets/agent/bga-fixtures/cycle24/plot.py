# SPDX-License-Identifier: MIT
"""Render schema-decisions.csv; requires rsvg-convert."""
import csv
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent
rows = list(csv.DictReader((root / 'schema-decisions.csv').open()))
valid = [r for r in rows if r['variant'] == 'valid']
bad = [r for r in rows if r['variant'] != 'valid']
svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="410" viewBox="0 0 1000 410">', '<rect width="1000" height="410" fill="#f8fafc"/>', '<g font-family="sans-serif" fill="#0f172a">', '<text x="40" y="45" font-size="25">BGA input schema audit</text>', '<text x="40" y="75" font-size="16">Same B1/B2 fixtures · 5 added fields · 3 repeats per fixture/variant</text>']
for index, (label, data, color) in enumerate([('Genuine fixtures accepted', valid, '#2563eb'), ('Altered fixtures accepted', bad, '#dc2626')]):
    y = 120 + index * 135
    svg.append(f'<text x="40" y="{y}" font-size="19">{label}</text>')
    for j, column in enumerate(['accepted_before', 'accepted_after']):
        count = sum(int(r[column]) for r in data)
        width = 580 * count / len(data)
        row = y + 20 + j * 33
        svg += [f'<text x="40" y="{row+17}" font-size="16">{["Before", "After"][j]}</text>', f'<rect x="120" y="{row}" width="580" height="23" fill="#e2e8f0"/>', f'<rect x="120" y="{row}" width="{width}" height="23" fill="{color}"/>', f'<text x="720" y="{row+17}" font-size="16">{count} / {len(data)}</text>']
svg += ['<text x="40" y="385" font-size="14">Controlled corruptions test evidence validation; no routing or speed gain claimed.</text>', '</g></svg>']
(root / 'schema-audit.svg').write_text('\n'.join(svg))
subprocess.run(['rsvg-convert', '-w', '1600', str(root / 'schema-audit.svg'), '-o', str(root / 'schema-audit.png')], check=True)
