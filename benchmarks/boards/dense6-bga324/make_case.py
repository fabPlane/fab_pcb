#!/usr/bin/python3
"""Turn a generated board into: normalized .kicad_pcb + .kicad_pro, DSN, native DRC report,
and a fab_pcb-benchmark-style case dir (board.*, baseline-drc.json, job.json)."""
import json, subprocess, sys, hashlib, shutil, datetime
from pathlib import Path
import pcbnew
src, out, name = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
SEED = int(sys.argv[4]) if len(sys.argv) > 4 else 6406  # must match the seed passed to gen_dense6.py
RULES = dict(clearance=0.1, track=0.1, via=0.45, drill=0.2, edge=0.3)
out.mkdir(parents=True, exist_ok=True)
HERE = Path(__file__).resolve().parent
pro_tpl = json.loads((HERE / "project-template.kicad_pro").read_text())  # vendored; no dependency on the frozen suite
def write_pro(path):
    d = json.loads(json.dumps(pro_tpl))
    r = d['board']['design_settings']['rules']
    r.update(min_clearance=RULES['clearance'], min_track_width=RULES['track'], min_via_diameter=RULES['via'],
             min_through_hole_diameter=RULES['drill'], min_via_annular_width=0.1, min_hole_clearance=0.2,
             min_hole_to_hole=0.25, min_copper_edge_clearance=RULES['edge'], min_connection=0.0)
    c = d['net_settings']['classes'][0]
    c.update(clearance=RULES['clearance'], track_width=RULES['track'], via_diameter=RULES['via'], via_drill=RULES['drill'],
             diff_pair_width=0.1, diff_pair_gap=0.15, diff_pair_via_gap=0.25)
    d['net_settings']['netclass_patterns'] = []
    d['net_settings']['netclass_assignments'] = None
    d['meta']['filename'] = path.name
    path.write_text(json.dumps(d, indent=2) + '\n')
pcb = out / f'{name}.kicad_pcb'
write_pro(pcb.with_suffix('.kicad_pro'))
b = pcbnew.LoadBoard(str(src))
pcbnew.SaveBoard(str(pcb), b)
write_pro(pcb.with_suffix('.kicad_pro'))  # SaveBoard may rewrite the project; re-apply rules
b = pcbnew.LoadBoard(str(pcb))
print('copper layers', b.GetCopperLayerCount(), 'footprints', len(b.GetFootprints()), 'pads', len(b.GetPads()),
      'nets', b.GetNetCount())
# DSN in a fresh process so the project rules written above are picked up
subprocess.run(['/usr/bin/python3', str(Path(__file__).with_name('export_dsn.py')), str(pcb), str(out / f'{name}.dsn')], check=True)
drc = out / f'{name}.drc.json'
subprocess.run(['kicad-cli', 'pcb', 'drc', '--format', 'json', '--severity-all', '--units', 'mm', '-o', str(drc), str(pcb)], check=True, capture_output=True)
d = json.loads(drc.read_text())
viol = [v for v in d.get('violations', [])]
import collections
print('drc violations', collections.Counter((v['type'], v['severity']) for v in viol), 'unconnected', len(d.get('unconnected_items', [])))
# fab_pcb-style case dir
case = out / 'case'
case.mkdir(exist_ok=True)
shutil.copy(pcb, case / 'board.kicad_pcb'); write_pro(case / 'board.kicad_pro')
shutil.copy(HERE / 'LICENSE', case / 'LICENSE')
(case / 'board.kicad_dru').write_text('(version 1)\n')
shutil.copy(drc, case / 'baseline-drc.json')
errs = [v for v in viol if v['severity'] == 'error']; warns = [v for v in viol if v['severity'] == 'warning']
nets = sorted(str(n) for n in b.GetNetsByName().keys() if str(n))
job = {"job": "J1", "tier": "hard", "role": "scored", "scope": None, "target_nets": [], "target_footprint": None,
       "power_nets": [], "pairs": [], "kept_zones": [],
       "rules": {"classes": [{"name": "Default", "clearance": RULES['clearance'], "track_width": RULES['track'],
                  "via_diameter": RULES['via'], "via_drill": RULES['drill'], "diff_pair_width": 0.1, "diff_pair_gap": 0.15,
                  "diff_pair_via_gap": 0.25, "nets": [str(n) for n in nets]}],
                 "clearance_mm": 0.0, "copper_to_edge_mm": RULES['edge'], "copper_to_hole_mm": 0.2, "hole_to_hole_mm": 0.25,
                 "minimum_track_mm": RULES['track'], "minimum_via_mm": RULES['via'], "minimum_annular_mm": 0.1,
                 "provenance": "synthetic dense6 generator; rules chosen for 0.8 mm BGA / 0.4 mm QFN fanout"},
       "baseline": {"errors": len(errs), "warnings": len(warns), "opens": len(d.get('unconnected_items', [])),
                    "error_types": dict(collections.Counter(v['type'] for v in errs)),
                    "warning_types": dict(collections.Counter(v['type'] for v in warns))},
       "source": {"board_id": name, "repository": "synthetic (benchmarks/boards/dense6-bga324/gen_dense6.py)", "license": "MIT",
                  "license_file": "LICENSE", "generator": "gen_dense6.py", "seed": SEED,
                  "generator_sha256": hashlib.sha256((HERE / 'gen_dense6.py').read_bytes()).hexdigest()},
       "fidelity": {"footprints": True, "pads": True, "outline": True, "layers": True, "nets": True},
       "gates": {"fidelity": True, "baseline_errors_zero": len(errs) == 0}, "gate_pass": len(errs) == 0,
       "selection": {"job": "J1", "tier": "hard", "board_id": name, "why": "dense 6-layer BGA/QFN fanout stress board"},
       "sha256": {f: hashlib.sha256((case / f).read_bytes()).hexdigest() for f in ('board.kicad_pcb', 'board.kicad_pro', 'baseline-drc.json', 'board.kicad_dru', 'LICENSE')},
       "utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
(case / 'job.json').write_text(json.dumps(job, indent=2) + '\n')
print('case baseline', job['baseline'])
