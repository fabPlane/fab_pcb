# SPDX-License-Identifier: MIT
"""Require one JSON identity within a repeat group before comparing batches."""
import json


def single_identity(values, label):
    identities = {json.dumps(value, sort_keys=True, allow_nan=False) for value in values}
    if len(identities) != 1:
        raise ValueError(f'{label} must be identical across all repeats')
    return next(iter(identities))


def batch_identities(runs):
    """Require one machine per batch and one input per fixture across backends.

    Per-backend repeat checks alone allow each backend to use a different board
    under the same fixture ID, or a different machine. Call before summarizing.
    Repeat counts and backend version checks remain the caller's responsibility.
    """
    single_identity((r['system']['cpu_name'] for r in runs), 'Batch CPU identity')
    fixtures = {}
    for run in runs:
        fixtures.setdefault(run['fixture']['id'], []).append(run['fixture'])
    for fixture_id, values in fixtures.items():
        single_identity(values, f'Batch fixture identity {fixture_id}')
