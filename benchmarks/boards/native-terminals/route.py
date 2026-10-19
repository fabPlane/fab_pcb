# SPDX-License-Identifier: MIT
"""Run an offline native-board router with input evidence and guarded scoring."""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from baseline import capture, verify
from terminals import guarded_score


def run(board, out, command, timeout=60, cli='kicad-cli'):
    """Own a fresh artifact directory; never reuse a board or cached score.

    The command receives private input/output paths through literal {input} and
    {output} arguments. It must produce a native board, importing sessions itself.
    Router time excludes baseline capture and final native validation.
    """
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError('router timeout must be finite and positive')
    if not command or not any('{input}' in arg for arg in command) or not any('{output}' in arg for arg in command):
        raise ValueError('router command requires {input} and {output} placeholders')
    board, out = Path(board).resolve(strict=True), Path(out).absolute()
    # mkdir must fail even for an empty existing directory or symbolic alias.
    out.mkdir(parents=True, exist_ok=False)
    source = out / 'input' / 'board.kicad_pcb'
    source.parent.mkdir()
    shutil.copyfile(board, source)
    for suffix in ('.kicad_pro', '.kicad_dru'):
        sidecar = board.with_suffix(suffix)
        if sidecar.exists():
            shutil.copyfile(sidecar, source.with_suffix(suffix))
    result = dict(schema=1, state='crash', quality_validation='unavailable')
    try:
        baseline = capture(source, out / 'input-drc.json', cli)
        (out / 'baseline.json').write_text(json.dumps(baseline, indent=2) + '\n')
        routed = out / 'output' / 'board.kicad_pcb'
        routed.parent.mkdir()
        argv = [arg.replace('{input}', str(source)).replace('{output}', str(routed)) for arg in command]
        started = time.monotonic()
        # A process group bounds wrappers and their router/import subprocesses.
        with (out / 'router.stdout').open('wb') as stdout, (out / 'router.stderr').open('wb') as stderr:
            process = subprocess.Popen(argv, cwd=out, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                result['state'] = 'timeout'
                raise
            finally:
                # Also reap descendants left behind by a wrapper that exited.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        result['route_s'] = time.monotonic() - started
        if code != 0:
            raise ValueError(f'router command exited {code}; partial output is diagnostic only')
        if not routed.is_file() or routed.is_symlink() or routed.samefile(source):
            raise ValueError('router must produce a fresh independent native board')
        verify(baseline)
        # Importers must preserve project/custom-rule evidence. Never replace
        # their output rules here: that would conceal an invalid transformation.
        quality = guarded_score(baseline, routed, out / 'output-drc.json', cli)
        result.update(state='completed', quality_validation='native-drc', quality=quality)
    except Exception as error:
        result['error'] = str(error)
    (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--cli', default='kicad-cli')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    result = run(args.input, args.out, command, args.timeout, args.cli)
    print(json.dumps({key: value for key, value in result.items() if key != 'quality'}))
    return int(result['state'] != 'completed')


if __name__ == '__main__':
    raise SystemExit(main())
