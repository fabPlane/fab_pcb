# SPDX-License-Identifier: MIT
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from archive import export, load
from baseline import capture, verify
from generate_probes import generate
from terminals import guarded_score


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        generate(self.root / 'source')
        self.board = self.root / 'source/t3-r0.kicad_pcb'
        self.baseline = capture(self.board, self.root / 'source/input.json')
        self.archive = self.root / 'archive'

    def test_moved_archive_scores_without_original_paths(self):
        baseline = export(self.baseline, self.archive)
        moved = self.root / 'moved'
        self.archive.rename(moved)
        candidate = self.root / 'partial.kicad_pcb'
        shutil.copyfile(self.board.with_name('t3-r1.kicad_pcb'), candidate)
        shutil.rmtree(self.root / 'source')
        with self.assertRaises((ValueError, FileNotFoundError)):
            verify(self.baseline)
        rebound = load(moved)
        self.assertNotEqual(baseline['baseline_id'], rebound['baseline_id'])
        self.assertEqual(json.loads((moved / 'archive.json').read_text())['baseline'], self.baseline)
        result = guarded_score(rebound, candidate, self.root / 'output.json')
        self.assertEqual(result['initial_opens'], 2)
        self.assertEqual(result['completion_rate'], .5)

    def test_each_changed_archived_input_rejects(self):
        export(self.baseline, self.archive)
        for relative in ('input/t3-r0.kicad_pcb', 'input/t3-r0.kicad_pro',
                         'input/t3-r0.kicad_dru', 'input-drc.json'):
            with self.subTest(relative=relative):
                path = self.archive / relative
                previous = path.read_bytes() if path.exists() else None
                path.write_text('changed')
                with self.assertRaises(ValueError):
                    load(self.archive)
                if previous is None:
                    path.unlink()
                else:
                    path.write_bytes(previous)
        verify(self.baseline)

    def test_symlinks_and_modified_manifest_reject(self):
        export(self.baseline, self.archive)
        source = self.archive / 'input/t3-r0.kicad_pcb'
        source.unlink()
        source.symlink_to(self.board)
        with self.assertRaisesRegex(ValueError, 'symbolic'):
            load(self.archive)
        source.unlink()
        shutil.copyfile(self.board, source)
        manifest = self.archive / 'archive.json'
        data = json.loads(manifest.read_text())
        data['baseline']['snapshot']['opens'] = 1
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            load(self.archive)

    def test_export_rejects_stale_source_and_existing_destination(self):
        export(self.baseline, self.archive)
        previous = (self.archive / 'archive.json').read_bytes()
        with self.assertRaises(FileExistsError):
            export(self.baseline, self.archive)
        self.assertEqual((self.archive / 'archive.json').read_bytes(), previous)
        self.board.write_text('changed')
        with self.assertRaises(ValueError):
            export(self.baseline, self.root / 'invalid')
        self.assertFalse((self.root / 'invalid').exists())

    def test_archived_checker_stays_external_and_must_match(self):
        checker = self.root / 'checker'
        checker.write_text('#!/bin/sh\nexec /usr/bin/kicad-cli "$@"\n')
        checker.chmod(0o700)
        baseline = capture(self.board, self.root / 'wrapped-drc.json', str(checker))
        export(baseline, self.archive)
        checker.write_text('#!/bin/sh\nexit 1\n')
        with self.assertRaisesRegex(ValueError, 'checker changed'):
            load(self.archive)


if __name__ == '__main__':
    unittest.main()
