#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Native KiCad import, geometry acceptance and measurements; no model dependency."""
import pcbnew,json,pathlib,sys,subprocess,hashlib,collections
ROOT=pathlib.Path(__file__).resolve().parents[3]
FIX=ROOT/'evidence/ch340g-eight-router-setup-2026-10-09/fixture'
def xy(p):return [p.x,p.y]
def snapshot(b):
 pads=[];fps=[];outline=[]
 for f in b.GetFootprints():
  fps.append([f.GetReference(),f.GetValue(),f.GetFPIDAsString(),xy(f.GetPosition()),round(f.GetOrientationDegrees(),6),f.GetLayer()])
  for p in f.Pads():
   pads.append([f.GetReference(),p.GetNumber(),p.GetNetname(),xy(p.GetPosition()),xy(p.GetSize()),round(p.GetOrientationDegrees()%180,6),int(p.GetShape()),int(p.GetAttribute()),xy(p.GetDrillSize()),[i for i in b.GetEnabledLayers().CuStack() if p.IsOnLayer(i)]])
 for g in b.GetDrawings():
  if g.GetLayer()==pcbnew.Edge_Cuts:
   if hasattr(g,'GetStart'):outline.append([int(g.GetShape()),xy(g.GetStart()),xy(g.GetEnd()),xy(g.GetCenter())])
   else:
    # Preserve source crosshair targets as edge items; they are not line segments.
    item=[g.GetClass(),int(g.GetShape()),xy(g.GetPosition())]
    for method in ['GetSize','GetWidth']:
     if hasattr(g,method):
      value=getattr(g,method)();item.append([method,xy(value) if hasattr(value,'x') else int(value)])
    outline.append(item)
 return {'footprints':sorted(fps,key=str),'pads':sorted(pads,key=str),'outline':sorted(outline,key=str),'layers':[int(i) for i in b.GetEnabledLayers().CuStack()],'zones':b.GetAreaCount()}
def signature(v):
 # Existing pad errors may receive new UUIDs on import: retain type, severity and physical item position.
 return json.dumps([v['type'],v['severity'],sorted([[i.get('pos'),i.get('description')] for i in v.get('items',[])],key=str)],sort_keys=True)
POSITION_TOLERANCE_NM=1000

def position_rows_equal(expected,actual,position_index):
 # Multiset match retaining every other field, including row multiplicity.
 def key(row):return json.dumps(row[:position_index]+row[position_index+1:],sort_keys=True)
 groups=collections.defaultdict(list)
 for row in actual:groups[key(row)].append(row[position_index])
 for row in expected:
  positions=groups[key(row)];xy=row[position_index]
  matches=[(i,sum((a-b)**2 for a,b in zip(xy,p))) for i,p in enumerate(positions) if sum((a-b)**2 for a,b in zip(xy,p))<=POSITION_TOLERANCE_NM**2]
  if not matches:return False
  i,_=min(matches,key=lambda x:x[1]);positions.pop(i)
 return not any(groups.values())

def measure(path,out,fixture):
 global FIX
 FIX=fixture
 out.mkdir(parents=True,exist_ok=True)
 b=pcbnew.LoadBoard(str(path));base=pcbnew.LoadBoard(str(FIX/'board.kicad_pcb'));truth=snapshot(b);reference=snapshot(base)
 checks={k:truth[k]==reference[k] for k in reference}
 checks['footprints']=position_rows_equal(reference['footprints'],truth['footprints'],3)
 checks['pads']=position_rows_equal(reference['pads'],truth['pads'],3)
 for ext in ['kicad_pro','kicad_dru']:
  target=path.with_suffix('.'+ext);checks[ext+'_preserved']=target.exists() and target.read_bytes()==(FIX/('board.'+ext)).read_bytes()
 args=['/usr/bin/kicad-cli','pcb','drc','--severity-all','--format','json','-o',str(out/'drc.json'),str(path)]
 p=subprocess.run(args,capture_output=True,timeout=120);(out/'drc.stdout.log').write_bytes(p.stdout);(out/'drc.stderr.log').write_bytes(p.stderr)
 if p.returncode or not (out/'drc.json').exists():raise RuntimeError('native DRC command failed')
 d=json.loads((out/'drc.json').read_text());before=json.loads((FIX/'baseline-drc.json').read_text())
 counts=collections.Counter(signature(v) for v in before['violations']);new=[];existing=[]
 for v in d['violations']:
  key=signature(v)
  if counts[key]>0:counts[key]-=1;existing.append(v)
  else:new.append(v)
 checks['checker_policy_preserved']=d['ignored_checks']==before['ignored_checks'] and d['included_severities']==before['included_severities']
 tracks=[t for t in b.GetTracks() if not isinstance(t,pcbnew.PCB_VIA)];vias=[t for t in b.GetTracks() if isinstance(t,pcbnew.PCB_VIA)]
 newerrors=[v for v in new if v['severity']=='error'];errors=[v for v in d['violations'] if v['severity']=='error'];warnings=[v for v in new if v['severity']=='warning'];opens=len(d['unconnected_items'])
 result={'native_version':pcbnew.Version(),'board_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'integrity_checks':checks,'integrity_pass':all(checks.values()),'native_opens':opens,'native_total_errors_excluding_opens':len(errors),'inherited_errors':len([v for v in existing if v['severity']=='error']),'new_errors':len(newerrors),'new_error_details':newerrors,'new_warning_details':warnings,'new_error_types':dict(collections.Counter(v['type'] for v in newerrors)),'new_warnings':len(warnings),'new_warning_types':dict(collections.Counter(v['type'] for v in warnings)),'via_count':len(vias),'track_count':len(tracks),'track_length_mm':sum(t.GetLength() for t in tracks)/1e6,'per_net_length_mm':{n:sum(t.GetLength() for t in tracks if t.GetNetname()==n)/1e6 for n in sorted(set(t.GetNetname() for t in tracks))},'native_acceptance':all(checks.values()) and opens==0 and not newerrors,'manufacturing_clean':all(checks.values()) and opens==0 and not errors,'ignored_checks':d['ignored_checks'],'drc_command':args}
 (out/'metrics.json').write_text(json.dumps(result,indent=2)+'\n');return result

def copper_key(t):
 via=isinstance(t,pcbnew.PCB_VIA)
 ends=sorted([xy(t.GetStart()),xy(t.GetEnd())])
 geometry=['via',xy(t.GetPosition()),int(t.GetViaType()),int(t.TopLayer()),int(t.BottomLayer()),t.GetDrillValue()] if via else ['arc' if isinstance(t,pcbnew.PCB_ARC) else 'segment',ends,int(t.GetLayer())]
 if isinstance(t,pcbnew.PCB_ARC):geometry.append(xy(t.GetMid()))
 return json.dumps([geometry,t.GetWidth(),t.GetNetname()],sort_keys=True)

def copper_check(base,b,target):
 before=collections.Counter(copper_key(t) for t in base.GetTracks() if t.GetNetname() not in target)
 after=collections.Counter(copper_key(t) for t in b.GetTracks() if t.GetNetname() not in target)
 missing=before-after; added=after-before
 # Classify same topology/position changes separately; exact multiset is the gate.
 narrowed=[];moved=[]
 for old,n in missing.items():
  og,ow,on=json.loads(old)
  for new,m in added.items():
   ng,nw,nn=json.loads(new)
   if on==nn and og==ng and nw<ow:narrowed.append({'before':json.loads(old),'after':json.loads(new),'count':min(n,m)})
   elif on==nn and ow==nw and og[0]==ng[0]:moved.append({'before':json.loads(old),'candidate_after':json.loads(new)})
 return {'pass':before==after,'missing':[{'item':json.loads(k),'count':v} for k,v in missing.items()],'duplicated':[{'item':json.loads(k),'count':v} for k,v in added.items() if k in before],'unexpected':[{'item':json.loads(k),'count':v} for k,v in added.items() if k not in before],'moved':moved,'moved_classification':'candidate geometric matches; exact missing/unexpected multisets are authoritative','narrowed':narrowed,'expected_count':sum(before.values()),'actual_count':sum(after.values())}

def sexpr(text):
 import re
 tokens=re.findall(r'"(?:\\.|[^"\\])*"|[^\s()]+|[()]',text)
 stack=[];root=None
 for token in tokens:
  if token=='(':
   node=[]
   if stack:stack[-1].append(node)
   else:root=node
   stack.append(node)
  elif token==')':stack.pop()
  else:stack[-1].append(token)
 return root

def definitions(path,kind):
 tree=sexpr(path.read_text())
 def clean(node):
  if not isinstance(node,list):return node
  return [clean(v) for v in node if not (isinstance(v,list) and v and v[0] in ['uuid','tstamp','filled_polygon','fill_segments','island'])]
 return sorted([clean(v) for v in tree if isinstance(v,list) and v and v[0]==kind],key=str)

def evaluate(fixture,path,outfile):
 outfile.parent.mkdir(parents=True,exist_ok=True)
 job=json.loads((fixture/'job.json').read_text()) if (fixture/'job.json').exists() else {'job':'J1','role':'tuning'}
 kind=job['job'];base=pcbnew.LoadBoard(str(fixture/'board.kicad_pcb'));raw=pcbnew.LoadBoard(str(path))
 zone_same=definitions(fixture/'board.kicad_pcb','zone')==definitions(path,'zone')
 checked=path
 if raw.GetAreaCount()>0:
  # Work only on a copy; refill belongs to independent checking, never repair raw output.
  checked=outfile.parent/'refilled.kicad_pcb'
  import shutil
  shutil.copyfile(path,checked)
  import shutil
  for ext in ['kicad_pro','kicad_dru']:
   if path.with_suffix('.'+ext).exists():shutil.copyfile(path.with_suffix('.'+ext),checked.with_suffix('.'+ext))
  refill_args=['/usr/bin/kicad-cli','pcb','drc','--severity-all','--format','json','--refill-zones','--save-board','-o',str(outfile.parent/'refill-drc.json'),str(checked)]
  refill=subprocess.run(refill_args,capture_output=True,timeout=120)
  (outfile.parent/'refill.stdout.log').write_bytes(refill.stdout);(outfile.parent/'refill.stderr.log').write_bytes(refill.stderr)
  if refill.returncode:raise RuntimeError('native refill failed')
 r=measure(checked,outfile.parent,fixture); b=pcbnew.LoadBoard(str(checked));checks=r['integrity_checks']
 checks['nets']=sorted(n.GetNetname() for n in base.GetNetInfo().NetsByNetcode().values())==sorted(n.GetNetname() for n in b.GetNetInfo().NetsByNetcode().values())
 checks['zone_definition']=zone_same
 checks['board_setup']=definitions(fixture/'board.kicad_pcb','setup')==definitions(path,'setup')
 extra=True
 if kind=='J2':
  r['kept_copper']=copper_check(base,b,set(job['target_nets']));extra &= r['kept_copper']['pass']
 tracks=[t for t in b.GetTracks() if not isinstance(t,pcbnew.PCB_VIA)]
 vias=[t for t in b.GetTracks() if isinstance(t,pcbnew.PCB_VIA)]
 if kind=='J3':
  power=job.get('power_nets',[])
  if isinstance(power,dict):power=[{'name':n,'min_width_mm':w} for n,w in power.items()]
  violations=[]
  for spec in power:
   name=spec.get('name',spec.get('net'));minimum=spec.get('min_width_mm',spec.get('minimum_width_mm'))
   if minimum is None:raise ValueError('power_nets requires min_width_mm')
   for t in tracks:
    if t.GetNetname()==name and t.GetWidth()<pcbnew.FromMM(minimum):violations.append({'net':name,'width_mm':pcbnew.ToMM(t.GetWidth()),'min_width_mm':minimum,'item':json.loads(copper_key(t))})
  r['power_width_violations']=violations;r['pairs']=[];extra &= not violations
  d=json.loads((outfile.parent/'drc.json').read_text())
  for pair in job.get('pairs',[]):
   names=[pair['p'],pair['n']];lengths=[r['per_net_length_mm'].get(n,0) for n in names];vc=[sum(t.GetNetname()==n for t in vias) for n in names]
   # Native unconnected records identify physical net names in item descriptions.
   opens=[u for u in d['unconnected_items'] if any('['+n+']' in i.get('description','') for n in names for i in u.get('items',[]))]
   present=all(any(p.GetNetname()==n for f in b.GetFootprints() for p in f.Pads()) for n in names)
   result=dict(pair,length_mm=dict(zip(names,lengths)),length_diff_mm=abs(lengths[0]-lengths[1]),via_counts=dict(zip(names,vc)),via_diff=abs(vc[0]-vc[1]),connected=present and not opens)
   result['pass']=result['connected'] and ('max_length_diff_mm' not in pair or result['length_diff_mm']<=pair['max_length_diff_mm']) and ('max_via_diff' not in pair or result['via_diff']<=pair['max_via_diff'])
   r['pairs'].append(result);extra &= result['pass']
 if kind=='J4':
  d=json.loads((outfile.parent/'drc.json').read_text());ground={z.GetNetname() for z in base.Zones() if not z.GetIsRuleArea()}
  islands=[]
  for z in b.Zones():
   for layer in z.GetLayerSet().Seq():
    if z.HasFilledPolysForLayer(layer):
     for i in range(z.GetFilledPolysList(layer).OutlineCount()):
      if z.IsIsland(layer,i):islands.append({'net':z.GetNetname(),'layer':int(layer),'polygon':i})
  # Components of ground copper must reach a ground pad, even if native DRC only warns.
  b.BuildConnectivity();conn=b.GetConnectivity();orphan=[]
  for t in b.GetTracks():
   if t.GetNetname() in ground and not any(isinstance(i,pcbnew.PAD) for i in conn.GetConnectedItems(t)):orphan.append(json.loads(copper_key(t)))
  gopens=[u for u in d['unconnected_items'] if any('['+n+']' in i.get('description','') for n in ground for i in u.get('items',[]))]
  island_errors=[v for v in d['violations'] if 'island' in v['type'] or 'isolated' in v['type']]
  r.update(zone_preserved=zone_same,ground_connected=not (gopens or orphan or islands or island_errors),island_findings={'filled_islands':islands,'orphan_copper':orphan,'native_findings':island_errors,'ground_opens':gopens},refilled_board_sha256=hashlib.sha256(checked.read_bytes()).hexdigest())
  extra &= r['zone_preserved'] and r['ground_connected']
 r.update({'pass':all(checks.values()) and r['native_opens']==0 and r['new_errors']==0 and bool(extra),'opens':r['native_opens'],'fidelity':checks,'vias':r['via_count'],'length_mm':r['track_length_mm'],'job':kind,'raw_output_sha256':hashlib.sha256(path.read_bytes()).hexdigest()})

 r['integrity_pass']=all(checks.values());r['native_acceptance']=r['pass'];r['manufacturing_clean']=r['pass'] and r['native_total_errors_excluding_opens']==0
 outfile.write_text(json.dumps(r,indent=2)+'\n');(outfile.parent/'metrics.json').write_text(json.dumps(r,indent=2)+'\n');return r

if __name__ == '__main__':
 import argparse
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--fixture',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True)
 a=p.parse_args()
 try:evaluate(a.fixture.resolve(),a.output.resolve(),a.out.resolve())
 except Exception as e:
  a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps({'pass':False,'checker_error':str(e)},indent=2)+'\n');raise
