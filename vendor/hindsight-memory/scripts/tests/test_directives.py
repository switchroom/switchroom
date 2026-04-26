"""Tests for lib/directives.py (active-directives fetch + format).

Stdlib-only (unittest) — matches the rest of the hindsight-memory scripts,
which deliberately avoid third-party dependencies so the hooks run on a
bare Python install.

Run from the repo root:
    python -m unittest discover -s vendor/hindsight-memory/scripts/tests -v
"""

import os
import sys
import unittest
from io import StringIO
from unittest.mock import patch

# Ensure the scripts dir is importable so `lib.*` resolves.
SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.directives import (  # noqa: E402
    MAX_DIRECTIVES,
    fetch_active_directives,
    format_active_directives_block,
)


class _StubClient:
    """Minimal HindsightClient stand-in for tests.

    Captures the args list_directives was called with and returns either
    a canned response or raises a configured exception.
    """

    def __init__(self, response=None, exc=None):
        self._response = response
        self._exc = exc
        self.calls = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        self.calls.append({"bank_id": bank_id, "active_only": active_only, "timeout": timeout})
        if self._exc is not None:
            raise self._exc
        return self._response


def _directive(name, content, priority=5, tags=None):
    """Build a synthetic directive dict matching the API shape."""
    return {
        "id": f"id-{name}",
        "bank_id": "test-bank",
        "name": name,
        "content": content,
        "priority": priority,
        "is_active": True,
        "tags": tags or [],
        "created_at": "2026-01-01T00:00:00+00:00",
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


class FetchActiveDirectivesTests(unittest.TestCase):
    def test_returns_priority_sorted_descending(self):
        client = _StubClient(
            response={
                "items": [
                    _directive("low", "low content", priority=1),
                    _directive("high", "high content", priority=10),
                    _directive("mid", "mid content", priority=5),
                ]
            }
        )
        result = fetch_active_directives(client, "test-bank")
        self.assertEqual([d["name"] for d in result], ["high", "mid", "low"])

    def test_passes_active_only_true(self):
        client = _StubClient(response={"items": []})
        fetch_active_directives(client, "test-bank")
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(client.calls[0]["active_only"])
        self.assertEqual(client.calls[0]["bank_id"], "test-bank")

    def test_empty_items_returns_empty_list(self):
        client = _StubClient(response={"items": []})
        self.assertEqual(fetch_active_directives(client, "test-bank"), [])

    def test_http_failure_returns_empty_and_warns(self):
        client = _StubClient(exc=RuntimeError("HTTP 503 from /directives"))
        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])
        err_output = fake_err.getvalue()
        self.assertIn("list_directives failed", err_output)
        self.assertIn("test-bank", err_output)

    def test_timeout_exception_returns_empty_no_raise(self):
        client = _StubClient(exc=TimeoutError("timed out"))
        with patch("sys.stderr", new=StringIO()):
            # Must not raise.
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])

    def test_non_dict_response_returns_empty_and_warns(self):
        client = _StubClient(response=["not", "a", "dict"])
        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])
        self.assertIn("non-dict", fake_err.getvalue())

    def test_missing_items_key_returns_empty_quietly(self):
        # Banks-with-no-directives is a normal state, not a warn-worthy event.
        client = _StubClient(response={"unrelated": "shape"})
        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = fetch_active_directives(client, "test-bank")
        self.assertEqual(result, [])
        self.assertEqual(fake_err.getvalue(), "")

    def test_malformed_directive_entries_filtered(self):
        client = _StubClient(
            response={
                "items": [
                    _directive("ok", "real content", priority=5),
                    "not-a-dict",
                    None,
                ]
            }
        )
        result = fetch_active_directives(client, "test-bank")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "ok")

    def test_missing_priority_treated_as_zero(self):
        client = _StubClient(
            response={
                "items": [
                    _directive("has-priority", "content", priority=3),
                    {"name": "no-priority", "content": "content"},
                ]
            }
        )
        result = fetch_active_directives(client, "test-bank")
        self.assertEqual([d["name"] for d in result], ["has-priority", "no-priority"])

    def test_uses_short_timeout(self):
        # The recall hook is on the UserPromptSubmit critical path —
        # directive fetch must not block it.
        client = _StubClient(response={"items": []})
        fetch_active_directives(client, "test-bank")
        self.assertLessEqual(client.calls[0]["timeout"], 5)


class FormatActiveDirectivesBlockTests(unittest.TestCase):
    def test_returns_none_for_empty_list(self):
        self.assertIsNone(format_active_directives_block([]))

    def test_formats_multiple_directives(self):
        directives = [
            _directive("trailer", "End every response with: [VERIFIED]", priority=10),
            _directive("greeting", "Open with the user's first name.", priority=8),
        ]
        out = format_active_directives_block(directives)
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("<active_directives>"))
        self.assertTrue(out.endswith("</active_directives>"))
        self.assertIn("HARD RULES", out)
        self.assertIn("1. [P10] trailer: End every response with: [VERIFIED]", out)
        self.assertIn("2. [P8] greeting: Open with the user's first name.", out)

    def test_content_is_verbatim(self):
        directives = [_directive("verbatim", "Line one.\nLine two.\nLine three.", priority=5)]
        out = format_active_directives_block(directives)
        self.assertIn("Line one.\nLine two.\nLine three.", out)

    def test_truncates_at_cap_with_footer(self):
        # 20 synthetic directives — should truncate to MAX_DIRECTIVES with
        # a "(+N more, omitted)" footer.
        directives = [
            _directive(f"d{i}", f"content {i}", priority=20 - i) for i in range(20)
        ]
        out = format_active_directives_block(directives)
        # Cap should be 15 by default.
        self.assertEqual(MAX_DIRECTIVES, 15)
        self.assertIn("1. [P20] d0", out)
        self.assertIn(f"{MAX_DIRECTIVES}. [P", out)
        # 16th item should NOT appear.
        self.assertNotIn(f"{MAX_DIRECTIVES + 1}. [P", out)
        # Footer with the right omitted count.
        self.assertIn(f"(+{20 - MAX_DIRECTIVES} more, omitted)", out)

    def test_no_footer_when_under_cap(self):
        directives = [_directive("only", "single", priority=5)]
        out = format_active_directives_block(directives)
        self.assertNotIn("more, omitted", out)

    def test_handles_missing_name_and_content(self):
        directives = [{"priority": 7}]
        out = format_active_directives_block(directives)
        self.assertIn("[P7] (unnamed):", out)

    def test_custom_cap_respected(self):
        directives = [_directive(f"d{i}", f"c{i}", priority=10) for i in range(5)]
        out = format_active_directives_block(directives, max_directives=2)
        self.assertIn("1. [P10] d0", out)
        self.assertIn("2. [P10] d1", out)
        self.assertNotIn("3. [P10] d2", out)
        self.assertIn("(+3 more, omitted)", out)


if __name__ == "__main__":
    unittest.main()
