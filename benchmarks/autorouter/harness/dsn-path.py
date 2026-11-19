#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-only
"""Common stock-KiCad DSN export and SES import. Native inputs are never edited."""
import argparse, collections, fnmatch, hashlib, json, pathlib, re, shutil
import pcbnew

def copper(b):
    result = []
    for t in b.GetTracks():
        if isinstance(t, pcbnew.PCB_VIA):
            result.append((t.GetNetname(), 'via', t.GetPosition().x, t.GetPosition().y,
                           t.GetWidth(t.TopLayer()), t.GetDrillValue(), t.TopLayer(), t.BottomLayer()))
        else:
            ends = sorted([(t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y)])
            result.append((t.GetNetname(), 'track', *ends[0], *ends[1], t.GetWidth(), t.GetLayer()))
    return collections.Counter(result)

def export(input_dir, work):
    work.mkdir(parents=True, exist_ok=True)
    for ext in ('kicad_pcb', 'kicad_pro', 'kicad_dru'):
        shutil.copyfile(input_dir / ('board.' + ext), work / ('board.' + ext))
    job = json.loads((input_dir / 'job.json').read_text())
    project = json.loads((input_dir / 'board.kicad_pro').read_text())
    b = pcbnew.LoadBoard(str(work / 'board.kicad_pcb'))
    settings = b.GetDesignSettings()
    rules = project['board']['design_settings']['rules']
    settings.m_MinClearance = pcbnew.FromMM(rules.get('min_clearance', 0))
    settings.m_CopperEdgeClearance = pcbnew.FromMM(rules.get('min_copper_edge_clearance', 0))
    nc = settings.m_NetSettings
    nc.ClearNetclassPatternAssignments()
    nc.ClearNetclassLabelAssignments()
    nc.ClearAllCaches()
    classes = project['net_settings']['classes']
    default = next(c for c in classes if c['name'] == 'Default')
    patterns = project['net_settings'].get('netclass_patterns', [])
    assignments = project['net_settings'].get('netclass_assignments') or {}
    target = set(job.get('target_nets', []))
    power = {p['name']: p.get('min_width_mm', p.get('minimum_width_mm')) for p in job.get('power_nets', [])}
    effective, ignored = {}, set()
    for code, net in b.GetNetsByNetcode().items():
        name = net.GetNetname()
        if not name:
            continue
        matches = [p['netclass'] for p in patterns if fnmatch.fnmatchcase(name, p['pattern'])]
        assigned = assignments.get(name)
        if assigned:
            matches.extend(assigned if isinstance(assigned, list) else [assigned])
        if len(set(matches)) > 1:
            raise ValueError('Composite netclasses need an explicit shared rule mapping: ' + name)
        c = next((c for c in classes if matches and c['name'] == matches[0]), default)
        width = max(c['track_width'], rules.get('min_track_width', 0), power.get(name, 0))
        clearance = max(c['clearance'], rules.get('min_clearance', 0))
        # One class per net preserves class rules while expressing the same J2 scope to all engines.
        cname = (('kept_' if name not in target else 'route_') + str(code)) if job['job'] == 'J2' else ('kicad_default' if c['name']=='Default' else c['name'])
        if name in power and power[name] > c['track_width']:
            cname = 'power_' + str(code)
        klass = pcbnew.NETCLASS(cname)
        for setter, value in [('SetTrackWidth', width), ('SetClearance', clearance),
                              ('SetViaDiameter', c['via_diameter']), ('SetViaDrill', c['via_drill'])]:
            getattr(klass, setter)(pcbnew.FromMM(value))
        nc.SetNetclass(cname, klass)
        nc.SetNetclassPatternAssignment(name, cname)
        effective[name] = {'class': cname, 'width_mm': width, 'clearance_mm': clearance,
                           'via_diameter_mm': c['via_diameter'], 'via_drill_mm': c['via_drill']}
        if cname.startswith('kept_'):
            ignored.add(cname)
    nc.RecomputeEffectiveNetclasses()
    if not pcbnew.ExportSpecctraDSN(b, str(work / 'board.dsn')):
        raise RuntimeError('DSN export failed')
    text = (work / 'board.dsn').read_text()
    text = re.sub(r'^\(pcb "[^"]*"', '(pcb "board.dsn"', text)
    # Remove KiCad exporter SMD-clearance concession and supply native edge floor,
    # consistently for all engines, as the previous controlled CH340G export did.
    clearance = round(max(c['clearance_mm'] for c in effective.values())*1000)
    text = re.sub(r'\(clearance [0-9.]+ \(type smd_smd\)\)', '(clearance %s (type smd_smd))' % clearance, text)
    edge = round(rules.get('min_copper_edge_clearance',0)*1000)
    text = text.replace('(clearance %s (type smd_smd))' % clearance, '(clearance %s (type smd_smd))\n      (clearance %s (type wire_area))' % (clearance,edge), 1)
    (work / 'board.dsn').write_text(text)
    # KiCad exports existing copper as normal, independent of PCB lock state. A common
    # harness transformation declares ALL kept J2 wiring fixed without changing geometry.
    if job['job'] == 'J2':
        if any(t.GetNetname() in target for t in b.GetTracks()):
            raise ValueError('J2 input still contains target copper')
        start = text.index('  (wiring')
        text = text[:start] + re.sub(r'\(type (?:normal|route)\)', '(type fix)', text[start:])
        (work / 'board.dsn').write_text(text)
    manifest = {'kicad': pcbnew.Version(), 'job': job['job'], 'net_rules': effective,
                'ignore_classes': sorted(ignored), 'native_rules': rules,
                'dsn_sha256': hashlib.sha256((work / 'board.dsn').read_bytes()).hexdigest(),
                'fixed_items': text.count('(type fix)'), 'planes': text.count('(plane '),
                'limits': ['Conditional KiCad custom rules, zone priority/thermal semantics and pair constraints are not fully serialized; native files remain authoritative.']}
    (work / 'dsn-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (work / 'pairs.txt').write_text(''.join('pair %s %s gap=%s\n' % (p['p'], p['n'], p.get('gap', p.get('gap_mm'))) for p in job.get('pairs', [])))

def import_ses(input_dir, work, output):
    job = json.loads((input_dir / 'job.json').read_text())
    b = pcbnew.LoadBoard(str(input_dir / 'board.kicad_pcb'))
    before = copper(b)
    target = set(job.get('target_nets', []))
    retained = [t.Duplicate() for t in b.GetTracks() if t.GetNetname() not in target] if job['job']=='J2' else []
    if not pcbnew.ImportSpecctraSES(b, str(work / 'board.ses')):
        raise RuntimeError('SES import failed')
    # Standard shared scoped merge: engines omit SYSTEM_FIXED wiring from SES,
    # but native import clears all input tracks. Reattach exact native kept objects.
    # Never discard unexpected engine copper or deduplicate an engine result.
    if job['job']=='J2':
        if any(t.GetNetname() not in target for t in b.GetTracks()):
            raise ValueError('SES unexpectedly emitted off-target copper; scoped merge refused')
        for t in retained:
            b.Add(t)
    after = copper(b)
    kept = set(k[0] for k in before) - set(job.get('target_nets', [])) if job['job'] == 'J2' else set()
    a = collections.Counter({k:v for k,v in before.items() if k[0] in kept})
    z = collections.Counter({k:v for k,v in after.items() if k[0] in kept})
    report = {'kept_missing': sum((a-z).values()), 'kept_added_or_duplicated': sum((z-a).values()),
              'zones_before': pcbnew.LoadBoard(str(input_dir / 'board.kicad_pcb')).GetAreaCount(),
              'zones_after_import': b.GetAreaCount(), 'native_kept_objects_reattached': len(retained),
              'merge_policy': 'reject off-target SES copper; reattach exact native kept copper' if job['job']=='J2' else 'plain native SES import'}
    if job['job'] == 'J4':
        b.BuildConnectivity()
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    output.parent.mkdir(parents=True, exist_ok=True)
    pcbnew.SaveBoard(str(output), b)
    for ext in ('kicad_pro', 'kicad_dru'):
        destination = output.with_suffix('.' + ext)
        if destination.resolve() != (input_dir / ('board.' + ext)).resolve():
            shutil.copyfile(input_dir / ('board.' + ext), destination)
    (work / 'import-manifest.json').write_text(json.dumps(report, indent=2) + '\n')

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('step', choices=['export', 'import'])
    p.add_argument('--input-dir', type=pathlib.Path, required=True)
    p.add_argument('--work-dir', type=pathlib.Path, required=True)
    p.add_argument('--output-pcb', type=pathlib.Path)
    a = p.parse_args()
    if a.step == 'export':
        export(a.input_dir, a.work_dir)
    else:
        if a.output_pcb is None:
            p.error('import requires --output-pcb')
        import_ses(a.input_dir, a.work_dir, a.output_pcb)
