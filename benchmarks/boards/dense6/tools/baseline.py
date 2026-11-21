# SPDX-License-Identifier: MIT
"""Reusable native baseline evidence; no ranked-harness integration yet."""
import hashlib
import json
from pathlib import Path
from audit import completion, counts, digest, snapshot


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def capture(board, report, cli='kicad-cli'):
    """Capture original input evidence before any routing, suitable for JSON storage."""
    evidence = dict(schema=1, board=str(Path(board).resolve()),
                    report=str(Path(report).resolve()), snapshot=snapshot(board, report, cli))
    return dict(evidence, baseline_id=fingerprint(evidence))


def verify(baseline):
    """Reject stale input, rules, checker or report evidence rather than using nets."""
    evidence = {key: baseline[key] for key in ('schema', 'board', 'report', 'snapshot')}
    if evidence['schema'] != 1 or baseline.get('baseline_id') != fingerprint(evidence):
        raise ValueError('native baseline identity mismatch')
    saved = evidence['snapshot']
    board, report = Path(evidence['board']), Path(evidence['report'])
    required = {str(board), str(board.with_suffix('.kicad_pro')), str(board.with_suffix('.kicad_dru'))}
    if not required <= set(saved['identity']) or len(saved['identity']) != 4:
        raise ValueError('native baseline lacks input/rules/checker identities')
    if saved['identity'][str(board)] is None:
        raise ValueError('native baseline input is missing')
    if digest(report) != saved['report_sha256']:
        raise ValueError('native baseline report changed')
    actual = counts(json.loads(report.read_text()), board)
    if any(saved[key] != actual[key] for key in ('opens', 'errors', 'warnings')):
        raise ValueError('native baseline counts do not match report')
    for path, expected in saved['identity'].items():
        current = digest(path) if Path(path).exists() else None
        if current != expected:
            raise ValueError('native baseline input, rules or checker changed')
    return saved


def score(baseline, routed_board, report, cli='kicad-cli'):
    """Score fresh routed DRC against verified original edges and matching rules/tool.

    The routed board must carry the same project/custom-rule bytes (including
    absence) as the input. Callers retain the baseline JSON and original report
    alongside results. This helper deliberately has no net-count fallback.
    """
    initial = verify(baseline)
    # Output may not overwrite any persisted baseline evidence, even via aliases.
    output = Path(report).resolve()
    protected = [Path(baseline['report']), *(Path(p) for p in initial['identity'])]
    if any(output == p.resolve() or (output.exists() and p.exists() and output.samefile(p))
           for p in protected):
        raise ValueError('routed report aliases baseline evidence')
    routed = snapshot(routed_board, report, cli)
    verify(baseline)
    original_board, routed_board = Path(baseline['board']), Path(routed_board).resolve()
    for suffix in ('.kicad_pro', '.kicad_dru'):
        if initial['identity'][str(original_board.with_suffix(suffix))] != routed['identity'][str(routed_board.with_suffix(suffix))]:
            raise ValueError('routed native rules differ from baseline')
    original_tools = {p: sha for p, sha in initial['identity'].items()
                      if p not in {str(original_board), str(original_board.with_suffix('.kicad_pro')),
                                   str(original_board.with_suffix('.kicad_dru'))}}
    routed_tools = {p: sha for p, sha in routed['identity'].items()
                    if p not in {str(routed_board), str(routed_board.with_suffix('.kicad_pro')),
                                 str(routed_board.with_suffix('.kicad_dru'))}}
    if original_tools != routed_tools or initial['kicad_version'] != routed['kicad_version']:
        raise ValueError('routed native checker differs from baseline')
    return dict(baseline_id=baseline['baseline_id'], initial_opens=initial['opens'],
                remaining_opens=routed['opens'],
                completion_rate=completion(initial['opens'], routed['opens']),
                native_errors=routed['errors'], native_warnings=routed['warnings'],
                snapshot=routed)
