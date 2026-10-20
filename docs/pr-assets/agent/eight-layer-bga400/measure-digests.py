from pathlib import Path
import subprocess,shutil,json,tempfile
import sys
root=Path(sys.argv[1]).resolve();s=Path(sys.argv[2]).resolve();s.mkdir(parents=True,exist_ok=True)
source=root/"benchmarks/boards/bga400"
old=subprocess.check_output(['git','-C',str(root),'show','a02a1ba:benchmarks/boards/bga400/test_generate.py'])
results=[]
for state in ('valid','wrong-digest','missing-digest'):
 for version in ('before','after'):
  for repeat in range(3):
   with tempfile.TemporaryDirectory(dir=s) as tmp:
    d=Path(tmp)/'fixture';shutil.copytree(source,d)
    if version=='before':(d/'test_generate.py').write_bytes(old)
    summary=json.loads((d/'summary.json').read_text())
    if state=='wrong-digest':summary['sha256']['bga400.kicad_pro']='0'*64
    if state=='missing-digest':del summary['sha256']['bga400.kicad_pro']
    (d/'summary.json').write_text(json.dumps(summary))
    run=subprocess.run(['/usr/bin/python3','-O',str(d/'test_generate.py')],capture_output=True,text=True,timeout=180)
    (s/f'public-{state}-{version}-{repeat}.log').write_text(run.stdout+run.stderr)
    results.append(dict(state=state,version=version,repeat=repeat,accepted=run.returncode==0))
    print(results[-1],flush=True)
(s/'public-controls.json').write_text(json.dumps(results,indent=2)+'\n')
