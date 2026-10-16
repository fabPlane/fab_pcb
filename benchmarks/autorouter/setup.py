#!/usr/bin/env python3
"""Install the pinned standalone routers; never uses a Fabdesk/FabPCB runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / 'runtime'


def check_platform():
    if sys.platform != 'linux' or platform.machine().lower() not in ('x86_64', 'amd64'):
        raise RuntimeError('The reference benchmark currently requires Linux x86-64. '
                           'Native macOS needs compatibility work; see SETUP.md. '
                           'No router assets were installed.')


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def download(url, digest, name):
    cache = ROOT / '.cache/downloads'
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / name
    if not path.exists():
        print('Downloading ' + name, flush=True)
        with urllib.request.urlopen(url, timeout=120) as response, path.open('xb') as output:
            shutil.copyfileobj(response, output)
    if sha(path) != digest:
        raise RuntimeError('Download checksum mismatch: ' + str(path))
    return path


def extract(archive, target):
    stage = ROOT / '.cache/unpack' / target.name
    stage.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive) as tar:
        tar.extractall(stage, filter='data')
    children = [p for p in stage.iterdir() if not p.name.startswith('._')]
    if len(children) != 1 or not children[0].is_dir():
        raise RuntimeError('Expected one source directory in ' + str(archive))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(children[0]), target)
    stage.rmdir()


def source_download(spec, target):
    if target.exists():
        return
    item = next(d for d in spec['downloads'] if '/tarball/' in d['url'])
    extract(download(item['url'], item['sha256'], spec['name'] + '-source.tar.gz'), target)


def install(existing=None):
    check_platform()
    lock = json.loads((ROOT / 'engines.lock.json').read_text())
    if existing:
        # Copy; no symlinks into another active checkout or old evaluation directory.
        for name in ['b/jdk', 'c/fab-router-source', 'd/kicad-routing-tools']:
            target = RUNTIME / name
            if not target.exists():
                shutil.copytree(existing / name, target, symlinks=True,
                                ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc'))
        for name in ['c/freerouting-2.5.0.jar', 'c/fastroute', 'd/tracemaker/tracemaker']:
            target = RUNTIME / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(existing / name, target)
        for name, expected in lock['expected_binaries'].items():
            if sha(RUNTIME / name) != expected:
                raise RuntimeError('Copied engine differs from comparison: ' + name)
        print('Installed original comparison runtimes.', flush=True)
        return
    jdk = RUNTIME / 'b/jdk'
    if not jdk.exists():
        item = lock['java']
        extract(download(item['url'], item['sha256'], 'jdk25.tar.gz'), jdk)
    jar = RUNTIME / 'c/freerouting-2.5.0.jar'
    if not jar.exists():
        jar.parent.mkdir(parents=True, exist_ok=True)
        url = 'https://github.com/freerouting/freerouting/releases/download/v2.5.0/freerouting-2.5.0.jar'
        shutil.copyfile(download(url, lock['expected_binaries']['c/freerouting-2.5.0.jar'], jar.name), jar)
    fast = RUNTIME / 'c/fastroute'
    if not fast.exists():
        item = next(d for d in lock['routers']['fastroute']['downloads'] if 'linux-x64.tar.gz' in d['url'])
        archive = download(item['url'], item['sha256'], 'fastroute.tar.gz')
        with tarfile.open(archive) as tar:
            member = next(m for m in tar.getmembers() if Path(m.name).name == 'fastroute')
            with tar.extractfile(member) as source, fast.open('xb') as output:
                shutil.copyfileobj(source, output)
        fast.chmod(0o755)
    source_download(lock['routers']['fab-router'], RUNTIME / 'c/fab-router-source')
    tm = RUNTIME / 'd/tracemaker'
    source_download(lock['native_sources']['tracemaker'], tm / 'source')
    if not (tm / 'tracemaker').exists():
        subprocess.run(['cmake', '-S', str(tm / 'source'), '-B', str(tm / 'build'),
                        '-DCMAKE_BUILD_TYPE=Release', '-DTM_ENABLE_CUDA=OFF', '-DTM_ENABLE_METAL=OFF',
                        '-DTM_BUILD_TESTS=OFF', '-DTM_BUILD_PYTHON=OFF', '-DTM_WERROR=OFF'], check=True)
        subprocess.run(['cmake', '--build', str(tm / 'build'), '--target', 'tracemaker', '-j2'], check=True)
        shutil.copy2(tm / 'build/src/app/tracemaker', tm / 'tracemaker')
    krt = RUNTIME / 'd/kicad-routing-tools'
    spec = lock['native_sources']['kicad-routing-tools']
    source_download(spec, krt / 'source')
    grid = krt / 'source/rust_router/grid_router.so'
    if not grid.exists():
        item = next(d for d in spec['downloads'] if d['url'].endswith('.so'))
        shutil.copyfile(download(item['url'], item['sha256'], 'grid_router.so'), grid)
    if not (krt / 'venv/bin/python').exists():
        subprocess.run(['/usr/bin/python3', '-m', 'venv', '--system-site-packages', str(krt / 'venv')], check=True)
        subprocess.run([str(krt / 'venv/bin/python'), '-m', 'pip', 'install', '-r',
                        str(ROOT / 'requirements-lock.txt')], check=True)
    print('Standalone router setup complete.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-comparison', type=Path, help='Existing original standalone runtime directory')
    install(parser.parse_args().from_comparison)
