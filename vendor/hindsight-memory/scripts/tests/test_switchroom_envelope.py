"""Switchroom #2903 Fix 6.3 — the `<channel source="...">` envelope grammar is
extracted from directive_verify.py into lib/switchroom_envelope.py so the
coupling between the vendored Python guard and the switchroom gateway's TS wire
format is explicit and testable in ONE place.

Pins the grammar so a TS-side format change that breaks these regexes is caught
by a failing Python test rather than silently disabling the synthetic-inbound
guard.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.switchroom_envelope import (  # noqa: E402
    HUMAN_INBOUND_SOURCES,
    envelope_source,
    is_synthetic_inbound,
)


class TestEnvelopeSource(unittest.TestCase):
    def test_extracts_open_form(self):
        self.assertEqual(
            envelope_source('<channel source="telegram" chat_id="1">hi</channel>'),
            "telegram",
        )

    def test_extracts_self_closing_form(self):
        self.assertEqual(envelope_source('<channel source="reaction"/>'), "reaction")

    def test_lowercases(self):
        self.assertEqual(envelope_source('<channel source="Cron">x</channel>'), "cron")

    def test_none_when_no_envelope(self):
        self.assertIsNone(envelope_source("From now on, use British spelling."))

    def test_none_on_non_string(self):
        for bad in (None, 123, [], {}):
            self.assertIsNone(envelope_source(bad))


class TestSyntheticClassification(unittest.TestCase):
    def test_telegram_is_human(self):
        self.assertIn("telegram", HUMAN_INBOUND_SOURCES)
        self.assertFalse(is_synthetic_inbound('<channel source="telegram">hi</channel>'))

    def test_no_envelope_is_human(self):
        self.assertFalse(is_synthetic_inbound("hello there"))

    def test_new_source_defaults_to_synthetic(self):
        # Whitelist posture: an UNKNOWN/new source is treated as machine-authored
        # by default, not accidentally classified human.
        self.assertTrue(is_synthetic_inbound('<channel source="brand_new_channel">x</channel>'))

    def test_known_synthetic_sources(self):
        for src in ("cron", "reaction", "resume_interrupted", "vault_grant_approved"):
            with self.subTest(src=src):
                self.assertTrue(is_synthetic_inbound(f'<channel source="{src}">x</channel>'))


if __name__ == "__main__":
    unittest.main()
