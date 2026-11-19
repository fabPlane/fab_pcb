#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Thin standalone orchestration for pinned native routers; no engine patches.

Every required stage is a config-visible timer step. Actual subprocess argv,
timestamps and environment are also logged inside the route step.
"""
import argparse, ast, datetime, importlib.util, json, os, pathlib, re, shutil, subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
BUILD = ROOT/'runtime/d'

class UnsupportedInput(RuntimeError):
    pass

def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def invoke(argv, work, name, cap=120):
    env = os.environ.copy()
    # Preserve runner v5.1's isolated HOME/XDG paths under ignored builds/.
    env.update(KICAD_INRUN_FLOOR_SYNC='0',KICAD_SMOOTH_ROUTE='0',
        KICAD_RIP_PREEXISTING='0',KICAD_FINALIZE_RIP='0')
    rec = dict(argv=list(map(str,argv)),utc_start=stamp(),cpu=min(os.sched_getaffinity(0)),
        environment={k:env[k] for k in ('KICAD_INRUN_FLOOR_SYNC','KICAD_SMOOTH_ROUTE',
        'KICAD_RIP_PREEXISTING','KICAD_FINALIZE_RIP')})
    with (work/(name+'.stdout.log')).open('wb') as stdout, (work/(name+'.stderr.log')).open('wb') as stderr:
        try:
            p = subprocess.run(list(map(str,argv)),env=env,cwd=work,stdout=stdout,stderr=stderr,
                timeout=3600)
            rec['exit_code'] = p.returncode
        except subprocess.TimeoutExpired:
            rec.update(exit_code=None,timed_out=True)
    rec['utc_end'] = stamp()
    (work/(name+'.command.json')).write_text(json.dumps(rec,indent=2)+'\n')
    if rec['exit_code'] != 0:
        raise RuntimeError(name+' failed; see command/log record')

def module(filename):
    spec = importlib.util.spec_from_file_location('native_format',HERE/filename)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod

def project_copy(src, dst):
    for ext in ('kicad_pro','kicad_dru'):
        if src.with_suffix('.'+ext).exists():
            shutil.copyfile(src.with_suffix('.'+ext), dst.with_suffix('.'+ext))

def prepare(router, fixture, work):
    work.mkdir(parents=True,exist_ok=True)
    source = fixture/'board.kicad_pcb'
    board = work/'input.kicad_pcb'
    project_copy(source,board)
    if router == 'tracemaker':
        if not module('native-router-format-v2.py').gate(source,board,BUILD/'tracemaker/tracemaker',work/'format-gate')['pass']:
            raise UnsupportedInput('TraceMaker format fidelity gate failed')
    else:
        # Mirror the pinned KRT parser's supported input-version gate, without
        # introducing a converter or claiming a rejected format is a route loss.
        version=re.search(r'\(version\s+(\d+)\)',source.read_text())
        if version and 0<int(version.group(1))<20201115:
            raise UnsupportedInput('KRT CLI requires board format >=20201115; input version '+version.group(1)+' is unsupported; no additional format converter authorized')
        shutil.copyfile(source,board)

def powers(job):
    specs = job.get('power_nets',[])
    if isinstance(specs,dict):
        return list(specs),list(specs.values())
    return [s.get('name',s.get('net')) for s in specs],[s.get('min_width_mm',s.get('minimum_width_mm')) for s in specs]

def validate_pairs(router,job,board,work,cap):
    if job['job']!='J3' or not job.get('pairs'):
        return
    if router=='tracemaker':
        invoke([BUILD/'tracemaker/tracemaker','pairs',board,'--json',work/'pair-discovery.json'],work,'pair-discovery',cap)
        found=json.loads((work/'pair-discovery.json').read_text())['pairs']
        for pair in job['pairs']:
            match=next((p for p in found if {p['net_a'],p['net_b']}=={pair['p'],pair['n']}),None)
            if not match:
                raise UnsupportedInput('declared pair not discovered by TraceMaker name interface')
            for field,engine in [('width','width_mm'),('gap','target_gap_mm')]:
                desired=pair.get(field+'_mm',pair.get(field))
                if desired is not None and abs(desired-match[engine])>1e-6:
                    raise UnsupportedInput('declared pair '+field+' differs from native rule readback')
    else:
        # Use the pinned engine's pure discovery routine without modifying it.
        source=BUILD/'kicad-routing-tools/source/py_router/net_queries.py'
        tree=ast.parse(source.read_text())
        node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='extract_diff_pair_base')
        namespace={}
        tree=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),node],type_ignores=[])
        exec(compile(ast.fix_missing_locations(tree),str(source),'exec'),namespace)
        extract=namespace['extract_diff_pair_base'];discovered=[]
        for pair in job['pairs']:
            p,n=extract(pair['p']),extract(pair['n'])
            ok=p and n and p[0]==n[0] and p[2]==n[2] and p[1] and not n[1]
            discovered.append(dict(pair=pair,p_discovery=p,n_discovery=n,supported=bool(ok)))
        (work/'pair-discovery.json').write_text(json.dumps(discovered,indent=2)+'\n')
        if not all(p['supported'] for p in discovered):
            raise UnsupportedInput('declared pair not discovered by KRT name interface')

def route(router, fixture, work, output, seed, cap):
    job = json.loads((fixture/'job.json').read_text())
    board = work/'input.kicad_pcb'
    validate_pairs(router,job,board,work,cap)
    if router == 'tracemaker':
        argv = [BUILD/'tracemaker/tracemaker','route',board,'-o',output,
            '--time',str(cap),'--seed',str(seed),
            '--no-gpu','--no-kb','--json',work/'router-summary.json']
        if os.environ.get('OPEN_ROUTER_TM_VIA_COST_MM'):
            argv.extend(['--via-cost-mm',os.environ['OPEN_ROUTER_TM_VIA_COST_MM']])
        if job['job'] == 'J2':
            # CLI exclusion interface: complement of the requested set.
            import pcbnew
            b = pcbnew.LoadBoard(str(board))
            for net in b.GetNetInfo().NetsByNetcode().values():
                if net.GetNetname() and net.GetNetname() not in job['target_nets']:
                    argv.extend(['--skip-net',net.GetNetname()])
        if job['job'] == 'J3':
            argv.append('--diff-pairs')
        if job['job'] in ('J2','J4'):
            argv.append('--soft-zones')
        invoke(argv,work,'route',cap+5)
    else:
        runtime = BUILD/'kicad-routing-tools'
        grid=os.environ.get('OPEN_ROUTER_KRT_GRID_STEP_MM','0.1')
        common = ['--fab-tier','standard','--layers','F.Cu','B.Cu','--grid-step',grid,
            '--no-fix-drc-settings','--keep-input-copper','--no-power-tap-neckdown',
            '--neckdown-length','0']
        if job['job'] == 'J3' and job.get('pairs'):
            # Only name-discovered pairs: no relabeling/converter is allowed here.
            for idx,pair in enumerate(job['pairs']):
                nxt = work/('pair-'+str(idx)+'.kicad_pcb')
                project_copy(board,nxt)
                argv = [runtime/'venv/bin/python',runtime/'source/py_router/route_diff.py',
                    board,nxt,'--nets',pair['p'],pair['n'],
                    '--fab-tier','standard','--layers','F.Cu','B.Cu','--grid-step',grid,
                    '--no-fix-drc-settings','--keep-input-copper',
                    '--track-width',str(pair.get('width_mm',pair.get('width'))),
                    '--diff-pair-gap',str(pair.get('gap_mm',pair.get('gap')))]
                invoke(argv,work,'pair-'+str(idx),cap)
                board = nxt
        argv = [runtime/'venv/bin/python',runtime/'source/py_router/route.py',board,output,
            '--nets',*(job['target_nets'] if job['job']=='J2' else ['*']),
            *common,'--no-smoothing','--json-out',work/'router-summary.json']
        # Widths come from project netclasses and declared power specs; no global
        # --track-width override, which would suppress per-class widths in KRT.
        names,widths = powers(job) if job['job']=='J3' else ([],[])
        if names:
            argv.extend(['--power-nets',*names,'--power-nets-widths',*map(str,widths)])
        invoke(argv,work,'route',cap)

def finish(fixture,work,output):
    # Preserve returned sidecars before checking; never accept changed rules.
    returned = work/'returned-rules';returned.mkdir(exist_ok=False)
    report = {}
    for ext in ('kicad_pro','kicad_dru'):
        src = fixture/('board.'+ext);dst = output.with_suffix('.'+ext)
        if dst.exists():
            shutil.copyfile(dst,returned/dst.name)
            report[ext] = dict(returned=True,unchanged=dst.read_bytes()==src.read_bytes())
        else:
            report[ext] = dict(returned=False,unchanged=None)
    (work/'returned-rule-check.json').write_text(json.dumps(report,indent=2)+'\n')
    if any(r['unchanged'] is False for r in report.values()):
        raise RuntimeError('router rewrote project/custom rules; output retained, not repaired')
    project_copy(fixture/'board.kicad_pcb',output)
    if json.loads((fixture/'job.json').read_text())['job'] == 'J4':
        # Required native refill is inside the timed post step; preserve raw board.
        shutil.copyfile(output,work/'before-refill.kicad_pcb')
        import pcbnew
        b=pcbnew.LoadBoard(str(output));b.BuildConnectivity()
        pcbnew.ZONE_FILLER(b).Fill(b.Zones());pcbnew.SaveBoard(str(output),b)
        # Stock native save also rewrites project serialization. Preserve that
        # intermediate sidecar, then restore the supplied frozen rules inside
        # this timed post step. Engine-returned changes were rejected above.
        native_sidecars=work/'native-refill-sidecars';native_sidecars.mkdir()
        for ext in ('kicad_pro','kicad_dru'):
            sidecar=output.with_suffix('.'+ext)
            if sidecar.exists():shutil.copyfile(sidecar,native_sidecars/sidecar.name)
        project_copy(fixture/'board.kicad_pcb',output)

if __name__ == '__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('stage',choices=['prepare','route','finish'])
    ap.add_argument('--router',choices=['tracemaker','kicad-routing-tools'],required=True)
    ap.add_argument('--input-dir',type=pathlib.Path,required=True)
    ap.add_argument('--work-dir',type=pathlib.Path,required=True)
    ap.add_argument('--output-pcb',type=pathlib.Path,required=True)
    ap.add_argument('--seed',type=int,default=1)
    ap.add_argument('--cap-s',type=float,default=120)
    args=ap.parse_args()
    fixture,work,output=[p.resolve() for p in (args.input_dir,args.work_dir,args.output_pcb)]
    try:
        if args.stage=='prepare':prepare(args.router,fixture,work)
        elif args.stage=='route':route(args.router,fixture,work,output,args.seed,args.cap_s)
        else:finish(fixture,work,output)
    except UnsupportedInput as exc:
        (work/'support-gate.json').write_text(json.dumps(dict(support='no',reason=str(exc),utc=stamp()),indent=2)+'\n')
        raise SystemExit(2)
