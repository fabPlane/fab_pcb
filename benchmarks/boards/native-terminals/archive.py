# SPDX-License-Identifier: MIT
"""Relocate verified native baseline evidence without trusting original paths."""
import argparse
import copy
import json
from pathlib import Path
import shutil
from baseline import fingerprint, verify


def layout(baseline):
    evidence = {key: baseline[key] for key in ('schema', 'board', 'report', 'snapshot')}
    if evidence['schema'] != 1 or baseline.get('baseline_id') != fingerprint(evidence):
        raise ValueError('archive baseline identity mismatch')
    board = Path(baseline['board'])
    if not board.is_absolute() or board.suffix != '.kicad_pcb':
        raise ValueError('archive requires an absolute native board identity')
    inputs = [board, board.with_suffix('.kicad_pro'), board.with_suffix('.kicad_dru')]
    identities = baseline['snapshot']['identity']
    tools = set(identities) - {str(p) for p in inputs}
    if len(identities) != 4 or len(tools) != 1 or not all(str(p) in identities for p in inputs):
        raise ValueError('archive requires exactly one checker and three input identities')
    checker = next(iter(tools))
    if not Path(checker).is_absolute() or identities[str(board)] is None or identities[checker] is None:
        raise ValueError('archive lacks board/checker identity')
    return inputs, checker


def load(root):
    """Verify archived bytes and the current checker; rebind only known input paths.

    The original baseline is retained verbatim. Rebinding creates a new path-bound
    baseline ID; callers must not reuse a score/cache entry under the original ID.
    No DRC is rerun here: guarded_score still requires fresh output validation.
    """
    root = Path(root).absolute()
    if root.is_symlink():
        raise ValueError('archive root must not be a symbolic link')
    manifest = root / 'archive.json'
    if manifest.is_symlink():
        raise ValueError('archive manifest must not be a symbolic link')
    data = json.loads(manifest.read_text())
    if set(data) != {'schema', 'baseline'} or data['schema'] != 1:
        raise ValueError('unknown native archive schema')
    original = data['baseline']
    inputs, _ = layout(original)
    if (root / 'input').is_symlink():
        raise ValueError('archive input directory must not be a symbolic link')
    mapped = {str(p): str((root / 'input' / p.name).resolve()) for p in inputs}
    report = root / 'input-drc.json'
    for path in [report, *(root / 'input' / p.name for p in inputs)]:
        if path.is_symlink():
            raise ValueError('archive evidence must not be a symbolic link')
    rebound = copy.deepcopy(original)
    rebound['board'] = mapped[str(inputs[0])]
    rebound['report'] = str(report.resolve())
    rebound['snapshot']['identity'] = {
        mapped.get(path, path): sha for path, sha in original['snapshot']['identity'].items()}
    # Checker identity is external and unchanged, never copied or remapped.
    rebound['baseline_id'] = fingerprint({k: v for k, v in rebound.items() if k != 'baseline_id'})
    verify(rebound)
    return rebound


def export(baseline, destination):
    """Copy verified baseline bytes into a fresh portable directory; retain provenance."""
    inputs, _ = layout(baseline)
    verify(baseline)
    destination = Path(destination).absolute()
    destination.mkdir(parents=True, exist_ok=False)
    (destination / 'input').mkdir()
    for path in inputs:
        if baseline['snapshot']['identity'][str(path)] is not None:
            shutil.copyfile(path, destination / 'input' / path.name)
    shutil.copyfile(baseline['report'], destination / 'input-drc.json')
    (destination / 'archive.json').write_text(json.dumps(
        dict(schema=1, baseline=baseline), indent=2) + '\n')
    verify(baseline)
    return load(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    original = json.loads(Path(args.baseline).read_text())
    rebound = export(original, args.out)
    print(json.dumps(dict(original_baseline_id=original['baseline_id'],
                         relocated_baseline_id=rebound['baseline_id'])))


if __name__ == '__main__':
    main()
