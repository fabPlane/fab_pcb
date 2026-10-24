# SPDX-License-Identifier: MIT
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from audit import run_checker


class CheckerProcessTests(unittest.TestCase):
    def test_group_cleanup_preserves_exit_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            for mode in ('success', 'nonzero', 'timeout'):
                with self.subTest(mode=mode):
                    marker = Path(temp) / mode
                    child = f'import time,pathlib; time.sleep(.6); pathlib.Path({str(marker)!r}).touch()'
                    code = ('import subprocess,sys,time; '
                            f'subprocess.Popen([sys.executable,"-c",{child!r}]); ' +
                            ('time.sleep(10)' if mode == 'timeout' else f'sys.exit({7 if mode == "nonzero" else 0})'))
                    argv = [sys.executable, '-c', code]
                    if mode == 'success':
                        run_checker(argv, timeout=.25)
                    else:
                        exception = subprocess.TimeoutExpired if mode == 'timeout' else subprocess.CalledProcessError
                        with self.assertRaises(exception):
                            run_checker(argv, timeout=.25)
                    time.sleep(.9)
                    self.assertFalse(marker.exists())

    def test_invalid_deadline_does_not_launch(self):
        for value in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                run_checker([sys.executable, '-c', 'raise RuntimeError()'], value)


if __name__ == '__main__':
    unittest.main()
