#!/usr/bin/python3
import sys, os, shutil, tempfile, pcbnew
from pathlib import Path
pcb, dsn = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
b = pcbnew.LoadBoard(str(pcb))
nc = b.GetDesignSettings().m_NetSettings.GetDefaultNetclass()
print('default netclass clearance/track/via/drill (mm):', pcbnew.ToMM(nc.GetClearance()), pcbnew.ToMM(nc.GetTrackWidth()), pcbnew.ToMM(nc.GetViaDiameter()), pcbnew.ToMM(nc.GetViaDrill()))
ds = b.GetDesignSettings()
print('min clearance', pcbnew.ToMM(ds.m_MinClearance), 'min track', pcbnew.ToMM(ds.m_TrackMinWidth))
with tempfile.TemporaryDirectory(dir=dsn.parent) as t:
    cwd = os.getcwd(); os.chdir(t)
    ok = pcbnew.ExportSpecctraDSN(b, 'board.dsn'); os.chdir(cwd)
    shutil.move(Path(t) / 'board.dsn', dsn)
print('dsn', ok)
