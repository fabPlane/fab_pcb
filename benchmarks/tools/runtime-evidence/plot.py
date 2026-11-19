"""Render constructed acceptance controls using the system SVG renderer."""
import csv
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
rows = list(csv.DictReader((root/'controls.csv').open()))
cases = ['unchanged', 'binary_bytes', 'binary_mode', 'launcher_target', 'tracked_source']
labels = ['Unchanged', 'Executable bytes', 'Permission bits', 'Launcher target', 'Committed source']
svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="650">',
       '<rect width="1200" height="650" fill="#fafafa"/>',
       '<g font-family="sans-serif" fill="#202735">',
       '<text x="35" y="45" font-size="27">Changes before the midway observation</text>',
       '<text x="35" y="80" font-size="18">Constructed controls on the same host, three repeats per case</text>']
for i, (case, label) in enumerate(zip(cases, labels)):
    y = 140 + i*85
    svg.append(f'<text x="35" y="{y+25}" font-size="20">{label}</text>')
    for offset, field, color in [(0, 'mid_end_accepted', '#a56736'), (32, 'startup_end_accepted', '#267f91')]:
        count = sum(int(r[field]) for r in rows if r['case'] == case)
        svg.append(f'<rect x="300" y="{y+offset}" width="{count*220}" height="25" fill="{color}"/>')
        svg.append(f'<text x="{320+count*220}" y="{y+offset+20}" font-size="18">{count}/3 accepted</text>')
svg.extend(['<text x="35" y="600" font-size="18">Brown: midway/end. Teal: startup/end. Persistent mutations should be rejected.</text>',
            '<text x="35" y="630" font-size="17">Local provenance controls; no routing performance measurement.</text></g></svg>'])
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp)/'plot.svg'
    path.write_text('\n'.join(svg))
    subprocess.run(['rsvg-convert', '-w', '1600', str(path), '-o', str(root/'controls.png')], check=True, timeout=30)
