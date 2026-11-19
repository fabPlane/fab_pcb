#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Standalone config-driven runner v5.1 with support-gate classification. Append-only attempts; no scored setup runs."""
import argparse,datetime,hashlib,json,os,pathlib,shutil,signal,subprocess,time
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parent

def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def tree_rss(root_pid,known):
 """Sample all descendants, including children which start a new process group."""
 table={}
 for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
  try:
   parts=path.read_text().rsplit(')',1)[1].split();pid=int(path.parent.name)
   table[pid]={'ppid':int(parts[1]),'pgid':int(parts[2]),'rss':int(parts[21])*os.sysconf('SC_PAGE_SIZE')//1024,'start':parts[19],'state':parts[0]}
  except (OSError,ValueError,IndexError):pass
 members={pid for pid,start in known.items() if pid in table and table[pid]['start']==start}
 if root_pid in table:members.add(root_pid)
 changed=True
 while changed:
  children={pid for pid,t in table.items() if t['ppid'] in members or t['pgid']==root_pid}
  changed=not children.issubset(members);members |= children
 for pid in members:known[pid]=table[pid]['start']
 active=[pid for pid in members if table[pid]['state']!='Z']
 return sum(table[pid]['rss'] for pid in active),active

def kill_group(pid,sig):
 try:os.killpg(pid,sig)
 except ProcessLookupError:pass

def command(argv,label,out,env,cwd,deadline,cpu):
 start=time.monotonic_ns();stamp=utc();peak=0;seen=set();known={};timed_out=False;terminated_at=None;telemetry=Telemetry()
 args=list(map(str,argv))
 with (out/(label+'.stdout.log')).open('xb') as stdout,(out/(label+'.stderr.log')).open('xb') as stderr:
  p=subprocess.Popen(args,stdout=stdout,stderr=stderr,cwd=cwd,env=env,start_new_session=True)
  while True:
   rss,pids=tree_rss(p.pid,known);peak=max(peak,rss);seen.update(pids);telemetry.sample(pids);code=p.poll()
   now=time.monotonic()
   if now>=deadline and terminated_at is None and (code is None or pids):
    timed_out=True;terminated_at=now;kill_group(p.pid,signal.SIGTERM)
    for pid in pids:
     try:os.kill(pid,signal.SIGTERM)
     except ProcessLookupError:pass
   if terminated_at is not None and now-terminated_at>=5:
    kill_group(p.pid,signal.SIGKILL)
    for pid in pids:
     try:os.kill(pid,signal.SIGKILL)
     except ProcessLookupError:pass
   if code is not None and not pids:break
   time.sleep(.1)
  code=p.wait()
 end=time.monotonic_ns()
 return {'label':label,'args':args,'utc_start':stamp,'utc_end':utc(),'monotonic_start_ns':start,'monotonic_end_ns':end,'wall_seconds':(end-start)/1e9,'exit_code':code,'timed_out':timed_out,'peak_tree_rss_kib':peak,'observed_pids':sorted(seen),'allowed_cpus':sorted(os.sched_getaffinity(0)),**telemetry.result((end-start)/1e9)}

from scoring_telemetry_v1 import Telemetry

def run(a):
 out=a.out.resolve()/a.attempt/a.router
 out.mkdir(parents=True,exist_ok=False)
 fixture=a.fixture.resolve();record={'router':a.router,'attempt':a.attempt,'seed':a.seed,'utc_start':utc(),'model':None,'steps':[],'pass':False,'status':'started','cap_s':3600,'grace_s':5,'rss_method':'peak simultaneous RSS sum of descendants (including separate process groups), /proc samples every 100 ms; sampled lower bound, shared pages counted per process'}
 begin=time.monotonic_ns();work=out/'work';work.mkdir();home=ROOT/'.cache/homes'/a.attempt/a.router;home.mkdir(parents=True,exist_ok=False);cpu=min(os.sched_getaffinity(0))
 try:
  job=json.loads((fixture/'job.json').read_text());config_path=(a.config_dir or HERE/'configs')/(a.router+'.json');config=json.loads(config_path.read_text());cfg=config.get('jobs',config).get(job['job'])
  if not cfg:raise ValueError('missing job configuration')
  record['config_path']=str(config_path.resolve());record['checker_sha256']=sha(HERE/'native-check-v4.3.py');record['runner_sha256']=sha(pathlib.Path(__file__))
  for name,expected in job.get('sha256',{}).items():
   if sha(fixture/name)!=expected:raise ValueError('fixture hash mismatch: '+name)
  record.update(job=job['job'],role=job['role'],config_sha256=sha(config_path),fixture_sha256={f.name:sha(f) for f in fixture.iterdir() if f.is_file()},seed_supported=cfg.get('seed_supported',False),settings=cfg.get('settings',{}),support=cfg['support'])
  if cfg['support']=='no':record.update(status='not_supported',support_reason=cfg.get('reason',cfg.get('limitations','configuration declares support: no')));return record
  if cfg['support'] not in ['yes','approximated']:raise ValueError('invalid support declaration')
  # Administrative fixture staging precedes route timing; no export/conversion is staged.
  for ext in ['kicad_pcb','kicad_pro','kicad_dru']:shutil.copyfile(fixture/('board.'+ext),work/('board.'+ext))
  target=work/'target-nets.json';target.write_text(json.dumps(job.get('target_nets',[]))+'\n')
  output=work/'output.kicad_pcb'
  values={'input_dir':str(fixture),'work_dir':str(work),'output_pcb':str(output),'seed':str(a.seed),'cap_s':'3600','target_nets_file':str(target)}
  env=os.environ.copy();env.update(HOME=str(home),XDG_CONFIG_HOME=str(home/'config'),XDG_STATE_HOME=str(home/'state'),XDG_CACHE_HOME=str(home/'cache'),XDG_DATA_HOME=str(home/'data'))
  
  for k in ['RAYON_NUM_THREADS','OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS']:env.pop(k,None)
  env.update({k:str(v).format_map(values) for k,v in cfg.get('env',{}).items()})
  record['isolated_environment']={k:env[k] for k in ['HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_DATA_HOME']}
  record['allowed_cpus']=sorted(os.sched_getaffinity(0))
  route_start=time.monotonic();record['route_monotonic_start_ns']=time.monotonic_ns();deadline=route_start+3600
  steps=[('pre-%02d'%i,x) for i,x in enumerate(cfg.get('pre_steps',[]))]+[('route',cfg['command'])]+[('post-%02d'%i,x) for i,x in enumerate(cfg.get('post_steps',[]))]
  for label,argv in steps:
   if time.monotonic()>=deadline:record['status']='did_not_finish';break
   if not isinstance(argv,list) or not argv:raise ValueError('steps must be nonempty argv lists')
   step=command([str(v).format_map(values) for v in argv],label,out,env,work,deadline,cpu);record['steps'].append(step)
   if step['timed_out']:record['status']='did_not_finish';break
   gate_template=cfg.get('support_gate_result',config.get('support_gate_result','{work_dir}/support-gate.json'))
   gate_path=pathlib.Path(str(gate_template).format_map(values))
   if not gate_path.is_absolute():gate_path=work/gate_path
   if gate_path.exists():
    gate=json.loads(gate_path.read_text())
    record['support_gate']={'path':str(gate_path),'sha256':sha(gate_path),'result':gate}
    if gate.get('support')=='no':
     record.update(status='not_supported',support='no',support_reason=gate.get('reason','support gate declined fixture'))
     shutil.copyfile(gate_path,out/'support-gate.json')
     break
   if step['exit_code']:record['status']='step-failed';break
  record['route_monotonic_end_ns']=time.monotonic_ns();record['route_pipeline_seconds']=sum(s['wall_seconds'] for s in record['steps']);record['route_envelope_seconds']=(record['route_monotonic_end_ns']-record['route_monotonic_start_ns'])/1e9;record['peak_tree_rss_kib']=max([s['peak_tree_rss_kib'] for s in record['steps']],default=0)
  if record['status']!='started':return record
  if not output.exists():raise ValueError('native output missing')
  for ext in ['kicad_pcb','kicad_pro','kicad_dru']:
   source=output.with_suffix('.'+ext)
   if not source.exists():raise ValueError('output sidecar missing: '+ext+' (must be a timed post step)')
   shutil.copyfile(source,out/('final.'+ext))
  record['output_sha256']=sha(out/'final.kicad_pcb')
  record['checker']=command(['/usr/bin/python3',str(HERE/'native-check-v4.3.py'),'--fixture',str(fixture),'--output',str(out/'final.kicad_pcb'),'--out',str(out/'check.json')],'check',out,env,work,time.monotonic()+120,cpu)
  record['check_seconds']=record['checker']['wall_seconds'];record['pass']=False
  if record['checker']['exit_code']==0:record['pass']=json.loads((out/'check.json').read_text())['pass'];record['status']='checked'
  else:record['status']='checker-failed'
 except Exception as e:record.update(status='failed',error=str(e),**{'pass':False})
 finally:
  record['utc_end']=utc();record['total_seconds']=(time.monotonic_ns()-begin)/1e9
  (out/'record.json').write_text(json.dumps(record,indent=2)+'\n')
 return record

if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--router',required=True);p.add_argument('--fixture',type=pathlib.Path,required=True);p.add_argument('--attempt',required=True);p.add_argument('--seed',type=int,default=1);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--config-dir',type=pathlib.Path)
 a=p.parse_args()
 for name in [a.router,a.attempt]:
  if not name or pathlib.Path(name).name!=name or name in ['.','..']:p.error('router and attempt must be single directory names')
 print(json.dumps(run(a)))
