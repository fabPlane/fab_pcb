# SPDX-License-Identifier: MIT
"""Replay the failed-export experiment against a supplied prior exporter."""
import argparse
import csv
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    before = args.before.resolve()
    after = Path(__file__).resolve().parents[1] / 'export.py'
    if args.out.resolve() in (before, after):
        raise ValueError('evidence output must not replace an exporter script')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.unlink(missing_ok=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix='dense6-export-freshness-') as temp:
        root = Path(temp)
        for repeat in range(1, 4):
            for version, script in [('before', before), ('after', after)]:
                target = root / f'{version}-{repeat}.dsn'
                target.write_text('stale')
                result = subprocess.run([sys.executable, str(script), str(root / 'missing.kicad_pcb'),
                                         str(target)], capture_output=True, timeout=30)
                if result.returncode == 0 or target.exists() != (version == 'before'):
                    raise ValueError(f'unexpected failed-export behavior: {version}/{repeat}')
                rows.append(dict(repeat=repeat, version=version, exit_code=result.returncode,
                                 stale_output_retained=int(target.exists()),
                                 script_sha256=hashlib.sha256(script.read_bytes()).hexdigest()))
    with args.out.open('w') as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print('Failed-load stale output retained: before 3/3, after 0/3')
