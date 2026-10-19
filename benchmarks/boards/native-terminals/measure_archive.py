# SPDX-License-Identifier: MIT
"""Compare native scores before and after relocating original baseline evidence."""
import argparse
import csv
import json
from pathlib import Path
import shutil
from archive import export, load
from baseline import capture, verify
from generate_probes import generate
from terminals import guarded_score


def measure(out, dense=None, repeats=3):
    out.mkdir(parents=True, exist_ok=False)
    generate(out / 'probes')
    cases = [(name, out / 'probes/t3-r0.kicad_pcb',
              out / f'probes/t3-r{edges}.kicad_pcb', 2, rate)
             for name, edges, rate in [('unchanged', 0, 0), ('partial', 1, .5), ('complete', 2, 1)]]
    if dense:
        cases.append(('dense6-unchanged', dense, dense, 439, 0))
    rows = []
    for name, original, candidate, opens, rate in cases:
        for repeat in range(1, repeats + 1):
            run = out / f'{name}-{repeat}'
            run.mkdir()
            source = run / 'source'
            source.mkdir()
            board = source / 'board.kicad_pcb'
            routed = run / 'routed.kicad_pcb'
            for src, dest in [(original, board), (candidate, routed)]:
                shutil.copyfile(src, dest)
                for suffix in ('.kicad_pro', '.kicad_dru'):
                    if src.with_suffix(suffix).exists():
                        shutil.copyfile(src.with_suffix(suffix), dest.with_suffix(suffix))
            baseline = capture(board, source / 'input-drc.json')
            (run / 'original-baseline.json').write_text(json.dumps(baseline, indent=2) + '\n')
            before = guarded_score(baseline, routed, run / 'before-drc.json')
            export(baseline, run / 'archive')
            (run / 'archive').rename(run / 'relocated')
            shutil.rmtree(source)
            try:
                verify(baseline)
            except (ValueError, FileNotFoundError):
                original_path_rejected = True
            else:
                raise ValueError('original paths unexpectedly remain usable')
            rebound = load(run / 'relocated')
            after = guarded_score(rebound, routed, run / 'after-drc.json')
            keys = ('initial_opens', 'remaining_opens', 'completion_rate', 'native_errors',
                    'native_warnings', 'terminal_signature_sha256')
            if any(before[k] != after[k] for k in keys):
                raise ValueError('relocation changed native quality')
            if before['initial_opens'] != opens or before['completion_rate'] != rate:
                raise ValueError('unexpected fixture quality')
            rows.append(dict(case=name, repeat=repeat, initial_opens=opens,
                before_completion=before['completion_rate'], after_completion=after['completion_rate'],
                before_opens=before['remaining_opens'], after_opens=after['remaining_opens'],
                before_errors=before['native_errors'], after_errors=after['native_errors'],
                before_warnings=before['native_warnings'], after_warnings=after['native_warnings'],
                original_paths_rejected=original_path_rejected,
                relocated_verified=True, terminal_sha256=after['terminal_signature_sha256']))
    with (out / 'summary.csv').open('w') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
    print(f'{len(rows)} relocated baseline pairs; native quality unchanged; original paths unavailable')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--dense', type=Path)
    parser.add_argument('--repeats', type=int, default=3, choices=range(1, 11))
    args = parser.parse_args()
    measure(args.out.resolve(), args.dense.resolve() if args.dense else None, args.repeats)
