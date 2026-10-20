#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Export a KiCad board to Specctra DSN in a fresh pcbnew session (so the sibling .kicad_pro rules apply).
Exits non-zero if KiCad reports a failed export."""
import sys, os, shutil, tempfile, pcbnew
from pathlib import Path
pcb, dsn = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
b = pcbnew.LoadBoard(str(pcb))
nc = b.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
print('default netclass clearance/track/via/drill (mm):', pcbnew.ToMM(nc.GetClearance()), pcbnew.ToMM(nc.GetTrackWidth()), pcbnew.ToMM(nc.GetViaDiameter()), pcbnew.ToMM(nc.GetViaDrill()))
ds = b.GetDesignSettings()
print('min clearance', pcbnew.ToMM(ds.m_MinClearance), 'min track', pcbnew.ToMM(ds.m_TrackMinWidth))
with tempfile.TemporaryDirectory(dir=dsn.parent) as t:
    cwd = os.getcwd()
    os.chdir(t)
    try:
        ok = pcbnew.ExportSpecctraDSN(b, 'board.dsn')
    finally:
        os.chdir(cwd)
    print('dsn', ok)
    if not ok:
        sys.exit(1)
    shutil.move(Path(t) / 'board.dsn', dsn)
