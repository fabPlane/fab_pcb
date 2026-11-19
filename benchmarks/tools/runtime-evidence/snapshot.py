"""Explicit, local runtime file observations; never discovers credentials or environment.

Capture before a benchmark, verify afterwards. Matching endpoints do not prove
files were immutable between observations or cover imported libraries.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess

SCHEMA = 'runtime-observation-v1'


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def file_identity(path):
    path = Path(path)
    resolved = path.resolve(strict=True)
    before = resolved.stat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError(f'Expected regular file: {path}')
    digest = hashlib.sha256()
    with resolved.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    after = resolved.stat()
    fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode)
    if fields(before) != fields(after) or path.resolve(strict=True) != resolved:
        raise ValueError(f'File changed during observation: {path}')
    return dict(resolved=str(resolved), sha256=digest.hexdigest(), mode=stat.S_IMODE(after.st_mode))


def observe(files, repos):
    if not files and not repos:
        raise ValueError('At least one explicit file or repository required')
    result = dict(schema=SCHEMA, files={}, repositories={})
    for label, path in sorted(files.items()):
        absolute = os.path.abspath(path)
        result['files'][label] = dict(path=absolute, identity=file_identity(absolute))
    for label, path in sorted(repos.items()):
        root = Path(path).resolve(strict=True)
        head = git(root, 'rev-parse', 'HEAD').decode().strip()
        if git(root, 'status', '--porcelain', '--untracked-files=no'):
            raise ValueError(f'Tracked repository changes: {root}')
        tracked = git(root, 'ls-files', '-z').decode().split('\0')[:-1]
        identities = {name: file_identity(root / name) for name in tracked}
        if head != git(root, 'rev-parse', 'HEAD').decode().strip() or git(root, 'status', '--porcelain', '--untracked-files=no'):
            raise ValueError(f'Repository changed during observation: {root}')
        result['repositories'][label] = dict(path=str(root), head=head, tracked=identities)
    return result


def verify(snapshot):
    if set(snapshot) != {'schema', 'files', 'repositories'} or snapshot['schema'] != SCHEMA:
        raise ValueError('Unsupported runtime observation')
    actual = observe({k: v['path'] for k, v in snapshot['files'].items()},
                     {k: v['path'] for k, v in snapshot['repositories'].items()})
    if actual != snapshot:
        raise ValueError('Runtime differs from startup observation')
    return actual


def assignments(values):
    result = {}
    for value in values:
        label, path = value.split('=', 1)
        if not label or not path or label in result:
            raise ValueError('Expected unique nonempty LABEL=PATH arguments')
        result[label] = path
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'verify'])
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('--file', action='append', default=[])
    parser.add_argument('--repo', action='append', default=[])
    args = parser.parse_args()
    if args.action == 'capture':
        record = observe(assignments(args.file), assignments(args.repo))
        # Exclusive creation prevents accidental overwrite of startup evidence.
        with args.snapshot.open('x') as output:
            json.dump(record, output, indent=2, sort_keys=True)
            output.write('\n')
    else:
        if args.file or args.repo:
            parser.error('verify uses the original snapshot targets')
        verify(json.loads(args.snapshot.read_text()))
        print('Runtime matches startup observation')


if __name__ == '__main__':
    main()
