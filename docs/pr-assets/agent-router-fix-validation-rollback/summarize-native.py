#!/usr/bin/env python3
"""Compare complete sweeps; standalone harness bypasses the changed job adapter."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import statistics

p = argparse.ArgumentParser()
p.add_argument('--before', type=Path, required=True)
p.add_argument('--after', type=Path, required=True)
p.add_argument('--engine-source', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
controls = {}
results = {}
summary = {}
for name, root in [('before', a.before), ('after', a.after)]:
    c = json.loads((root/'controls.json').read_text())
    rows = json.loads((root/'results.json').read_text())
    assert c['complete'] and c['controls_preserved'] and len(rows) == 78
    assert c['allowed_cpus'] == list(range(20, 26))
    assert all(r['status'] == 'checked' and r['router'] == 'fab-router' for r in rows)
    cases = defaultdict(list)
    for r in rows:
        cases[r['case']].append(r)
    assert len(cases) == 26 and all(len(rs) == 3 for rs in cases.values())
    summary[name] = dict(passed=sum(r['passed'] for r in rows), runs=len(rows),
        valid_cases_3of3=sum(all(r['passed'] for r in rs) for rs in cases.values()),
        opens=sum(r['opens'] for r in rows), new_errors=sum(r['new_errors'] for r in rows),
        median_route_s=statistics.median(r['seconds'] for r in rows),
        cases={case: {key:sum(r[key] for r in rs) for key in ('passed','opens','new_errors')}
               for case,rs in sorted(cases.items())})
    controls[name], results[name] = c, rows
for key in ('order', 'routers', 'cases', 'seeds', 'inputs_sha256', 'configs_sha256',
            'harness_sha256', 'runtime_sha256', 'runtime_source_sha256', 'allowed_cpus', 'model'):
    assert controls['before'][key] == controls['after'][key], key
assert controls['before']['candidate']['source_sha256'] == controls['after']['candidate']['source_sha256']
for file, digest in controls['after']['candidate']['source_sha256'].items():
    assert hashlib.sha256((a.engine_source/file).read_bytes()).hexdigest() == digest, file
for left,right in zip(results['before'], results['after']):
    for key in ('case','seed','passed','opens','new_errors','new_error_types','vias','length_mm','failed_fidelity'):
        assert left[key] == right[key], (left['case'],left['seed'],key)
output = {
    'scope': 'Standalone native engine context only: the harness bypasses packages/router/src/bridge-job.ts. No rollback coverage or thermal improvement is claimed.',
    'machine': 'hyper-ms-lin', 'repeats_per_case': 3, 'attempt_outcomes_and_copper_identical': True,
    'summary': summary, 'controls': controls, 'attempts': results,
}
a.out.write_text(json.dumps(output, indent=2)+'\n')
print(json.dumps(summary, indent=2))
