#!/usr/bin/env python3
"""Create an alternate benchmark config; never edit the frozen configuration."""
import argparse
import json
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', type=Path, required=True,
                        help='Checkout containing tools/native-thermal-search.ts')
    parser.add_argument('--out', type=Path, required=True, help='New configuration directory')
    args = parser.parse_args()
    engine = args.engine.resolve()
    if not (engine / 'tools/native-thermal-search.ts').is_file():
        parser.error('Engine checkout lacks the native thermal search command')
    root = Path(__file__).resolve().parents[3]
    shutil.copytree(root / 'benchmarks/autorouter/configs', args.out)
    target = args.out / 'fab-router.json'
    config = json.loads(target.read_text())
    for job in config['jobs'].values():
        job['post_steps'].append([
            shutil.which('bun') or 'bun',
            str(Path(__file__).with_name('native-thermal-postprocess.ts')),
            '{input_dir}/board.kicad_pcb', '{output_pcb}', str(engine),
            '{work_dir}/native-thermal-postprocess',
        ])
    target.write_text(json.dumps(config, indent=2) + '\n')


if __name__ == '__main__':
    main()
