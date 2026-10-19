# SPDX-License-Identifier: MIT
"""Check native input opens against the actual fixture pad identities, positions and nets."""
import re


def validate_report(report, expected_pads):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    require(report['violations'] == [] and report['schematic_parity'] == [], 'native input errors')
    require(set(report['included_severities']) >= {'error', 'warning'}, 'incomplete DRC severities')
    expected_nets = {f'N{n}' for n in range(1, 101)}
    require(len(expected_pads) == 200 and {v[0] for v in expected_pads.values()} == expected_nets, 'invalid expected pad ownership')
    opens = report['unconnected_items']
    require(len(opens) == 100, 'expected 100 opens')
    seen_nets, seen_pads, seen_uuids = set(), set(), set()
    for entry in opens:
        require(entry['type'] == 'unconnected_items' and entry['severity'] == 'error', 'unexpected open category/severity')
        require(len(entry['items']) == 2, 'expected two endpoints per open')
        nets = []
        for item in entry['items']:
            uuid = item['uuid']
            require(isinstance(uuid, str) and uuid and uuid not in seen_uuids, 'missing or repeated pad UUID')
            match = re.fullmatch(r'Pad (\S+) \[([^\[\]]+)\] of (\S+) on F\.Cu', item['description'])
            require(match is not None, 'unexpected endpoint description')
            number, name, reference = match.groups()
            key = (reference, number)
            require(key in expected_pads and key not in seen_pads, 'unknown or repeated fixture pad')
            expected_name, x, y = expected_pads[key]
            require(name == expected_name, 'endpoint net does not match fixture pad')
            require(item['pos'] == {'x': x, 'y': y}, 'endpoint position does not match fixture pad')
            seen_pads.add(key)
            seen_uuids.add(uuid)
            nets.append(name)
        require(nets[0] == nets[1] and nets[0] not in seen_nets, 'mixed or repeated open net')
        seen_nets.add(nets[0])
    require(seen_nets == expected_nets and seen_pads == set(expected_pads), 'missing fixture nets or endpoints')
