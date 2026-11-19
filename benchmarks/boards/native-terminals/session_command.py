# SPDX-License-Identifier: MIT
"""Offline DSN/SES command wrapper; invoke through route.py for group deadlines."""
import argparse
from pathlib import Path
import shutil
import subprocess
import pcbnew


def validate_session(text):
    """Reject incomplete containers before entering the native importer's UI path.

    This checks structure, not routing semantics; native import remains required.
    """
    stack, roots, token = [], [], ''
    quoted = escaped = False

    def atom():
        nonlocal token
        if token:
            if not stack:
                raise ValueError('session atom outside container')
            stack[-1].append(token)
            token = ''

    for char in text:
        if quoted:
            token += char
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
                atom()
        elif char == '"':
            if token:
                raise ValueError('invalid session quoting')
            token = char
            quoted = True
        elif char == '(':
            atom()
            node = []
            (stack[-1] if stack else roots).append(node)
            stack.append(node)
        elif char == ')':
            atom()
            if not stack:
                raise ValueError('unbalanced session')
            stack.pop()
        elif char.isspace():
            atom()
        else:
            token += char
    atom()
    if quoted or stack or len(roots) != 1:
        raise ValueError('incomplete session container')
    root = roots[0]
    if len(root) < 3 or root[0] != 'session' or not isinstance(root[1], str):
        raise ValueError('native session container required')
    for section in ('base_design', 'routes'):
        if sum(isinstance(item, list) and bool(item) and item[0] == section for item in root[2:]) != 1:
            raise ValueError(f'native session requires one {section} section')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not all(any(token in arg for arg in command) for token in ('{dsn}', '{session}')):
        parser.error('command requires {dsn} and {session} placeholders')
    source, output = args.input.resolve(strict=True), args.output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('native output must be fresh')
    # route.py owns this directory. Exclusive scratch creation prevents reusing
    # an earlier session even when called outside the runner by mistake.
    scratch = output.parent / 'session-command'
    scratch.mkdir(exist_ok=False)
    dsn, session = scratch / 'routing-input.dsn', scratch / 'routing-output.ses'
    board = pcbnew.LoadBoard(str(source))
    if board is None or not pcbnew.ExportSpecctraDSN(board, str(dsn)) or not dsn.is_file():
        raise ValueError('native DSN export failed')
    subprocess.run([arg.replace('{dsn}', str(dsn)).replace('{session}', str(session))
                    for arg in command], check=True)
    if not session.is_file():
        raise ValueError('fresh native session required')
    validate_session(session.read_text())
    if not pcbnew.ImportSpecctraSES(board, str(session)):
        raise ValueError('fresh native session import required')
    board.Save(str(output))
    # Native Save can rewrite project serialization; importing a session must
    # retain the original project's exact rules, including absent sidecars.
    for suffix in ('.kicad_pro', '.kicad_dru'):
        original, target = source.with_suffix(suffix), output.with_suffix(suffix)
        if original.exists():
            shutil.copyfile(original, target)
        else:
            target.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
