# SPDX-License-Identifier: MIT
"""Render measured lifecycle controls with the system SVG rasterizer."""
import csv
from pathlib import Path
import subprocess
import sys
import tempfile

rows=list(csv.DictReader(Path(sys.argv[1]).open()))
svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">',
     '<rect width="1200" height="630" fill="#fafafa"/>',
     '<g font-family="sans-serif" fill="#202735">',
     '<text x="35" y="48" font-size="28">Owned command lifecycle</text>',
     '<text x="35" y="82" font-size="18">Same host · 250 ms deadline · three repeats per parent exit mode</text>']
for panel,title in enumerate(['Surviving children (lower is better)','Correct deadline classification (higher is better)']):
 x=35+panel*600
 svg.append(f'<text x="{x}" y="130" font-size="21">{title}</text>')
 for index,state in enumerate(('success','nonzero','timeout')):
  y=175+index*130
  svg.append(f'<text x="{x}" y="{y}" font-size="20">Parent: {state}</text>')
  for j,(version,color) in enumerate([('before','#bc5851'),('after','#277c75')]):
   cohort=[r for r in rows if r['version']==version and r['state']==state]
   assert sorted(r['repeat'] for r in cohort)==['1','2','3']
   assert all(r['child_survived'] in ('True','False') and r['timed_out'] in ('True','False') for r in cohort)
   count=sum(r['child_survived']=='True' for r in cohort) if panel==0 else sum((r['timed_out']=='True')==(state=='timeout') for r in cohort)
   yy=y+12+j*34
   svg.extend([f'<text x="{x+12}" y="{yy+21}" font-size="17">{version}</text>',
               f'<rect x="{x+95}" y="{yy}" width="{count*110}" height="25" fill="{color}"/>',
               f'<text x="{x+105+count*110}" y="{yy+21}" font-size="18">{count}/3</text>'])
svg.append('<text x="35" y="600" font-size="17">Separate real session check: 3 before/after pairs retain 100% completion, 0 opens, 0 native errors.</text></g></svg>')
with tempfile.TemporaryDirectory() as temp:
 p=Path(temp)/'chart.svg';p.write_text('\n'.join(svg))
 subprocess.run(['rsvg-convert','-w','1600',str(p),'-o',sys.argv[2]],check=True,timeout=30)
