#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Deterministic dense 6-layer benchmark board "dense6-bga324".

One 0.8 mm-pitch 324-ball BGA (18x18, power in the centre 8x8) fanning out to a
96-ball 0.8 mm memory BGA, a 0.5 mm QFN-64, a 0.4 mm QFN-48 and two 0.5 mm 2x30
board-to-board connectors, plus 0402 decoupling on the bottom side.
All six copper layers are signal layers; power/ground are routed as nets (no planes).
Coordinates in mm. Usage: gen_dense6.py OUTDIR [--seed N]
"""
import argparse, json, math, random, uuid
from pathlib import Path

ROWS = "ABCDEFGHJKLMNPRTUV"  # JEDEC row letters, 18 rows

def U(rng):
    return str(uuid.UUID(int=rng.getrandbits(128)))

def build(seed):
    rng = random.Random(seed)
    uid = random.Random(seed + 1000)
    nets = {"": 0}
    def net(name):
        if name not in nets:
            nets[name] = len(nets)
        return name
    fps = []  # (ref, value, layer, x, y, pads[(num, shape, x, y, w, h, netname)])

    # ---------- U1: 324-ball BGA, 0.8 mm pitch, centred at (32, 28)
    U1X, U1Y, P = 32.0, 28.0, 0.8
    u1 = {}
    for r in range(18):
        for c in range(18):
            u1[(r, c)] = (f"{ROWS[r]}{c+1}", (c - 8.5) * P, (r - 8.5) * P)
    centre = [(r, c) for r in range(5, 13) for c in range(5, 13)]  # 64 balls
    power_seq = []
    for (r, c) in centre:
        # checkerboard-ish GND, core and IO supplies like a real FPGA core array
        if (r + c) % 2 == 0: power_seq.append(((r, c), "GND"))
        elif r < 9: power_seq.append(((r, c), "VCC_CORE"))
        else: power_seq.append(((r, c), "VCCIO"))
    u1net = {rc: n for rc, n in power_seq}
    sig_balls = [rc for rc in u1 if rc not in u1net]  # 260
    assert len(sig_balls) == 260

    # destinations (world coordinates of the far component) and signal counts
    groups = [  # name, count, angle of the destination as seen from U1 centre
        ("MEM", 80, 0.0),          # right
        ("JTOP", 40, -90.0),       # up (screen y down)
        ("QA", 56, 200.0),         # left-up
        ("QB", 40, 160.0),         # left-down
        ("JBOT", 44, 90.0),        # down
    ]
    assert sum(g[1] for g in groups) == 260
    # assign balls to groups by angle sector (balanced by count), local shuffle -> crossings
    def ang(rc):
        _, x, y = u1[rc]
        return math.degrees(math.atan2(y, x)) % 360
    remaining = list(sig_balls)
    assign = {}
    for name, count, a in groups:
        remaining.sort(key=lambda rc: (min(abs(ang(rc) - a) % 360, 360 - abs(ang(rc) - a) % 360),
                                        -max(abs(u1[rc][1]), abs(u1[rc][2]))))
        take, remaining = remaining[:count], remaining[count:]
        assign[name] = take
    assert not remaining

    def ordered(balls, key):
        balls = sorted(balls, key=key)
        # bounded local shuffle: swap within windows of 4 (realistic, imperfect pin order)
        out = []
        for i in range(0, len(balls), 4):
            w = balls[i:i+4]; rng.shuffle(w); out += w
        return out

    signals = {}  # group -> list of (u1 ball rc, netname)
    for name, _, a in groups:
        if name in ("MEM",):
            key = lambda rc: (u1[rc][2], u1[rc][1])
        elif name in ("JTOP", "JBOT"):
            key = lambda rc: (u1[rc][1], u1[rc][2])
        else:
            key = lambda rc: (u1[rc][2], -u1[rc][1])
        lst = ordered(assign[name], key)
        signals[name] = [(rc, net(f"{name}_D{i}")) for i, rc in enumerate(lst)]
        for rc, n in signals[name]:
            u1net[rc] = n
    pads = [(u1[rc][0], "circle", u1[rc][1], u1[rc][2], 0.4, 0.4, u1net[rc]) for rc in u1]
    fps.append(("U1", "BGA324_0.8mm", "F", U1X, U1Y, pads))

    # ---------- U2: 96-ball memory BGA (2 x 3 columns x 16 rows), 0.8 mm, at (55, 28)
    U2X, U2Y = 55.0, 28.0
    cols = [-3.2, -2.4, -1.6, 1.6, 2.4, 3.2]
    u2sites = [(ci, r) for r in range(16) for ci in range(6)]
    # power: 8 GND + 8 VCCIO on columns 2/3 (inner) at alternating rows
    u2pads = []
    mem = list(signals["MEM"])
    mi = 0
    for ci, r in u2sites:
        name = f"{ROWS[r]}{ci+1}"
        x, y = cols[ci], (r - 7.5) * 0.8
        if ci in (2, 3) and r % 2 == 0:
            n = "GND" if (r // 2) % 2 == 0 else "VCCIO"
        else:
            n = mem[mi][1]; mi += 1
        u2pads.append((name, "circle", x, y, 0.4, 0.4, n))
    assert mi == 80
    fps.append(("U2", "BGA96_0.8mm", "F", U2X, U2Y, u2pads))

    # ---------- QFN helper
    def qfn(n_side, pitch, row, plen, pw, ep, sigs, power):
        out = []; k = 0; num = 1
        total = 4 * n_side
        powmap = dict(power)
        span = (n_side - 1) * pitch / 2
        for side in range(4):
            for i in range(n_side):
                t = -span + i * pitch
                if side == 0: x, y, w, h = -row, t, plen, pw          # left, top->bottom
                elif side == 1: x, y, w, h = t, row, pw, plen        # bottom, left->right
                elif side == 2: x, y, w, h = row, -t, plen, pw       # right, bottom->top
                else: x, y, w, h = -t, -row, pw, plen                # top, right->left
                if num in powmap: n = powmap[num]
                else: n = sigs[k]; k += 1
                out.append((str(num), "rect", x, y, w, h, n)); num += 1
        assert k == len(sigs), (k, len(sigs))
        out.append((str(total + 1), "rect", 0, 0, ep, ep, "GND"))
        return out
    qa_sig = [n for _, n in signals["QA"]]
    qa_pow = {8: "VCCIO", 16: "GND", 24: "VCCIO", 32: "GND", 40: "VCCIO", 48: "GND", 56: "VCCIO", 64: "GND"}
    fps.append(("U3", "QFN64_0.5mm_9x9", "F", 12.0, 17.0, qfn(16, 0.5, 4.45, 0.8, 0.25, 5.6, qa_sig, qa_pow)))
    qb_sig = [n for _, n in signals["QB"]]
    qb_pow = {6: "VCCIO", 12: "GND", 18: "VCCIO", 24: "GND", 30: "VCCIO", 36: "GND", 42: "VCCIO", 48: "GND"}
    fps.append(("U4", "QFN48_0.4mm_6x6", "F", 12.0, 39.0, qfn(12, 0.4, 2.9, 0.7, 0.2, 4.0, qb_sig, qb_pow)))

    # ---------- connectors 2x30, 0.5 mm pitch
    def conn(sigs, power):
        out = []; k = 0
        powmap = dict(power)
        for i in range(60):
            col, row = i // 2, i % 2
            x = (col - 14.5) * 0.5
            y = -1.6 if row == 0 else 1.6
            num = i + 1
            if num in powmap: n = powmap[num]
            else: n = sigs[k]; k += 1
            out.append((str(num), "rect", x, y, 0.3, 1.2, n))
        assert k == len(sigs)
        return out
    jt_pow = {n: "GND" for n in (1, 2, 9, 10, 15, 16, 23, 24, 29, 30, 37, 38, 45, 46, 59, 60)}
    jt_pow.update({n: "VCC_CORE" for n in (3, 4)}); jt_pow.update({n: "VCCIO" for n in (5, 6)})
    fps.append(("J1", "B2B_2x30_0.5mm", "F", 32.0, 6.0, conn([n for _, n in signals["JTOP"]], jt_pow)))
    jb_pow = {n: "GND" for n in (1, 2, 11, 12, 21, 22, 41, 42, 51, 52, 59, 60)}
    jb_pow.update({n: "VCCIO" for n in (3, 4, 31, 32)})
    fps.append(("J2", "B2B_2x30_0.5mm", "F", 32.0, 50.0, conn([n for _, n in signals["JBOT"]], jb_pow)))

    # ---------- 0402 decoupling on the bottom side: 16 around U1, 8 near U2
    caps = []
    ring = []
    for i in range(16):
        a = 2 * math.pi * (i + 0.5) / 16
        ring.append((U1X + 9.6 * math.cos(a), U1Y + 9.6 * math.sin(a)))
    for j in range(8):
        ring.append((U2X + (-5.0 if j % 2 == 0 else 5.0), U2Y + (j // 2 - 1.5) * 3.2))
    for i, (x, y) in enumerate(ring):
        rail = "VCC_CORE" if (i < 16 and i % 2 == 0) else "VCCIO"
        caps.append((f"C{i+1}", "100nF_0402", "B", round(x, 4), round(y, 4),
                     [("1", "rect", -0.48, 0, 0.56, 0.62, rail), ("2", "rect", 0.48, 0, 0.56, 0.62, "GND")]))
    fps += caps
    for n in ("GND", "VCC_CORE", "VCCIO"): net(n)
    return fps, nets, uid

LAYERS = """	(layers
		(0 "F.Cu" signal)
		(4 "In1.Cu" signal)
		(6 "In2.Cu" signal)
		(8 "In3.Cu" signal)
		(10 "In4.Cu" signal)
		(2 "B.Cu" signal)
		(9 "F.Adhes" user) (11 "B.Adhes" user) (13 "F.Paste" user) (15 "B.Paste" user)
		(5 "F.SilkS" user) (7 "B.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user)
		(17 "Dwgs.User" user) (19 "Cmts.User" user) (25 "Edge.Cuts" user) (27 "Margin" user)
		(31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user) (33 "B.Fab" user)
	)"""

def write_pcb(path, fps, nets, uid, W=70.0, H=56.0):
    o = ['(kicad_pcb', '\t(version 20260206)', '\t(generator "dense6-gen")', '\t(generator_version "10.0")',
         '\t(general (thickness 1.6) (legacy_teardrops no))', '\t(paper "A4")', LAYERS,
         '\t(setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints yes))']
    for name, code in sorted(nets.items(), key=lambda kv: kv[1]):
        o.append(f'\t(net {code} "{name}")')
    for ref, value, side, x, y, pads in fps:
        L = "F" if side == "F" else "B"
        o.append(f'\t(footprint "dense6:{value}" (layer "{L}.Cu") (uuid "{U(uid)}") (at {x:.4f} {y:.4f})')
        mir = ' (justify mirror)' if L == 'B' else ''
        o.append(f'\t\t(property "Reference" "{ref}" (at 0 0) (layer "{L}.Fab") (uuid "{U(uid)}") (effects (font (size 0.5 0.5) (thickness 0.08)){mir}))')
        o.append(f'\t\t(property "Value" "{value}" (at 0 1) (layer "{L}.Fab") (hide yes) (uuid "{U(uid)}") (effects (font (size 0.5 0.5) (thickness 0.08)){mir}))')
        o.append('\t\t(attr smd)')
        for num, shape, px, py, w, h, n in pads:
            netpart = f' (net {nets[n]} "{n}")' if n else ''
            o.append(f'\t\t(pad "{num}" smd {shape} (at {px:.4f} {py:.4f}) (size {w} {h}) '
                     f'(layers "{L}.Cu" "{L}.Paste" "{L}.Mask"){netpart} (uuid "{U(uid)}"))')
        o.append('\t)')
    o.append(f'\t(gr_rect (start 0 0) (end {W} {H}) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "{U(uid)}"))')
    o.append(')')
    path.write_text('\n'.join(o) + '\n')

def stats(fps, nets):
    pins = {}
    for ref, value, side, x, y, pads in fps:
        for p in pads:
            if p[6]: pins.setdefault(p[6], 0); pins[p[6]] += 1
    conns = sum(c - 1 for c in pins.values() if c > 1)
    return dict(nets=len(pins), pads=sum(len(f[5]) for f in fps), connections=conns,
                two_pin_nets=sum(1 for c in pins.values() if c == 2),
                power_pins={n: pins[n] for n in ("GND", "VCC_CORE", "VCCIO")},
                footprints=len(fps))

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out", type=Path); ap.add_argument("--seed", type=int, default=6406)
    a = ap.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
    fps, nets, uid = build(a.seed)
    write_pcb(a.out / "dense6-bga324.kicad_pcb", fps, nets, uid)
    s = stats(fps, nets); s.update(seed=a.seed, layers=6, board_mm=[70, 56])
    (a.out / "stats.json").write_text(json.dumps(s, indent=2) + "\n"); print(json.dumps(s))
