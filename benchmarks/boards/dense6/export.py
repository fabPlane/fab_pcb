# SPDX-License-Identifier: MIT
"""Headless DSN export with a stable document name; requires pcbnew."""
import os
from pathlib import Path
import shutil
import sys
import tempfile
import pcbnew

source, target = map(lambda p: Path(p).resolve(), sys.argv[1:])
if source == target:
    raise ValueError('source board must not be the export destination')
target.parent.mkdir(parents=True, exist_ok=True)
target.unlink(missing_ok=True)
board = pcbnew.LoadBoard(str(source))
with tempfile.TemporaryDirectory(dir=target.parent) as temp:
    original = Path.cwd()
    try:
        os.chdir(temp)
        if not pcbnew.ExportSpecctraDSN(board, 'board.dsn'):
            raise RuntimeError('native DSN export failed')
    finally:
        os.chdir(original)
    shutil.move(str(Path(temp) / 'board.dsn'), target)
