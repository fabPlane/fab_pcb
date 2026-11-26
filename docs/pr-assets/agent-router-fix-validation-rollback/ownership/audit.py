#!/usr/bin/env python3
"""Repeat identical ownership regressions against the previous PR revision and current source."""
import argparse, hashlib, io, json, shutil, subprocess, tarfile
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
repo = Path(__file__).resolve().parents[4]
a.out.mkdir(parents=True, exist_ok=False)
report = {'scope': 'stateful adapter tests; no live native undo or routing benchmark', 'baseline': 'c332543', 'versions': {}}
for version in ('before', 'after'):
    root = a.out / version
    router = root / 'packages/router'
    router.mkdir(parents=True)
    if version == 'before':
        data = subprocess.check_output(['git', '-C', str(repo), 'archive', 'c332543', 'packages/router/src'])
        with tarfile.open(fileobj=io.BytesIO(data)) as tf:
            tf.extractall(root, filter='data')
    else:
        shutil.copytree(repo / 'packages/router/src', router / 'src')
    (router / 'test').mkdir()
    for name in ('bridge-undo-ownership.test.ts', 'collision-fixture.ts'):
        shutil.copy2(repo / 'packages/router/test' / name, router / 'test' / name)
    (root / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    (router / 'node_modules').symlink_to(repo / 'packages/router/node_modules', target_is_directory=True)
    rows = []
    for repeat in range(1, 4):
        run = subprocess.run(['bun', 'test', 'test/bridge-undo-ownership.test.ts'], cwd=router, capture_output=True, timeout=120)
        output = run.stdout + run.stderr
        (a.out / f'{version}-{repeat}.log').write_bytes(output)
        assert run.returncode == (1 if version == 'before' else 0), output.decode()
        assert (b'2 pass' in output and b'2 fail' in output) if version == 'before' else (b'4 pass' in output and b'0 fail' in output)
        rows.append({'repeat': repeat, 'passed': 2 if version == 'before' else 4, 'failed': 2 if version == 'before' else 0})
    report['versions'][version] = {'runs': rows, 'sha256': {str(f.relative_to(root)): hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(root.rglob('*.ts'))}}
(a.out / 'audit.json').write_text(json.dumps(report, indent=2) + '\n')
