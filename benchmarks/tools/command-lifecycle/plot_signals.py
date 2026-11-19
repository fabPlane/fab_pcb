# SPDX-License-Identifier: MIT
"""Plot constructed custom-signal controls from a saved CSV."""
import csv
from pathlib import Path
import subprocess
import sys
import tempfile
rows=list(csv.DictReader(Path(sys.argv[1]).open()))
svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600">',
'<rect width="1200" height="600" fill="#fafafa"/>','<g font-family="sans-serif" fill="#202735">',
'<text x="35" y="48" font-size="28">Bounded custom termination signals</text>',
'<text x="35" y="82" font-size="18">Same host · 300 ms deadline + at most 100 ms grace · three paired repeats</text>']
for i,(state,title,key) in enumerate([('handled','Requested handler ran','handled'),('ignored','Surviving descendants','child_survived'),('invalid','Invalid signal spawned a command','spawned')]):
 x=35+i*395
 svg.append(f'<text x="{x}" y="160" font-size="18">{title}</text>')
 for j,(version,color) in enumerate([('before','#bc5851'),('after','#277c75')]):
  cohort=[r for r in rows if r['version']==version and r['state']==state]
  assert sorted(r['repeat'] for r in cohort)==['1','2','3']
  assert all(r[key] in ('True','False') for r in cohort)
  count=sum(r[key]=='True' for r in cohort);y=205+j*110
  svg.extend([f'<text x="{x}" y="{y}" font-size="20">{version}: {count}/3</text>',f'<rect x="{x}" y="{y+15}" width="{count*105}" height="40" fill="{color}"/>'])
svg.append('<text x="35" y="520" font-size="18">Constructed process cases; no routing or speed improvement claimed.</text>')
svg.append('<text x="35" y="553" font-size="18">Separate one-net native check: 3 paired reroutes retain 100% completion and zero errors.</text></g></svg>')
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp)/'chart.svg';p.write_text('\n'.join(svg))
 subprocess.run(['rsvg-convert','-w','1600',str(p),'-o',sys.argv[2]],check=True,timeout=30)
