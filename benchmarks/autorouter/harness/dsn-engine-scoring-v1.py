#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Thin standalone argv builder; captures actual argv for the enclosing timer."""
import argparse, json, os, pathlib, subprocess
ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / 'runtime/c'
HERE = pathlib.Path(__file__).resolve().parent

def argv(router, work, seed, cap, parity=False):
    manifest = json.loads((work / 'dsn-manifest.json').read_text())
    rules = manifest['native_rules']
    shared = ['--router.copper_to_edge_clearance_um=' + str(round(rules.get('min_copper_edge_clearance', 0)*1000)),
              '--router.hole_clearance_um=' + str(round(rules.get('min_hole_clearance', 0)*1000)),
              '--router.fanout.enabled=false']
    if manifest['ignore_classes']:
        shared += ['--router.autorouter.ignore_net_classes=' + ','.join(manifest['ignore_classes'])]
    if router == 'freerouting':
        java = ROOT / 'runtime/b/jdk/bin/java'
        # Track B currently publishes JDK 21; release 2.5.0 JAR class version is 69 (Java 25).
        if not java.exists() or 'JAVA_VERSION="21.' in (java.parent.parent/'release').read_text():
            java = BUILD / 'jdk/bin/java'
        return [str(java), '-Djava.awt.headless=true', '-jar',
                str(BUILD/'freerouting-2.5.0.jar'), '-cli', '-da', '-de', str(work/'board.dsn'),
                '-do', str(work/'board.ses'), '-mp', '100',
                '--router.automatic_neckdown=false', '--router.job_timeout=01:00:00'] + shared
    if router == 'fastroute':
        classes = sorted({n['class'] for n in manifest['net_rules'].values()})
        args = [str(BUILD/'fastroute'), '-de', str(work/'board.dsn'), '-do', str(work/'board.ses'),
                '-mp', '100', '--max-time='+str(cap),
                '--no-neckdown-classes='+','.join(classes), '--router.min_trace_width_um='+str(round(rules.get('min_track_width',0)*1000)),
                '--report='+str(work/'router-summary.json')] + shared
        if parity:
            args += ['--parity']
        if (work/'pairs.txt').read_text().strip():
            args += ['--pairs='+str(work/'pairs.txt')]
        return args
    return ['bun', str(HERE/'fab-route-standalone.ts'), str(work), str(seed), str(cap)]

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--router', required=True, choices=['freerouting','fastroute','fab-router'])
    p.add_argument('--work-dir', type=pathlib.Path, required=True)
    p.add_argument('--seed', type=int, required=True)
    p.add_argument('--cap-s', type=int, required=True)
    p.add_argument('--parity', action='store_true')
    a = p.parse_args()
    command = argv(a.router, a.work_dir.resolve(), a.seed, a.cap_s, a.parity)
    (a.work_dir/'engine-command.json').write_text(json.dumps(command, indent=2)+'\n')
    home = a.work_dir/'home'
    home.mkdir(exist_ok=True)
    env = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home/'config'),
               XDG_STATE_HOME=str(home/'state'), XDG_CACHE_HOME=str(home/'cache'),
               RAYON_NUM_THREADS='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1')
    raise SystemExit(subprocess.call(command, env=env, cwd=a.work_dir))
