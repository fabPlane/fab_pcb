# SPDX-License-Identifier: MIT
"""Reject changed native terminals before interpreting a decrease in open edges."""
import hashlib
import json
from pathlib import Path
import pcbnew
from baseline import score, verify


def signature(path):
    board = pcbnew.LoadBoard(str(Path(path).resolve()))
    if board is None:
        raise ValueError('cannot load native board')
    pads = []
    for footprint in board.GetFootprints():
        for pad in footprint.Pads():
            # Custom copper primitives require a separate canonical geometry model.
            if pad.Padstack().Mode() != pcbnew.PADSTACK.MODE_NORMAL:
                raise ValueError('nonuniform pad stacks are unsupported')
            if pad.GetShape() == pcbnew.PAD_SHAPE_CUSTOM:
                raise ValueError('custom pad geometry is unsupported')
            xy = lambda v: [v.x, v.y]
            pads.append(dict(reference=footprint.GetReference(), number=pad.GetNumber(),
                net=pad.GetNetname(), position=xy(pad.GetPosition()),
                orientation=pad.GetOrientationDegrees() % 360,
                size=xy(pad.GetSize()), shape=int(pad.GetShape()),
                attribute=int(pad.GetAttribute()), drill=xy(pad.GetDrillSize()),
                drill_shape=int(pad.GetDrillShape()), offset=xy(pad.GetOffset()),
                delta=xy(pad.GetDelta()), roundrect=pad.GetRoundRectRadiusRatio(),
                chamfer_ratio=pad.GetChamferRectRatio(), chamfer_positions=pad.GetChamferPositions(),
                layers=list(pad.GetLayerSet().Seq())))
    # Preserve duplicate terminals; UUIDs and iteration order can change on import.
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return dict(copper_layers=[board.GetLayerName(i) for i in board.GetEnabledLayers().CuStack()],
                nets=sorted(net.GetNetname() for net in board.GetNetsByNetcode().values()),
                pads=sorted(pads, key=canonical))


def assert_preserved(original, routed):
    before, after = signature(original), signature(routed)
    if before != after:
        raise ValueError('routed native terminal geometry, layers or net ownership changed')
    return hashlib.sha256(json.dumps(before, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def guarded_score(baseline, routed, report, cli='kicad-cli'):
    """Check terminal correspondence before and after fresh native scoring."""
    verify(baseline)
    identity = assert_preserved(baseline['board'], routed)
    result = score(baseline, routed, report, cli)
    if assert_preserved(baseline['board'], routed) != identity:
        raise ValueError('native terminal identity changed during scoring')
    return dict(result, terminal_signature_sha256=identity)
