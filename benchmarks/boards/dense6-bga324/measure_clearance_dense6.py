# SPDX-License-Identifier: MIT
from pathlib import Path
import json, shutil, subprocess, time
import pcbnew
import argparse
parser=argparse.ArgumentParser(description="Measure clearance override admission; no routing is performed.")
for name in ('before','after','generator','fixture','out'):
 parser.add_argument('--'+name, required=True, type=Path)
args=parser.parse_args()
for name in ('before','after','generator','fixture','out'):
 setattr(args,name,getattr(args,name).resolve())
out=args.out
out.mkdir(parents=True,exist_ok=False)
records=[]
for repeat in range(1,4):
 for kind in ('valid','pad','footprint'):
  fixture=out/f'{kind}-{repeat}'
  shutil.copytree(args.fixture,fixture)
  if kind!='valid':
   path=fixture/'dense6-bga324.kicad_pcb'
   board=pcbnew.LoadBoard(str(path))
   fp=next(iter(board.GetFootprints()))
   item=next(iter(fp.Pads())) if kind=='pad' else fp
   item.SetLocalClearance(50000)
   pcbnew.SaveBoard(str(path),board)
  for label,script in [('before',args.before),('after',args.after)]:
   start=time.monotonic()
   p=subprocess.run(['/usr/bin/python3','-O',str(script),'--generator',str(args.generator),'--fixture',str(fixture),'--out',str(out/f'{label}-{kind}-{repeat}')],capture_output=True,text=True,timeout=180)
   (out/f'{label}-{kind}-{repeat}.log').write_text(p.stdout+p.stderr)
   expected=label=='before' or kind=='valid'
   if (p.returncode==0)!=expected: raise RuntimeError(f'{label} {kind}: {p.stderr}')
   if not expected and 'generated geometry differs' not in p.stderr: raise RuntimeError(p.stderr)
   records.append(dict(repeat=repeat,case=kind,version=label,accepted=p.returncode==0,wall_s=time.monotonic()-start))
   (out/'controls.json').write_text(json.dumps(records,indent=2)+'\n')
print('valid 3/3 -> 3/3; altered local clearance accepted 6/6 -> 0/6')
