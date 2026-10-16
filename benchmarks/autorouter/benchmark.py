#!/usr/bin/env python3
"""Run the original five-router comparison and produce results.json, summary.json and report.html."""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'harness'))
from report import report


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def read(path):
    return json.loads(path.read_text())


def runtime_sources():
    paths = [ROOT / 'runtime/c/fab-router-source/src', ROOT / 'runtime/d/kicad-routing-tools/source']
    return {str(p.relative_to(ROOT)): sha(p) for directory in paths for p in directory.rglob('*')
            if p.is_file() and p.suffix in ('.py', '.ts') and '__pycache__' not in p.parts}


def verify():
    expected = read(ROOT / 'inputs.sha256.json')
    bad = [p for p, digest in expected.items() if not (ROOT / p).is_file() or sha(ROOT / p) != digest]
    if bad:
        raise RuntimeError('Frozen benchmark input changed: ' + ', '.join(bad))
    suite = read(ROOT / 'suite.json')
    if sha(Path('/usr/bin/kicad-cli')) != suite['historical_kicad_cli_sha256']:
        raise RuntimeError('Install the original stock KiCad 10.0.6 runtime; see README.md')
    subprocess.run(['/usr/bin/python3', '-c', 'import pcbnew'], check=True, capture_output=True)
    if not shutil.which('bun'):
        raise RuntimeError('Bun 1.4+ is required')
    return suite


def run(args):
    suite = verify()
    if args.report:
        out = args.report.resolve()
        return report(out, suite, read(out / 'results.json'), read(out / 'controls.json'), render=True)
    from setup import install
    required = read(ROOT / 'engines.lock.json')['expected_binaries']
    if any(not (ROOT / 'runtime' / name).is_file() for name in required):
        install()
    if args.check:
        print(json.dumps({'ready': True, 'routers': suite['routers'], 'cases': len(suite['cases'])}))
        return 0
    cases = [c for c in suite['cases'] if not args.case or c['id'] in args.case]
    if not cases or (args.case and set(args.case) != {c['id'] for c in cases}):
        raise ValueError('Unknown case; use --list')
    if args.smoke and not args.case:
        cases = [c for c in cases if c['id'] == 'kitspace-solenoid-driver-j1']
    routers = args.router or suite['routers']
    seeds = [1] if args.smoke else suite['seeds']
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    out = args.out.resolve() if args.out else ROOT / 'results' / stamp
    out.mkdir(parents=True, exist_ok=False)
    configs = out / 'configs'
    configs.mkdir()
    for router in routers:
        config = (args.config_dir or ROOT / 'configs') / (router + '.json')
        write(configs / config.name, read(config))
        text = (configs / config.name).read_text().replace('{benchmark}', str(ROOT))
        (configs / config.name).write_text(text)
    spec = importlib.util.spec_from_file_location('runner', ROOT / 'harness/runner-scoring-v2.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    order = [dict(case=c['id'], router=r, seed=s) for c in cases for r in routers for s in seeds]
    random.Random('open-router-scoring-2026-10-09-v1').shuffle(order)
    controls = dict(version=suite['version'], utc_start=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    order=order, routers=routers, cases=cases, seeds=seeds, smoke=args.smoke,
                    full_suite=len(cases) == 26 and len(routers) == 5 and len(seeds) == 3,
                    inputs_sha256=sha(ROOT / 'inputs.sha256.json'), model=None,
                    configs_sha256={p.name: sha(p) for p in configs.glob('*.json')},
                    harness_sha256={p.name: sha(p) for p in (ROOT / 'harness').glob('*') if p.is_file()},
                    runtime_sha256={name: sha(ROOT / 'runtime' / name) for name in required},
                    runtime_source_sha256=runtime_sources(),
                    command=sys.argv, allowed_cpus=sorted(os.sched_getaffinity(0)),
                    load_before=os.getloadavg(), safety_stop_seconds=3600)
    if args.fab_router_source:
        module = args.fab_router_source.resolve() / 'src/api.ts'
        if not module.is_file():
            raise ValueError('Candidate must export src/api.ts routeDsn')
        os.environ['FAB_ROUTER_MODULE'] = str(module)
        controls['candidate'] = dict(path=str(args.fab_router_source.resolve()),
             commit=subprocess.check_output(['git', '-C', str(args.fab_router_source), 'rev-parse', 'HEAD'], text=True).strip(),
             source_sha256={str(p.relative_to(module.parents[1])): sha(p)
                            for p in module.parent.rglob('*') if p.is_file()})
    else:
        os.environ.pop('FAB_ROUTER_MODULE', None)
    write(out / 'controls.json', controls)
    by_id = {c['id']: c for c in cases}
    rows = []
    interrupted = False
    try:
        for n, slot in enumerate(order, 1):
            verify()
            case = by_id[slot['case']]
            attempt = 'run-' + stamp + '-%03d' % n
            print(f"[{n}/{len(order)}] {slot['router']} {slot['case']} repeat {slot['seed']}", flush=True)
            a = argparse.Namespace(router=slot['router'], fixture=ROOT / case['path'],
                                   attempt=attempt, seed=slot['seed'], out=out / 'runs', config_dir=configs)
            rec = runner.run(a)
            directory = out / 'runs' / attempt / slot['router']
            checked = read(directory / 'check.json') if (directory / 'check.json').exists() else {}
            row = dict(**slot, status=rec['status'], passed=rec.get('pass', False),
                       seconds=rec.get('route_pipeline_seconds'), vias=checked.get('vias'),
                       length_mm=checked.get('length_mm'), opens=checked.get('opens'),
                       new_errors=checked.get('new_errors'), new_error_types=checked.get('new_error_types'),
                       failed_fidelity=[k for k, v in checked.get('fidelity', {}).items() if v is False],
                       evidence=str(directory.relative_to(out)), check=checked)
            rows.append(row)
            write(out / 'results.json', rows)
            print(json.dumps({k: row[k] for k in ['router', 'case', 'status', 'passed', 'opens', 'new_errors']}), flush=True)
    except KeyboardInterrupt:
        interrupted = True
        # Original route steps start separate process groups. Stop our descendants as well.
        import signal
        _, descendants = runner.tree_rss(os.getpid(), {})
        for pid in descendants:
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
    finally:
        controls['controls_preserved'] = (
            controls['runtime_source_sha256'] == runtime_sources() and
            all((ROOT / 'runtime' / name).is_file() and sha(ROOT / 'runtime' / name) == digest
                for name, digest in controls['runtime_sha256'].items()))
        if args.fab_router_source:
            current = {str(p.relative_to(module.parents[1])): sha(p)
                       for p in module.parent.rglob('*') if p.is_file()}
            controls['controls_preserved'] &= current == controls['candidate']['source_sha256']
        controls.update(utc_end=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        interrupted=interrupted, load_after=os.getloadavg(),
                        complete=len(rows) == len(order))
        write(out / 'controls.json', controls)
        write(out / 'results.json', rows)
        report(out, suite, rows, controls, render=True)
    print(json.dumps(dict(results=str(out / 'results.json'), summary=str(out / 'summary.json'),
                          html=str(out / 'report.html'), complete=controls['complete'])), flush=True)
    return 2 if interrupted or not controls['controls_preserved'] or any(r['status'] not in ['checked', 'not_supported', 'did_not_finish'] for r in rows) else 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path)
    p.add_argument('--router', action='append', choices=read(ROOT / 'suite.json')['routers'])
    p.add_argument('--case', action='append')
    p.add_argument('--smoke', action='store_true', help='One small case, one repeat per selected router')
    p.add_argument('--check', action='store_true', help='Verify setup without starting routing')
    p.add_argument('--list', action='store_true')
    p.add_argument('--report', type=Path, help='Regenerate HTML/JSON from saved results, without routing')
    p.add_argument('--fab-router-source', type=Path, help='Use a candidate standalone fab_router checkout')
    p.add_argument('--config-dir', type=Path, help='Alternate per-router configurations; originals stay unchanged')
    args = p.parse_args()
    if args.list:
        print((ROOT / 'suite.json').read_text())
        return 0
    (ROOT / '.cache').mkdir(exist_ok=True)
    with (ROOT / '.cache/run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return run(args)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, FileExistsError, FileNotFoundError, BlockingIOError) as exc:
        print(json.dumps({'error': str(exc)}), file=sys.stderr)
        sys.exit(2)
