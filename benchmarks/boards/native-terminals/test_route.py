# SPDX-License-Identifier: MIT
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from generate_probes import generate
from route import run
from session_command import validate_session


class NativeRouteTests(unittest.TestCase):
    def test_session_container_preflight(self):
        validate_session('(session "quoted (name)" (base_design "x") (routes (net_out)))')
        for text in ('(session broken)', '(session x (base_design x) (routes)',
                     '(session x (base_design x) (routes)) (session x)',
                     '(session x (base_design x) (routes) (routes))',
                     '(pcb x (base_design x) (routes))',
                     '(session x (base_design "unterminated) (routes))'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                validate_session(text)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        generate(self.root / 'probes')
        self.board = self.root / 'probes/t3-r0.kicad_pcb'

    def command(self, code):
        return [sys.executable, '-c', code, '{input}', '{output}']

    def test_real_native_partial_and_completed(self):
        for edges, expected in ((0, 0), (1, .5), (2, 1)):
            candidate = self.board.with_name(f't3-r{edges}.kicad_pcb')
            result = run(self.board, self.root / f'run-{edges}', self.command(
                f'import shutil,sys; shutil.copyfile({str(candidate)!r},sys.argv[2])'))
            self.assertEqual(result['state'], 'completed', result)
            self.assertEqual(result['quality']['completion_rate'], expected)
            self.assertEqual(result['quality']['initial_opens'], 2)
            self.assertTrue((self.root / f'run-{edges}/baseline.json').is_file())

    def test_missing_partial_failed_and_changed_input_are_unavailable(self):
        cases = {
            'missing': 'pass',
            'failed': 'import shutil,sys; shutil.copyfile(sys.argv[1],sys.argv[2]); sys.exit(2)',
            'mutated': "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text()+'\\n'); import shutil; shutil.copyfile(p,sys.argv[2])",
            'alias': 'import os,sys; os.link(sys.argv[1],sys.argv[2])',
            'terminal': "import pathlib,sys; p=pathlib.Path(sys.argv[1]); pathlib.Path(sys.argv[2]).write_text(p.read_text().replace('(at 30 10)', '(at 31 10)'))",
        }
        original = self.board.read_bytes()
        for name, code in cases.items():
            with self.subTest(name=name):
                result = run(self.board, self.root / name, self.command(code))
                self.assertEqual(result['state'], 'crash', result)
                self.assertEqual(result['quality_validation'], 'unavailable')
                self.assertNotIn('quality', result)
                self.assertEqual(self.board.read_bytes(), original)

    def test_timeout_kills_child_group(self):
        code = ('import subprocess,sys,time; '
                'subprocess.Popen([sys.executable,"-c",'
                '"import time,pathlib; time.sleep(1); pathlib.Path(\\\"survived\\\").touch()"]); time.sleep(10)')
        result = run(self.board, self.root / 'timeout', self.command(code), timeout=.2)
        self.assertEqual(result['state'], 'timeout', result)
        subprocess.run([sys.executable, '-c', 'import time; time.sleep(1.2)'], check=True)
        self.assertFalse((self.root / 'timeout/survived').exists())

    def test_existing_destination_and_invalid_deadlines_preserve_files(self):
        (self.root / 'sentinel').write_text('keep')
        with self.assertRaises(FileExistsError):
            run(self.board, self.root, self.command('pass'))
        self.assertEqual((self.root / 'sentinel').read_text(), 'keep')
        for value in (0, -1, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                run(self.board, self.root / 'invalid', self.command('pass'), value)
        self.assertFalse((self.root / 'invalid').exists())

    def test_cli_nonzero_exit_has_no_quality(self):
        out = self.root / 'cli'
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('route.py')),
                                 '--input', str(self.board), '--out', str(out), '--',
                                 *self.command('import sys; sys.exit(7)')], capture_output=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        saved = json.loads((out / 'result.json').read_text())
        self.assertEqual(saved['state'], 'crash')
        self.assertNotIn('quality', saved)

    def test_session_wrapper_requires_successful_fresh_import(self):
        wrapper = str(Path(__file__).with_name('session_command.py').resolve())
        for name, code in [('missing', 'pass'), ('failed', 'import sys; sys.exit(2)'),
                           ('malformed', 'import pathlib,sys; pathlib.Path(sys.argv[2]).write_text("(session broken)")')]:
            with self.subTest(name=name):
                command = [sys.executable, wrapper, '{input}', '{output}', '--',
                           sys.executable, '-c', code, '{dsn}', '{session}']
                result = run(self.board, self.root / ('session-' + name), command, timeout=15)
                self.assertEqual(result['state'], 'crash', result)
                self.assertNotIn('quality', result)


if __name__ == '__main__':
    unittest.main()
