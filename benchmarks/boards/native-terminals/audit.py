# SPDX-License-Identifier: MIT
"""Fresh native DRC snapshots and explicit connection-edge completion.

This standalone audit does not alter the benchmark's ranking or caches.
"""
import hashlib
import json
import math
import os
import signal
import tempfile
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
    seen_edges = set()
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
        endpoints = [(item['uuid'], item['pos']['x'], item['pos']['y'])
                     for item in finding['items']]
        if endpoints[0] == endpoints[1]:
            raise ValueError('native open edge has identical endpoints')
        edge = tuple(sorted(endpoints))
        if edge in seen_edges:
            raise ValueError('duplicate native open edge')
        seen_edges.add(edge)
    findings = report['violations'] + report['schematic_parity']
    if any(f.get('severity') not in ('error', 'warning', 'exclusion') for f in findings):
        raise ValueError('unknown native severity')
    return dict(opens=len(report['unconnected_items']),
                errors=sum(f['severity'] == 'error' for f in findings),
                warnings=sum(f['severity'] == 'warning' for f in findings))


def run_checker(argv, timeout=60):
    """Bound a checker process group, including descendants retaining output FDs.

    Temporary files avoid pipe waits after the direct child exits. Descendants
    must remain in the launched process group; deliberately detached processes
    are outside this local wrapper contract. Only our own group is signalled.
    """
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('checker timeout must be finite and positive')
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(argv, stdout=stdout, stderr=stderr, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        if code:
            # Diagnostics stay private; do not echo potentially sensitive argv/output.
            raise subprocess.CalledProcessError(code, argv)


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
    run_checker([str(executable), 'pcb', 'drc', '--severity-all', '--format', 'json',
                 '-o', str(out), str(board)])
    if identity() != before:
        raise ValueError('native input/tool identity changed during DRC')
    report = json.loads(out.read_text())
    return dict(**counts(report, board), identity=before, report_sha256=digest(out),
                kicad_version=report.get('kicad_version'))
