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
  if g.GetLayer()==pcbnew.Edge_Cuts:outline.append([int(g.GetShape()),xy(g.GetStart()),xy(g.GetEnd()),xy(g.GetCenter())])
 return {'footprints':sorted(fps,key=str),'pads':sorted(pads,key=str),'outline':sorted(outline,key=str),'layers':[int(i) for i in b.GetEnabledLayers().CuStack()],'zones':b.GetAreaCount()}
def signature(v):
 # Existing pad errors may receive new UUIDs on import: retain type, severity and physical item position.
 return json.dumps([v['type'],v['severity'],sorted([[i.get('pos'),i.get('description')] for i in v.get('items',[])],key=str)],sort_keys=True)
def measure(path,out):
 b=pcbnew.LoadBoard(str(path));base=pcbnew.LoadBoard(str(FIX/'board.kicad_pcb'));truth=snapshot(b);reference=snapshot(base)
 checks={k:truth[k]==reference[k] for k in reference}
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
 result={'native_version':pcbnew.Version(),'board_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'integrity_checks':checks,'integrity_pass':all(checks.values()),'native_opens':opens,'native_total_errors_excluding_opens':len(errors),'inherited_errors':len([v for v in existing if v['severity']=='error']),'new_errors':len(newerrors),'new_error_types':dict(collections.Counter(v['type'] for v in newerrors)),'new_warnings':len(warnings),'new_warning_types':dict(collections.Counter(v['type'] for v in warnings)),'via_count':len(vias),'track_count':len(tracks),'track_length_mm':sum(t.GetLength() for t in tracks)/1e6,'per_net_length_mm':{n:sum(t.GetLength() for t in tracks if t.GetNetname()==n)/1e6 for n in sorted(set(t.GetNetname() for t in tracks))},'native_acceptance':all(checks.values()) and opens==0 and not newerrors,'manufacturing_clean':all(checks.values()) and opens==0 and not errors,'ignored_checks':d['ignored_checks'],'drc_command':args}
 (out/'metrics.json').write_text(json.dumps(result,indent=2)+'\n');return result
if __name__=='__main__':
 mode=sys.argv[1]
 if mode=='import':
  board,session=map(pathlib.Path,sys.argv[2:4]);b=pcbnew.LoadBoard(str(board))
  if not pcbnew.ImportSpecctraSES(b,str(session)):raise RuntimeError('SES import failed')
  pcbnew.SaveBoard(str(board),b)
 elif mode=='score':print(json.dumps(measure(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))
 elif mode=='snapshot':print(json.dumps(snapshot(pcbnew.LoadBoard(sys.argv[2]))))
 else:raise ValueError(mode)
