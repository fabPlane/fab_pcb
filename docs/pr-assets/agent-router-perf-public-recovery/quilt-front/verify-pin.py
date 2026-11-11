"""Verify immutable engine pin bytes against the measured source inventory."""
from pathlib import Path
import hashlib,io,json,subprocess,sys,tarfile
here=Path(__file__).resolve().parent;engine=Path(sys.argv[1]).resolve();audit=json.loads((here/'pin-source-audit.json').read_text())
for mode,ref,key in [('old',audit['oldPin'],'measuredOriginal'),('new',audit['newPin'],'measuredCandidate')]:
 raw=subprocess.check_output(['git','archive',ref,'src','spec','tools','package.json','tsconfig.json'],cwd=engine);hashes={}
 with tarfile.open(fileobj=io.BytesIO(raw)) as t:
  for member in t.getmembers():
   if member.isfile():hashes[member.name]=hashlib.sha256(t.extractfile(member).read()).hexdigest()
 assert hashes.keys()==audit['files'].keys()
 assert all(hashes[name]==pair[key]for name,pair in audit['files'].items()),mode
assert [n for n,p in audit['files'].items()if p['measuredOriginal']!=p['measuredCandidate']]==['src/route/quilt.ts']
for name,digest in json.loads((here/'manifest.json').read_text()).items():assert hashlib.sha256((here/name).read_bytes()).hexdigest()==digest,name
print('PASS all 1501 immutable pin runtime/spec/tool/package/config hashes and evidence manifest')
