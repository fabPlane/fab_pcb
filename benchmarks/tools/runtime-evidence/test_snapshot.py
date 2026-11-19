import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('snapshot', Path(__file__).with_name('snapshot.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class SnapshotTests(unittest.TestCase):
    def test_file_observations(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            tool = root / 'tool'
            tool.write_bytes(b'before')
            link = root / 'launcher'
            link.symlink_to(tool)
            baseline = m.observe({'launcher': link}, {})
            self.assertEqual(m.verify(baseline), baseline)
            tool.write_bytes(b'after')
            with self.assertRaises(ValueError): m.verify(baseline)
            tool.write_bytes(b'before')
            tool.chmod(0o700)
            with self.assertRaises(ValueError): m.verify(baseline)
            tool.chmod(baseline['files']['launcher']['identity']['mode'])
            other = root / 'other'
            other.write_bytes(b'before')
            link.unlink()
            link.symlink_to(other)
            with self.assertRaises(ValueError): m.verify(baseline)
            other.unlink()
            with self.assertRaises(FileNotFoundError): m.verify(baseline)

    def test_repository_observations(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            def git(*args): return m.git(root, *args)
            git('init', '-q')
            source = root / 'source.py'
            source.write_text('original')
            git('add', 'source.py')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial fixture')
            baseline = m.observe({}, {'source': root})
            self.assertEqual(m.verify(baseline), baseline)
            source.write_text('changed')
            with self.assertRaises(ValueError): m.verify(baseline)
            git('add', 'source.py')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Changed fixture')
            with self.assertRaises(ValueError): m.verify(baseline)

    def test_empty_and_schema_fail_closed(self):
        with self.assertRaises(ValueError): m.observe({}, {})
        with self.assertRaises(ValueError): m.verify({})
        with self.assertRaises(ValueError): m.assignments(['a=x', 'a=y'])

    def test_capture_is_exclusive(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            target = root / 'tool'
            target.write_text('tool')
            output = root / 'snapshot.json'
            cmd = ['python3', str(Path(__file__).with_name('snapshot.py')), 'capture', str(output), '--file', f'tool={target}']
            subprocess.run(cmd, check=True, capture_output=True)
            original = output.read_bytes()
            self.assertNotEqual(subprocess.run(cmd, capture_output=True).returncode, 0)
            self.assertEqual(output.read_bytes(), original)


if __name__ == '__main__': unittest.main()
