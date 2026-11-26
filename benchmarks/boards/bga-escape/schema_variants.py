# SPDX-License-Identifier: MIT
"""Controlled additions to the fixed fixture schema, shared by replay and tests."""
import copy


def nested_variants(original):
    for index, edge in [(0, 'first'), (-1, 'last')]:
        for scope, fields in [
            ('connection', {'traceWidth': .5, 'viaDiameter': .8}),
            ('terminal', {'pcb_port_id': 'unchecked', 'layers': ['bottom']}),
            ('obstacle', {'clearance': .5, 'isKeepout': True}),
            ('center', {'z': 1, 'layer': 'bottom'}),
        ]:
            for key, value in fields.items():
                changed = copy.deepcopy(original)
                objects = {
                    'connection': changed['connections'][index],
                    'terminal': changed['connections'][index]['pointsToConnect'][index],
                    'obstacle': changed['obstacles'][index],
                    'center': changed['obstacles'][index]['center'],
                }
                objects[scope][key] = value
                yield f'{edge}-{scope}-{key}', changed
