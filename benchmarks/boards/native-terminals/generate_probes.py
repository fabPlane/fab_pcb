# SPDX-License-Identifier: MIT
"""Create deterministic isolated 2/3-terminal connection probes (millimetres)."""
from pathlib import Path


def generate(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for terminals in (2, 3):
        for routed_edges in range(terminals):
            lines = ['(kicad_pcb (version 20260206) (generator "connectivity-probe")',
                     '(general (thickness 1.6)) (paper "A4")',
                     '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (35 "F.Fab" user))',
                     '(setup (pad_to_mask_clearance 0)) (net 0 "") (net 1 "N1")']
            for index in range(terminals):
                x = 10 + index * 10
                lines.append(f'(footprint "Probe" (layer "F.Cu") (at {x} 10) '
                             f'(property "Reference" "J{index+1}" (at 0 2) (layer "F.Fab") '
                             '(effects (font (size 1 1) (thickness .1)))) '
                             '(attr smd) (pad "1" smd circle (at 0 0) (size 1 1) '
                             '(layers "F.Cu") (net 1 "N1")))')
            for index in range(routed_edges):
                lines.append(f'(segment (start {10 + index*10} 10) (end {20 + index*10} 10) '
                             '(width .25) (layer "F.Cu") (net 1))')
            lines.append('(gr_rect (start 5 5) (end 35 15) (stroke (width .05) '
                         '(type default)) (fill no) (layer "Edge.Cuts")))')
            (out / f't{terminals}-r{routed_edges}.kicad_pcb').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    import sys
    generate(sys.argv[1])
