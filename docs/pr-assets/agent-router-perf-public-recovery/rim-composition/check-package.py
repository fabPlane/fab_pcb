from pathlib import Path
import argparse,json,os,subprocess
p=argparse.ArgumentParser();p.add_argument('--engine-source',type=Path,required=True);a=p.parse_args()
here=Path(__file__).resolve().parent;root=here.parents[3]
commands=json.loads((here/'package-exit.json').read_text())['commands']
for cmd in commands:
 subprocess.run(['taskset','-c','12-19','nice','-n','10','timeout','--kill-after=5','300',*cmd],cwd=root/'packages/router',env={**os.environ,'FAB_ROUTER_MODULE':str(a.engine_source.resolve()/'src/api.ts')},check=True)
