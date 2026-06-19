"""Unit tests for per-speaker memory routing (Switchroom).

RFC reference/rfcs/per-speaker-memory-routing.md. Covers:
  - extract_user_from_prompt: sender (`user=`) extraction from the
    <channel ...> envelope (username, numeric id, quote styles, missing).
  - _cache_key: the sender is part of the key, so two speakers sending the
    same prompt in one session don't collide on the recall cache.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.gateway_ipc import extract_user_from_prompt  # noqa: E402
import recall  # noqa: E402


class ExtractUserTests(unittest.TestCase):
    def test_username_present(self):
        p = '<channel source="telegram" chat_id="-100" user="lisa" ts="1">hi</channel>'
        self.assertEqual(extract_user_from_prompt(p), "lisa")

    def test_numeric_id_when_no_username(self):
        p = '<channel source="telegram" chat_id="-100" user="987654321">hi</channel>'
        self.assertEqual(extract_user_from_prompt(p), "987654321")

    def test_single_quotes(self):
        p = "<channel source='telegram' chat_id='-100' user='ken'>hi</channel>"
        self.assertEqual(extract_user_from_prompt(p), "ken")

    def test_no_envelope_returns_none(self):
        self.assertIsNone(extract_user_from_prompt("a plain interactive prompt"))

    def test_empty_user_returns_none(self):
        p = '<channel source="telegram" chat_id="-100" user="">hi</channel>'
        self.assertIsNone(extract_user_from_prompt(p))

    def test_non_string_returns_none(self):
        self.assertIsNone(extract_user_from_prompt(None))


class CacheKeySenderTests(unittest.TestCase):
    """The sender must be part of the cache key so a multi-user session
    doesn't serve one speaker's recall to another."""

    def test_different_senders_different_keys(self):
        k_ken = recall._cache_key("s1", "what's on today", "clerk", [], None, "ken")
        k_lisa = recall._cache_key("s1", "what's on today", "clerk", [], None, "lisa")
        self.assertNotEqual(k_ken, k_lisa)

    def test_same_sender_same_key(self):
        a = recall._cache_key("s1", "p", "clerk", [], None, "ken")
        b = recall._cache_key("s1", "p", "clerk", [], None, "ken")
        self.assertEqual(a, b)

    def test_no_sender_backward_compatible(self):
        # Omitting the sender (DM / fleet-shared, single user) collapses to
        # the empty string — stable, and distinct from any named sender.
        none1 = recall._cache_key("s1", "p", "clerk", [], None)
        none2 = recall._cache_key("s1", "p", "clerk", [], None, None)
        self.assertEqual(none1, none2)
        self.assertNotEqual(
            none1, recall._cache_key("s1", "p", "clerk", [], None, "ken")
        )


if __name__ == "__main__":
    unittest.main()
