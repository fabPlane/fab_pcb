# SPDX-License-Identifier: MIT
"""Require one JSON identity within a repeat group before comparing batches."""
import json


def single_identity(values, label):
    identities = {json.dumps(value, sort_keys=True, allow_nan=False) for value in values}
    if len(identities) != 1:
        raise ValueError(f'{label} must be identical across all repeats')
    return next(iter(identities))
