#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Versioned tuning wrapper; unchanged engines and shared track-C format path."""
import argparse, importlib.util, json, os, pathlib, subprocess
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('engine',HERE/'dsn-engine-scoring-v1.py')
engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
if __name__=='__main__':
 p=argparse.ArgumentParser()
 p.add_argument('--router',required=True);p.add_argument('--work-dir',type=pathlib.Path,required=True)
 p.add_argument('--seed',type=int,required=True);p.add_argument('--cap-s',type=int,required=True)
 p.add_argument('--settings-file',type=pathlib.Path,required=True)
 a=p.parse_args();settings=json.loads(a.settings_file.read_text());work=a.work_dir.resolve()
 args=engine.argv(a.router,work,a.seed,a.cap_s,settings.get('parity',False))
 if a.router=='fab-router':
  args=['bun',str(HERE/'fab-route-c2.ts'),str(work),str(a.seed),str(a.cap_s),str(a.settings_file.resolve())]
 else:
  if a.router=='freerouting':
   java=engine.ROOT/'runtime/b/jdk/bin/java'
   assert 'JAVA_VERSION="25' in (java.parent.parent/'release').read_text()
   args[0]=str(java)
  for flag,value in settings.get('flags',{}).items():
   args=[x for x in args if not x.startswith(flag+'=')]
   args.append(flag+'='+str(value).lower())
 (work/'engine-command.json').write_text(json.dumps(args,indent=2)+'\n')
 (work/'candidate-settings.json').write_text(json.dumps(settings,indent=2)+'\n')
 # Runner supplies isolated HOME/XDG in ignored build state; retain that isolation.
 raise SystemExit(subprocess.call(args,cwd=work,env=os.environ.copy()))
