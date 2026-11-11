import collections,hashlib,json,pathlib,statistics,sys
root=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else pathlib.Path(__file__).resolve().parent
read=lambda p:json.loads(p.read_text())
controls=[read(root/phase/'controls.json') for phase in ('full-before','full-after')]
for c in controls:
 assert c['complete'] and c['controls_preserved'] and not c['interrupted']
 assert c['allowed_cpus']==[20,21,22,23,24,25] and c['seeds']==[1,2,3]
for field in ('order','inputs_sha256','harness_sha256','runtime_sha256','runtime_source_sha256','allowed_cpus','cases','seeds','candidate'):
 assert controls[0][field]==controls[1][field],field
key=lambda row:(row['case'],row['seed'])
before={key(r):r for r in read(root/'full-before/results.json')}
after={key(r):r for r in read(root/'full-after/results.json')}
assert before.keys()==after.keys() and len(before)==78
regressions=[];changes=[];dispositions=collections.Counter();changed_boards=[]
for k,b in before.items():
 a=after[k]
 for name in ('board.dsn','board.ses'):
  assert (root/'full-before'/b['evidence']/'work'/name).read_bytes()==(root/'full-after'/a['evidence']/'work'/name).read_bytes(),(k,name)
 if a['status']!='checked' or a['opens']>b['opens'] or a['new_errors']>b['new_errors'] or (b['passed'] and not a['passed']) or a['failed_fidelity']!=b['failed_fidelity']: regressions.append(k)
 for field in ('fidelity','integrity_checks','ignored_checks','new_warnings','new_warning_types'):
  assert a['check'][field]==b['check'][field],(k,field)
 if a['new_errors']==b['new_errors']:
  assert a['vias']==b['vias'] and abs(a['length_mm']-b['length_mm'])<1e-7,(k,'unchanged copper metrics')
 if any(a[f]!=b[f] for f in ('passed','opens','new_errors','new_error_types','failed_fidelity')): changes.append({'case':k[0],'seed':k[1],'before':{f:b[f] for f in ('passed','opens','new_errors','new_error_types')},'after':{f:a[f] for f in ('passed','opens','new_errors','new_error_types')}})
 work=root/'full-after'/a['evidence']/'work/native-thermal-postprocess'
 disposition=read(work/'postprocess.json');dispositions[disposition['status']]+=1
 if disposition['applied']:
  bundle=read(work/'accepted.json')
  import base64
  for role in ('input','routed','candidate'):
   for f in bundle[role]: assert hashlib.sha256(base64.b64decode(f['base64'])).hexdigest()==f['sha256']
  assert bundle['validation']['accepted'] and bundle['validation']['newErrors']==[]
  assert bundle['validation']['lostTerminalPairs']==bundle['validation']['repair']['lostTerminalPairs']==0
  out=root/'full-after'/a['evidence']/'work/output.kicad_pcb'
  assert out.read_bytes()==base64.b64decode(bundle['candidate'][0]['base64'])
  if bundle['routed'][0]['sha256']!=bundle['candidate'][0]['sha256']:changed_boards.append(k)
 else:
  # Declined search must preserve the exact imported routed board whenever the
  # search froze it before rejecting. Preflight failures also retain this freeze.
  frozen=work/'search/routed/board.kicad_pcb'
  assert frozen.read_bytes()==(root/'full-after'/a['evidence']/'work/output.kicad_pcb').read_bytes()
def aggregate(rows):
 groups=collections.defaultdict(list)
 for r in rows:groups[r['case']].append(r)
 return {'runs':len(rows),'passed':sum(r['passed'] for r in rows),'valid_cases_3of3':sum(len(v)==3 and all(r['passed'] for r in v) for v in groups.values()),'opens':sum(r['opens'] for r in rows),'new_errors':sum(r['new_errors'] for r in rows),'median_route_s':statistics.median(r['seconds'] for r in rows),'median_length_mm':statistics.median(r['length_mm'] for r in rows),'total_vias':sum(r['vias'] for r in rows),'total_length_mm':sum(r['length_mm'] for r in rows)}
result={'before':aggregate(list(before.values())),'after':aggregate(list(after.values())),'regressions':regressions,'changes':changes,'postprocess_statuses':dict(dispositions),'changed_boards':changed_boards,'groups':{}}
for label,case in [('J2small','qrpcard-qrpcard-j2-small'),('J4','qrpcard-qrpcard-j4'),('Aquarius','kitspace-aquarius-j4')]:
 result['groups'][label]={phase:aggregate([r for r in rows.values() if r['case']==case]) for phase,rows in [('before',before),('after',after)]}
assert not regressions,regressions
assert set(changed_boards)=={('qrpcard-qrpcard-j4',s) for s in (1,2,3)}
assert { (c['case'],c['seed']) for c in changes }==set(changed_boards)
(root/'comparison.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
