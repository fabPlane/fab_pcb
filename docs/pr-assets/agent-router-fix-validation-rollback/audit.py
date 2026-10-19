#!/usr/bin/env python3
"""Same tests and stateful adapter fault injection against baseline and candidate.

No live bridge, API endpoint, or KiCad process is used. Installed Bun dependencies
must exist in --repo/node_modules. Output snapshots are disposable and never pushed.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ASSETS = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, default=ASSETS.parents[2])
parser.add_argument('--baseline', default='12b7edb')
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
results = {}
for name in ('before', 'after'):
    snapshot = out / name
    snapshot.mkdir()
    router = snapshot / 'packages/router'
    router.mkdir(parents=True)
    if name == 'before':
        archive = subprocess.check_output(['git', '-C', str(repo), 'archive', args.baseline, 'packages/router/src'])
        with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
            tf.extractall(snapshot, filter='data')
    else:
        shutil.copytree(repo / 'packages/router/src', router / 'src')
    (router / 'test').mkdir()
    for filename in ('bridge-validation.test.ts', 'bridge-validation-fixture.ts', 'collision-fixture.ts'):
        shutil.copy2(repo / 'packages/router/test' / filename, router / 'test' / filename)
    shutil.copy2(ASSETS / 'audit.ts', router / 'audit.ts')
    (snapshot / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    (router / 'node_modules').symlink_to(repo / 'packages/router/node_modules', target_is_directory=True)
    rows = json.loads(subprocess.check_output(['bun', 'run', 'audit.ts'], cwd=router, timeout=120))
    checks = []
    for repeat in range(1, 4):
        run = subprocess.run(['bun', 'test', 'test/bridge-validation.test.ts'], cwd=router,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        (out / f'{name}-tests-{repeat}.log').write_bytes(run.stdout)
        assert run.returncode == (1 if name == 'before' else 0), run.stdout.decode()
        checks.append({'repeat': repeat, 'exitCode': run.returncode})
    hashes = {str(p.relative_to(snapshot)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(snapshot.rglob('*.ts')) if p.is_file()}
    results[name] = {'rows': rows, 'tests': checks, 'sha256': hashes}
    (out / f'{name}-states.json').write_text(json.dumps(rows, indent=2) + '\n')
for name, result in results.items():
    for row in result['rows']:
        scenario = row['scenario']
        if scenario in ('first-check-failure', 'cleanup-retry-failure'):
            assert row['state'] == 'failed'
            assert row['addedCopper'] == (1 if name == 'before' else 0)
            assert row['missingOriginal'] == (1 if name == 'before' and scenario == 'cleanup-retry-failure' else 0)
        elif scenario == 'valid-control':
            assert row['state'] == 'done' and row['addedCopper'] == 1 and row['missingOriginal'] == 0
        else:
            assert row['state'] == 'failed' and row['addedCopper'] == 1
            assert ('rollback failed' in row['error']) == (name == 'after')
results['scope'] = 'stateful adapter fault injection, not native DRC or standalone engine scoring'
results['baseline'] = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', args.baseline], text=True).strip()
results['candidateHead'] = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
(out / 'audit.json').write_text(json.dumps(results, indent=2) + '\n')
print(out / 'audit.json')
