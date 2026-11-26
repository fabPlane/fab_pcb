# SPDX-License-Identifier: MIT
import copy
import unittest
from report_audit import validate_report


def mutations():
    def endpoint(report):
        return report['unconnected_items'][0]['items'][0]
    def entry(report):
        return report['unconnected_items'][0]
    return {
        'duplicate net': lambda r: r['unconnected_items'].__setitem__(0, copy.deepcopy(r['unconnected_items'][1])),
        'missing open': lambda r: r['unconnected_items'].pop(),
        'missing UUID': lambda r: endpoint(r).__setitem__('uuid', ''),
        'unknown pad': lambda r: endpoint(r).__setitem__('description', 'Pad 1 [N1] of U100 on F.Cu'),
        'wrong position': lambda r: endpoint(r).__setitem__('pos', {'x': 0, 'y': 0}),
        'wrong net': lambda r: endpoint(r).__setitem__('description', 'Pad 1 [N101] of U1 on F.Cu'),
        'noncanonical net': lambda r: endpoint(r).__setitem__('description', 'Pad 1 [N01] of U1 on F.Cu'),
        'ambiguous net': lambda r: endpoint(r).__setitem__('description', 'Pad 1 [N1] [N2] of U1 on F.Cu'),
        'missing net': lambda r: endpoint(r).__setitem__('description', 'Pad 1 of U1 on F.Cu'),
        'mixed endpoints': lambda r: entry(r)['items'].__setitem__(1, copy.deepcopy(r['unconnected_items'][1]['items'][1])),
        'duplicate endpoint': lambda r: entry(r)['items'].__setitem__(1, copy.deepcopy(endpoint(r))),
        'missing endpoint': lambda r: entry(r)['items'].pop(),
        'wrong category': lambda r: entry(r).__setitem__('type', 'clearance'),
        'wrong severity': lambda r: entry(r).__setitem__('severity', 'warning'),
        'warnings excluded': lambda r: r.__setitem__('included_severities', ['error']),
        'native errors': lambda r: r['violations'].append(dict(type='clearance')),
        'parity errors': lambda r: r['schematic_parity'].append(dict(type='missing_footprint')),
    }

class ReportAuditTest(unittest.TestCase):
    def setUp(self):
        self.pads = {(f'U{end}', str(n)): (f'N{n}', n, end) for n in range(1, 101) for end in range(2)}
        self.report = dict(violations=[], schematic_parity=[], included_severities=['error', 'warning'],
            unconnected_items=[dict(type='unconnected_items', severity='error', items=[
                dict(uuid=f'{n}-{end}', pos={'x': n, 'y': end}, description=f'Pad {n} [N{n}] of U{end} on F.Cu')
                for end in range(2)]) for n in range(1, 101)])

    def test_valid_and_reordered(self):
        validate_report(self.report, self.pads)
        self.report['unconnected_items'].reverse()
        for entry in self.report['unconnected_items']:
            entry['items'].reverse()
        validate_report(self.report, self.pads)

    def test_malformed_reports(self):
        for label, change in mutations().items():
            with self.subTest(label=label):
                report = copy.deepcopy(self.report)
                change(report)
                with self.assertRaises(ValueError):
                    validate_report(report, self.pads)


if __name__ == '__main__':
    unittest.main()
