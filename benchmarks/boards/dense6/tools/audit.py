# SPDX-License-Identifier: MIT
"""Fresh native DRC snapshots and explicit connection-edge completion.

This standalone audit does not alter the benchmark's ranking or caches.
"""
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def completion(initial, remaining):
    for value in (initial, remaining):
        if type(value) is not int or value < 0:
            raise ValueError('native open counts must be nonnegative integers')
    return max(0.0, 1 - remaining / initial) if initial else float(remaining == 0)


def counts(report, board):
    if report.get('source') != Path(board).name or report.get('coordinate_units') != 'mm':
        raise ValueError('native report source or units mismatch')
    if not {'error', 'warning'} <= set(report.get('included_severities', [])):
        raise ValueError('native report must include errors and warnings')
    for key in ('violations', 'unconnected_items', 'schematic_parity'):
        if not isinstance(report.get(key), list):
            raise ValueError('native report missing findings section')
    for finding in report['unconnected_items']:
        if (finding.get('type') != 'unconnected_items' or finding.get('severity') != 'error'
                or len(finding.get('items', [])) != 2):
            raise ValueError('malformed native open edge')
        for item in finding['items']:
            if not isinstance(item.get('uuid'), str) or not item['uuid']:
                raise ValueError('missing native endpoint identity')
            if any(type(item.get('pos', {}).get(axis)) not in (int, float)
                   or not math.isfinite(item['pos'][axis]) for axis in ('x', 'y')):
                raise ValueError('invalid native endpoint position')
    findings = report['violations'] + report['schematic_parity']
    if any(f.get('severity') not in ('error', 'warning', 'exclusion') for f in findings):
        raise ValueError('unknown native severity')
    return dict(opens=len(report['unconnected_items']),
                errors=sum(f['severity'] == 'error' for f in findings),
                warnings=sum(f['severity'] == 'warning' for f in findings))


def snapshot(board, out, cli='kicad-cli'):
    board, out = Path(board).resolve(), Path(out).resolve()
    # Check all identities before and after DRC, including absent rule sidecars.
    executable = Path(shutil.which(cli) or cli).resolve()
    paths = [board, board.with_suffix('.kicad_pro'), board.with_suffix('.kicad_dru'), executable]
    # Resolve symbolic aliases and detect hard links before removing stale output.
    # An output path may never name an input, a rule sidecar, or the checker.
    if any(out == p.resolve() or (out.exists() and p.exists() and out.samefile(p)) for p in paths):
        raise ValueError('native report destination aliases an input or tool')
    out.parent.mkdir(parents=True, exist_ok=True)
    identity = lambda: {str(p): digest(p) if p.exists() else None for p in paths}
    before = identity()
    out.unlink(missing_ok=True)
    subprocess.run([str(executable), 'pcb', 'drc', '--severity-all', '--format', 'json',
                    '-o', str(out), str(board)], check=True, timeout=60, capture_output=True)
    if identity() != before:
        raise ValueError('native input/tool identity changed during DRC')
    report = json.loads(out.read_text())
    return dict(**counts(report, board), identity=before, report_sha256=digest(out),
                kicad_version=report.get('kicad_version'))
