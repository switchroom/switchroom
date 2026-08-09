"""Switchroom — recall `types` must be fail-safe against an invalid fact type.

The 0.9.0 Hindsight engine returns HTTP 422 ("Invalid fact type(s): … Must be
one of: experience, observation, world") for an unknown recall `fact_type`,
which fails the WHOLE recall for the turn. Before this guard, recall.py sent
`types=config.get("recallTypes")` unvalidated, so an operator typo in
`memory.recall.types` (e.g. "observations", "fact") would 422 and drop memory
injection on every turn.

The outcome under test: a config carrying an invalid type resolves — via
`filter_recall_types` — to a FILTERED, valid `types` list (never a 422-bound
call), and never raises. Mirrors the degrade-don't-raise contract of
`compute_observation_scopes`.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import (  # noqa: E402
    DEFAULT_RECALL_FACT_TYPES,
    RECALL_FACT_TYPES,
    filter_recall_types,
)


class FilterRecallTypes(unittest.TestCase):
    def test_valid_set_matches_the_engine(self):
        # Guards against client/server drift: verified against the live engine's
        # own 422 detail string ("experience, observation, world").
        self.assertEqual(set(RECALL_FACT_TYPES), {"world", "experience", "observation"})

    def test_invalid_type_is_dropped_leaving_a_valid_list(self):
        # The exact defect: an operator typo mixed with a valid type. The bad
        # value is dropped; the good one survives — NOT a 422-bound call.
        resolved = filter_recall_types({"recallTypes": ["observations", "world"]})
        self.assertEqual(resolved, ["world"])
        for t in resolved:
            self.assertIn(t, RECALL_FACT_TYPES)

    def test_all_invalid_falls_back_to_the_default_set(self):
        # If nothing valid survives, recall must still RUN — fall back to the
        # shipped default rather than send an empty/invalid set.
        resolved = filter_recall_types({"recallTypes": ["fact", "observations"]})
        self.assertEqual(resolved, list(DEFAULT_RECALL_FACT_TYPES))

    def test_valid_types_pass_through_deduplicated_in_order(self):
        resolved = filter_recall_types(
            {"recallTypes": ["world", "experience", "world", "observation"]}
        )
        self.assertEqual(resolved, ["world", "experience", "observation"])

    def test_unset_returns_none_so_the_field_is_omitted(self):
        # None -> omit `types` entirely, letting the engine apply its own default.
        self.assertIsNone(filter_recall_types({}))
        self.assertIsNone(filter_recall_types({"recallTypes": None}))

    def test_non_list_value_falls_back_without_raising(self):
        # A scalar where a list was expected is a config mistake, not a crash.
        resolved = filter_recall_types({"recallTypes": "observation"})
        self.assertEqual(resolved, list(DEFAULT_RECALL_FACT_TYPES))

    def test_non_string_members_are_dropped(self):
        resolved = filter_recall_types({"recallTypes": [None, 42, "observation"]})
        self.assertEqual(resolved, ["observation"])

    def test_never_raises_on_pathological_input(self):
        for bad in ({}, {"recallTypes": {}}, {"recallTypes": 0}, {"recallTypes": [[]]}):
            with self.subTest(bad=bad):
                # Must return a value, never propagate an exception.
                filter_recall_types(bad)


if __name__ == "__main__":
    unittest.main()
