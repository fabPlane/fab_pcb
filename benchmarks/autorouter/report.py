#!/usr/bin/env python3
"""Offline comparison HTML and machine-readable scores using the original study formulas."""
import collections
import html
import json
from pathlib import Path
import statistics
import subprocess

ROOT = Path(__file__).resolve().parent
NAMES = {'freerouting': 'Freerouting', 'fastroute': 'fastroute', 'fab-router': 'fab_router',
         'tracemaker': 'TraceMaker', 'kicad-routing-tools': 'drandyhaas/KiCadRoutingTools'}
JOBS = {'J1': 'Whole board', 'J2': 'Reroute after an edit', 'J3': 'Power widths', 'J4': 'Keep a ground pour'}


def calculate(suite, rows, controls):
    indexed = collections.defaultdict(list)
    for row in rows:
        indexed[(row['case'], row['router'])].append(row)
    cases = []
    scores = {r: dict(eff=[], fast=[]) for r in controls['routers']}
    for case in controls['cases']:
        cells, valid = {}, {}
        for router in controls['routers']:
            runs = indexed[(case['id'], router)]
            complete = {r['seed'] for r in runs} == set(controls['seeds']) and len(runs) == len(controls['seeds'])
            passed = sum(r['passed'] for r in runs)
            reliable = complete and controls['seeds'] == [1, 2, 3] and all(r['passed'] for r in runs)
            cells[router] = dict(completed=len(runs), expected=len(controls['seeds']), passed=passed,
                                 reliable=reliable, runs=runs)
            if reliable:
                values = dict(vias=statistics.median(r['vias'] for r in runs),
                              length=statistics.median(r['length_mm'] for r in runs),
                              seconds=statistics.median(r['seconds'] for r in runs))
                valid[router] = values
                cells[router].update(values)
        if len(valid) >= 2:
            best_vias = min(x['vias'] for x in valid.values())
            best_length = min(x['length'] for x in valid.values())
            best_time = min(x['seconds'] for x in valid.values())
            for router, value in valid.items():
                eff = 50 * (best_vias + 1) / (value['vias'] + 1) + 50 * best_length / value['length']
                fast = 100 * best_time / value['seconds']
                scores[router]['eff'].append(eff)
                scores[router]['fast'].append(fast)
        cases.append(dict(case, cells=cells))
    totals = []
    for router in controls['routers']:
        own = [r for r in rows if r['router'] == router]
        score = scores[router]
        totals.append(dict(id=router, name=NAMES[router], valid_runs=sum(r['passed'] for r in own),
                           completed_runs=len(own), expected_runs=len(controls['cases']) * len(controls['seeds']),
                           valid_cases=sum(c['cells'][router]['reliable'] for c in cases), cases=len(cases),
                           efficient=round(statistics.mean(score['eff'])) if score['eff'] else None,
                           fast=round(statistics.mean(score['fast'])) if score['fast'] else None,
                           scored_cases=len(score['eff']),
                           jobs={j: dict(valid=sum(c['cells'][router]['reliable'] for c in cases if c['job'] == j),
                                         cases=sum(c['job'] == j for c in cases)) for j in JOBS}))
    totals.sort(key=lambda r: (-r['valid_cases'], -(r['efficient'] or 0), -(r['fast'] or 0)))
    failures = [dict(case=r['case'], router=r['router'], seed=r['seed'], status=r['status'],
                     opens=r.get('opens'), new_errors=r.get('new_errors'),
                     new_error_types=r.get('new_error_types'), failed_fidelity=r.get('failed_fidelity'),
                     evidence=r.get('evidence')) for r in rows if not r['passed']]
    return dict(version=suite['version'], complete=controls['complete'], full_suite=controls['full_suite'],
                controls_preserved=controls.get('controls_preserved', True),
                smoke=controls['smoke'], expected_runs=len(controls['order']), completed_runs=len(rows),
                valid_runs=sum(r['passed'] for r in rows), routers=totals, cases=cases,
                failures=failures, jobs=JOBS, controls='controls.json',
                caveat='Valid cases require 3/3. Efficiency and time scores use medians, only on cases with at least two routers passing 3/3. Close timing differences require matched idle-machine runs.')


def svg(board, target):
    if target.exists():
        return True
    if not board.is_file():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    cmd = ['/usr/bin/kicad-cli', 'pcb', 'export', 'svg', '--layers', 'F.Cu,B.Cu,Edge.Cuts',
           '--page-size-mode', '2', '--exclude-drawing-sheet', '--mode-single', '-o', str(target), str(board)]
    result = subprocess.run(cmd, capture_output=True, timeout=120)
    target.with_suffix('.stderr.log').write_bytes(result.stderr)
    return result.returncode == 0 and target.exists()


def report(out, suite, rows, controls, render=True):
    data = calculate(suite, rows, controls)
    if render:
        for case in data['cases']:
            target = out / 'boards' / case['id']
            if svg(ROOT / case['path'] / 'board.kicad_pcb', target / 'input.svg'):
                case['input_svg'] = str((target / 'input.svg').relative_to(out))
            for router, cell in case['cells'].items():
                runs = sorted(cell['runs'], key=lambda r: (not r['passed'], r['seed']))
                if not runs:
                    continue
                chosen = runs[0]
                board = out / chosen['evidence'] / 'final.kicad_pcb'
                # For pours, show the checker-refilled geometry rather than stale raw fill.
                refilled = board.parent / 'refilled.kicad_pcb'
                if refilled.exists():
                    board = refilled
                if svg(board, target / (router + '.svg')):
                    cell['svg'] = str((target / (router + '.svg')).relative_to(out))
                    cell['shown_seed'] = chosen['seed']
    (out / 'summary.json').write_text(json.dumps(data, indent=2) + '\n')
    markup = TEMPLATE.replace('__DATA__', json.dumps(data).replace('</', '<\\/'))
    (out / 'report.html').write_text(markup)
    label = 'Smoke test' if data['smoke'] else ('Full comparison' if data['full_suite'] else 'Subset')
    lines = [f'# {label}', '', f"{data['completed_runs']}/{data['expected_runs']} attempts completed; {data['valid_runs']} valid.", '',
             '[Open comparison visualization](report.html) · [Machine-readable results](summary.json)', '',
             '| Router | Valid runs | Tasks passing 3/3 | Efficient | Fast |', '| --- | ---: | ---: | ---: | ---: |']
    lines += [f"| {r['name']} | {r['valid_runs']}/{r['expected_runs']} | {r['valid_cases']}/{r['cases']} | {r['efficient']} | {r['fast']} |"
              for r in data['routers']]
    lines += ['', data['caveat'], '']
    (out / 'README.md').write_text('\n'.join(lines))
    return 0


TEMPLATE = r'''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorouter comparison</title><style>
:root{font:16px/1.5 system-ui,sans-serif;color:#172331;background:#f4f6f8}body{max-width:1260px;margin:32px auto;padding:0 22px}h1{font-size:32px;letter-spacing:-.8px;margin-bottom:4px}h2{font-size:21px}p{max-width:900px}.muted,small{color:#586674}a{color:#1a567e}section{background:white;border:1px solid #dae1e7;border-radius:12px;padding:22px;margin:22px 0}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;white-space:nowrap;text-align:left}td,th{padding:10px 12px;border-bottom:1px solid #e6ebef}th{font-size:13px;color:#586674}.bar{height:7px;background:#e9eef1;border-radius:5px;width:130px}.bar i{display:block;background:#167868;height:100%;border-radius:5px}.ok{color:#127056}.bad{color:#a54137}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{border:1px solid #dce3e8;border-radius:9px;padding:14px;min-width:0}.card h3{font-size:16px;margin:0 0 8px}.board{background:#fbfcfd;aspect-ratio:1.35;display:flex;align-items:center;justify-content:center;border-radius:5px;margin:10px 0}.board img{width:100%;height:100%;object-fit:contain}.metrics{font-size:13px;color:#465667}.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center}select{font:inherit;padding:8px;max-width:100%;border:1px solid #b9c7d0;border-radius:6px;background:white}details{margin-top:16px}summary{cursor:pointer;color:#33576c}#mode{color:#526370}footer{font-size:13px;color:#586674;margin:28px 0}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:540px){body{margin:18px auto;padding:0 12px}h1{font-size:27px}section{padding:16px}.grid{grid-template-columns:1fr}td,th{padding:8px}.controls{display:block}select{margin:5px 0;width:100%}}
</style><h1>Autorouter comparison</h1><div id="mode"></div><p id="result"></p>
<section><h2>Results</h2><div class="scroll"><table><thead><tr><th>Router</th><th>Valid runs</th><th>Tasks passing 3/3</th><th>Efficient</th><th>Fast</th></tr></thead><tbody id="totals"></tbody></table></div><p class="muted" id="scope"></p></section>
<section><h2>Task outcomes</h2><div class="scroll"><table id="jobs"></table></div></section>
<section><h2>Compare boards</h2><div class="controls"><label for="case">Task</label><select id="case"></select></div><p id="case-info" class="muted"></p><div class="grid" id="boards"></div><details><summary>Run evidence and failures</summary><div class="scroll"><table><thead><tr><th>Router</th><th>Repeat</th><th>Result</th><th>Opens</th><th>New errors</th><th>Evidence</th></tr></thead><tbody id="runs"></tbody></table></div></details></section>
<details><summary>Scoring and evidence boundary</summary><p id="method"></p><p>J2 copper measurements include retained copper. The original strict zone contract is used. Aquarius J3 is excluded, so this suite has no USB coupling test. These are public development boards; no electrical or manufacturing acceptance is claimed.</p><p><a href="summary.json">Summary JSON</a> · <a href="results.json">Every run</a> · <a href="controls.json">Versions and settings</a></p></details><footer>Standalone engines · Native KiCad checks · No model calls</footer>
<script>const D=__DATA__;
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=x=>x==null?'—':Number(x).toFixed(1);
document.getElementById('mode').textContent=(D.smoke?'Smoke test':D.full_suite?'Full comparison':'Subset')+' · '+(D.complete?'finished':'incomplete')+(D.controls_preserved?'':' · INVALID: runtime/source changed');
document.getElementById('result').textContent=`${D.valid_runs} valid outputs from ${D.completed_runs} completed attempts; ${D.expected_runs} scheduled.`;
document.getElementById('totals').innerHTML=D.routers.map(r=>`<tr><td><b>${esc(r.name)}</b></td><td>${r.valid_runs}/${r.expected_runs}<div class="bar"><i style="width:${100*r.valid_runs/r.expected_runs}%"></i></div></td><td>${D.smoke?'One repeat only':r.valid_cases+'/'+r.cases}</td><td>${esc(r.efficient)}</td><td>${esc(r.fast)}</td></tr>`).join('');
document.getElementById('scope').textContent=D.smoke?'Setup check only. Three repeats are required for task validity and comparison scores.':'Valid tasks pass all three repeats. Efficiency and speed are compared only between routers valid on the same task.';
document.getElementById('jobs').innerHTML='<thead><tr><th>Task</th>'+D.routers.map(r=>'<th>'+esc(r.name)+'</th>').join('')+'</tr></thead><tbody>'+Object.entries(D.jobs).map(([j,name])=>'<tr><td>'+esc(name)+'</td>'+D.routers.map(r=>'<td>'+(D.smoke?'—':r.jobs[j].valid+'/'+r.jobs[j].cases)+'</td>').join('')+'</tr>').join('')+'</tbody>';
document.getElementById('method').textContent=D.caveat+' Efficient = 50 × (best vias + 1)/(vias + 1) + 50 × best length/length. Fast = 100 × fastest time/time. Scores average the eligible cases; they are descriptive on a shared machine.';
const select=document.getElementById('case');select.innerHTML=D.cases.map((c,i)=>`<option value="${i}">${esc(c.id)}</option>`).join('');
function draw(){const c=D.cases[Number(select.value)];if(!c)return;document.getElementById('case-info').textContent=D.jobs[c.job]+' · '+c.tier+' · '+c.board_id;
let cards=`<article class="card"><h3>Input</h3><div class="board">${c.input_svg?'<img alt="Input board" src="'+esc(c.input_svg)+'">':'Input render unavailable'}</div></article>`;
for(const r of D.routers){const cell=c.cells[r.id],shown=cell.runs.find(x=>x.seed===cell.shown_seed)||cell.runs[0];cards+=`<article class="card"><h3>${esc(r.name)}</h3><span class="${cell.passed===cell.expected?'ok':'bad'}">${cell.passed}/${cell.expected} valid runs</span><div class="board">${cell.svg?'<img loading="lazy" alt="'+esc(r.name)+' routed board" src="'+esc(cell.svg)+'">':'No native output'}</div><div class="metrics">${shown?`${esc(shown.vias)} vias · ${num(shown.length_mm)} mm · ${num(shown.seconds)} s<br>${esc(shown.opens)} opens · ${esc(shown.new_errors)} new errors · repeat ${esc(cell.shown_seed??shown.seed)}`:'Pending'}</div></article>`}
document.getElementById('boards').innerHTML=cards;document.getElementById('runs').innerHTML=D.routers.flatMap(r=>c.cells[r.id].runs.map(x=>`<tr><td>${esc(r.name)}</td><td>${x.seed}</td><td class="${x.passed?'ok':'bad'}">${x.passed?'Valid':esc(x.status)}</td><td>${esc(x.opens)}</td><td>${esc(x.new_errors)}</td><td><a href="${esc(x.evidence)}/check.json">Native check</a> · <a href="${esc(x.evidence)}/record.json">Record</a></td></tr>`)).join('')}
select.addEventListener('change',draw);draw();</script></html>'''
