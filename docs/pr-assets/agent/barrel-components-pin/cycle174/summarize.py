"""Summarize two untouched standalone benchmark outputs; no routing or scoring edits."""
import hashlib
import json
import statistics
import sys
from pathlib import Path

out = Path(__file__).resolve().parent
summary = {}
for label, source in zip(('before', 'after'), sys.argv[1:3], strict=True):
    root = Path(source)
    controls = json.loads((root / 'controls.json').read_text())
    status = json.loads((root / 'summary.json').read_text())
    assert status['complete'] and status['controls_preserved']
    rows = json.loads((root / 'results.json').read_text())
    assert len(rows) == 6 and all(r['status'] == 'checked' for r in rows)
    assert all(r['passed'] and r['opens'] == 0 and r['new_errors'] == 0 and not r['failed_fidelity'] for r in rows)
    summary[label] = {
        'allowed_cpus': controls['allowed_cpus'],
        'inputs_sha256': controls['inputs_sha256'],
        'harness_sha256': controls['harness_sha256'],
        'candidate_commit': controls.get('candidate', {}).get('commit', '69cf598db98c136bff16bbe02bccdded95674b18'),
        'evidence_sha256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                            for name in ('controls.json', 'results.json', 'summary.json')},
        'runs': [{k: r[k] for k in ('case', 'seed', 'passed', 'seconds', 'vias', 'length_mm', 'opens', 'new_errors', 'failed_fidelity')}
                 for r in sorted(rows, key=lambda r: (r['case'], r['seed']))],
    }
assert summary['before']['inputs_sha256'] == summary['after']['inputs_sha256']
assert summary['before']['harness_sha256'] == summary['after']['harness_sha256']
assert summary['before']['allowed_cpus'] == summary['after']['allowed_cpus'] == list(range(6, 12))
(out / 'measurements.json').write_text(json.dumps(summary, indent=2) + '\n')
for case in sorted({r['case'] for r in summary['before']['runs']}):
    print(case)
    for label in summary:
        rows = [r for r in summary[label]['runs'] if r['case'] == case]
        print(label, 'passed', sum(r['passed'] for r in rows), 'median_s', statistics.median(r['seconds'] for r in rows),
              'vias', [r['vias'] for r in rows], 'length_mm', [r['length_mm'] for r in rows])

import subprocess
parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="430"><rect width="1000" height="430" fill="white"/>',
         '<g font-family="sans-serif" fill="#203047"><text x="40" y="35" font-size="22">Further frozen subset: native valid 3/3 before and after on both cases</text>',
         '<text x="40" y="65" font-size="16">Median route seconds; six-core affinity; three repeats; no speed gain claimed</text>']
scale = 550 / max(r['seconds'] for v in summary.values() for r in v['runs'])
for i, case in enumerate(sorted({r['case'] for r in summary['before']['runs']})):
    y = 115 + i * 95
    short = case.replace('kitspace-solenoid-driver-', 'Solenoid ').replace('nextbusclock-nextbusclockv1-', 'Clock ').replace('kitspace-lcr-addon-', 'LCR ')
    parts.append(f'<text x="40" y="{y}" font-size="18">{short}</text>')
    for j, (label, color) in enumerate((('before', '#506f9a'), ('after', '#319379'))):
        median = statistics.median(r['seconds'] for r in summary[label]['runs'] if r['case'] == case)
        yy = y - 15 + j * 30
        parts.append(f'<rect x="260" y="{yy}" width="{median * scale}" height="23" fill="{color}"/><text x="{270 + median * scale}" y="{yy + 18}" font-size="16">{label} {median:.3f}s</text>')
parts.append('</g></svg>')
(out / 'benchmark.svg').write_text(''.join(parts))
subprocess.run(['rsvg-convert', '-w', '1600', str(out / 'benchmark.svg'), '-o', str(out / 'benchmark.png')], check=True)
