# SPDX-License-Identifier: MIT
"""Plot the disposable native report alias experiment from two CSV summaries."""
import argparse
import csv
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('before', type=Path)
parser.add_argument('after', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
rows = [list(csv.DictReader(path.open())) for path in (args.before, args.after)]
keys = lambda group: sorted((r['repeat'], r['target'], r['alias']) for r in group)
assert keys(rows[0]) == keys(rows[1]) and len(set(keys(rows[0]))) == 36
parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="390">',
         '<rect width="1200" height="390" fill="#f8fafc"/>',
         '<g font-family="sans-serif" fill="#172033">',
         '<text x="30" y="45" font-size="27">Native report destinations: preserve inputs before cleanup</text>',
         '<text x="30" y="80" font-size="18">4 protected paths × 3 alias types × 3 repeats; disposable files, same machine.</text>',
         '<text x="30" y="116" font-size="17">Grey: before guard. Teal: after guard. Higher is safer.</text>']
for index, (field, label) in enumerate((('inputs_preserved', 'All input files preserved'),
                                        ('rejected_before_check', 'Rejected before checker launch'))):
    y = 160 + index * 90
    parts.append(f'<text x="30" y="{y+16}" font-size="18">{label}</text>')
    for offset, group, color in ((0, rows[0], '#8895a7'), (29, rows[1], '#0b7c77')):
        count = sum(int(row[field]) for row in group)
        parts.append(f'<rect x="440" y="{y+offset}" width="{count*16}" height="22" fill="{color}"/>')
        parts.append(f'<text x="{450+count*16}" y="{y+offset+18}" font-size="17">{count}/36</text>')
parts.append('<text x="30" y="370" font-size="16">Standalone checker safety only. Routing, ranked scores, and rule files are unchanged.</text></g></svg>')
args.out.parent.mkdir(parents=True, exist_ok=True)
svg = args.out.with_suffix('.svg')
svg.write_text('\n'.join(parts))
subprocess.run(['rsvg-convert', '-w', '1600', str(svg), '-o', str(args.out)], check=True)
