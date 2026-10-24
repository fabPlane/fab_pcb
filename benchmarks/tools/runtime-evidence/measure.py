"""Three-repeat constructed timing controls; does not run a routing engine."""
import csv
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('snapshot', Path(__file__).with_name('snapshot.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def measure(output):
    rows = []
    for case in ['unchanged', 'binary_bytes', 'binary_mode', 'launcher_target', 'tracked_source']:
        for repeat in range(1, 4):
            with tempfile.TemporaryDirectory() as d:
                root = Path(d)
                tool = root / 'tool'
                tool.write_text('original')
                tool.chmod(0o600)
                link = root / 'launcher'
                link.symlink_to(tool)
                repo = root / 'repo'
                repo.mkdir()
                source = repo / 'source.py'
                source.write_text('original')
                m.git(repo, 'init', '-q')
                m.git(repo, 'add', 'source.py')
                m.git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial fixture')
                files, repos = {'launcher': link}, {'source': repo}
                start = m.observe(files, repos)
                if case == 'binary_bytes': tool.write_text('modified')
                if case == 'binary_mode': tool.chmod(0o700)
                if case == 'launcher_target':
                    other = root / 'other'
                    other.write_text('original')
                    other.chmod(0o600)
                    link.unlink()
                    link.symlink_to(other)
                if case == 'tracked_source':
                    source.write_text('modified')
                    m.git(repo, 'add', 'source.py')
                    m.git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Changed fixture')
                # Emulate the missing-startup gap: first observation follows mutation.
                middle = m.observe(files, repos)
                before_accept = m.verify(middle) == middle
                t = time.monotonic()
                try:
                    m.verify(start)
                    after_accept = True
                except ValueError:
                    after_accept = False
                rows.append([case, repeat, int(before_accept), int(after_accept), round((time.monotonic()-t)*1000, 3)])
    output.mkdir(parents=True, exist_ok=True)
    with (output/'controls.csv').open('w') as f:
        writer = csv.writer(f, lineterminator='\n')
        writer.writerow(['case','repeat','mid_end_accepted','startup_end_accepted','verification_ms'])
        writer.writerows(rows)
    assert all(row[2] == 1 and row[3] == int(row[0] == 'unchanged') for row in rows)
    print(json.dumps(dict(pairs=len(rows), changed_accepted_before=12, changed_accepted_after=0, unchanged_accepted_before=3, unchanged_accepted_after=3)))


if __name__ == '__main__': measure(Path(sys.argv[1]))
