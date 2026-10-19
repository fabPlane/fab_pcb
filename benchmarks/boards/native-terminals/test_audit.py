# SPDX-License-Identifier: MIT
import copy
import unittest
import subprocess
import tempfile
from pathlib import Path
from audit import completion, counts, snapshot


class ConnectivityTest(unittest.TestCase):
    def test_connection_edges_and_preconnected_inputs(self):
        self.assertEqual(completion(2, 1), .5)
        self.assertEqual(completion(1, 1), 0)
        self.assertEqual(completion(1, 0), 1)
        self.assertEqual(completion(439, 439), 0)
        self.assertAlmostEqual(completion(439, 438), 1 / 439)
        self.assertEqual(completion(0, 0), 1)
        self.assertEqual(completion(0, 1), 0)
        self.assertEqual(completion(2, 3), 0)

    def test_invalid_counts_fail_closed(self):
        for bad in (None, -1, .5, float('nan'), float('inf'), True, '2'):
            for args in ((bad, 0), (2, bad)):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    completion(*args)

    def test_missing_native_evidence_fails_closed(self):
        report = dict(source='board.kicad_pcb', coordinate_units='mm',
                      included_severities=['error', 'warning'],
                      violations=[], unconnected_items=[], schematic_parity=[])
        self.assertEqual(counts(report, 'board.kicad_pcb')['opens'], 0)
        for key in report:
            changed = copy.deepcopy(report)
            del changed[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                counts(changed, 'board.kicad_pcb')

    def test_report_alias_cannot_remove_native_inputs(self):
        for target in ('board.kicad_pcb', 'board.kicad_pro', 'board.kicad_dru', 'cli'):
            for alias in ('direct', 'symlink', 'hardlink'):
                with self.subTest(target=target, alias=alias), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    board, cli = root / 'board.kicad_pcb', root / 'cli'
                    for name in ('board.kicad_pcb', 'board.kicad_pro', 'board.kicad_dru'):
                        (root / name).write_text(name)
                    cli.write_text('#!/bin/sh\nexit 1\n')
                    cli.chmod(0o755)
                    protected = root / target
                    output = protected if alias == 'direct' else root / 'report.json'
                    if alias == 'symlink':
                        output.symlink_to(protected)
                    elif alias == 'hardlink':
                        output.hardlink_to(protected)
                    before = {p.name: p.read_bytes() for p in (board, board.with_suffix('.kicad_pro'),
                                                             board.with_suffix('.kicad_dru'), cli)}
                    with self.assertRaisesRegex(ValueError, 'aliases'):
                        snapshot(board, output, str(cli))
                    self.assertEqual(before, {name: (root / name).read_bytes() for name in before})
                    self.assertTrue(output.exists())

        # Absent sidecars, including dangling symlinks, are protected too.
        for extension in ('.kicad_pro', '.kicad_dru'):
            for dangling in (False, True):
                with self.subTest(extension=extension, dangling=dangling), tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    board, cli = root / 'board.kicad_pcb', root / 'cli'
                    board.write_text('board')
                    cli.write_text('#!/bin/sh\nexit 1\n')
                    cli.chmod(0o755)
                    sidecar = board.with_suffix(extension)
                    output = root / 'missing-rule-target' if dangling else sidecar
                    if dangling:
                        sidecar.symlink_to(output)
                    with self.assertRaisesRegex(ValueError, 'aliases'):
                        snapshot(board, output, str(cli))
                    self.assertFalse(output.exists())
                    self.assertEqual(board.read_text(), 'board')
                    if dangling:
                        self.assertTrue(sidecar.is_symlink())

    def test_failed_native_check_cannot_reuse_a_stale_report(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            board, report, cli = root / 'board.kicad_pcb', root / 'report.json', root / 'cli'
            board.write_text('board')
            report.write_text('{}')
            cli.write_text('#!/bin/sh\nexit 1\n')
            cli.chmod(0o755)
            with self.assertRaises(subprocess.CalledProcessError):
                snapshot(board, report, str(cli))
            self.assertFalse(report.exists())


if __name__ == '__main__':
    unittest.main()
