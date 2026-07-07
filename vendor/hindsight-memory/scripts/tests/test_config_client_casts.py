"""Unit tests for config env casting (`lib.config._cast_env`) and the
client's request-timeout override clamp (`HindsightClient._resolve_timeout`).

Follow-ups from the #2816 review punch list:
  - list cast: a value that parses as JSON but is NOT a list (e.g. `42`)
    must return None (keep default, fail-open) instead of falling through
    to comma-split and producing a junk one-element list. Malformed
    intended-JSON (`[1,2`) also keeps the default; plain comma strings
    still split.
  - timeout override: zero/negative env values are clamped to >= 1 instead
    of passing straight through to urlopen.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.config import _cast_env  # noqa: E402
from lib.client import HindsightClient  # noqa: E402


class CastEnvListTests(unittest.TestCase):
    def test_valid_json_list(self):
        self.assertEqual(_cast_env('["a", "b"]', list), ["a", "b"])

    def test_empty_json_list(self):
        self.assertEqual(_cast_env("[]", list), [])

    def test_comma_string_splits(self):
        self.assertEqual(_cast_env("a, b ,c", list), ["a", "b", "c"])

    def test_comma_string_drops_empty_tokens(self):
        self.assertEqual(_cast_env("a,,b,", list), ["a", "b"])

    def test_single_bare_string(self):
        # Not valid JSON, no commas → one-element list.
        self.assertEqual(_cast_env("solo", list), ["solo"])

    def test_json_non_list_scalar_returns_none(self):
        # Parses as JSON int — not a list, not a comma string. Default kept.
        self.assertIsNone(_cast_env("42", list))

    def test_json_non_list_object_returns_none(self):
        self.assertIsNone(_cast_env('{"a": 1}', list))

    def test_json_string_returns_none(self):
        # A JSON-quoted string is valid JSON but not a list.
        self.assertIsNone(_cast_env('"tag"', list))

    def test_malformed_json_array_returns_none(self):
        # Looks like intended JSON but doesn't parse → default kept,
        # NOT comma-split into junk like ['["a"', '"b"'].
        self.assertIsNone(_cast_env('["a", "b"', list))

    def test_malformed_json_object_returns_none(self):
        self.assertIsNone(_cast_env('{"a": ', list))


class CastEnvOtherTypesTests(unittest.TestCase):
    """Guard the neighbours the list change must not disturb."""

    def test_int_valid(self):
        self.assertEqual(_cast_env("30", int), 30)

    def test_int_invalid_returns_none(self):
        self.assertIsNone(_cast_env("thirty", int))

    def test_bool_true_variants(self):
        for v in ("true", "1", "yes", "TRUE"):
            self.assertTrue(_cast_env(v, bool), v)

    def test_bool_false(self):
        self.assertFalse(_cast_env("false", bool))

    def test_dict_valid(self):
        self.assertEqual(_cast_env('{"a": 1}', dict), {"a": 1})

    def test_dict_non_container_returns_none(self):
        self.assertIsNone(_cast_env("42", dict))


class ResolveTimeoutTests(unittest.TestCase):
    URL = "http://127.0.0.1:9999"

    def _client(self, override):
        return HindsightClient(self.URL, request_timeout_override=override)

    def test_no_override_uses_caller_timeout(self):
        self.assertEqual(self._client(None)._resolve_timeout(30), 30)

    def test_valid_override_wins(self):
        self.assertEqual(self._client(15)._resolve_timeout(30), 15)

    def test_zero_override_clamped_to_one(self):
        self.assertEqual(self._client(0)._resolve_timeout(30), 1)

    def test_negative_override_clamped_to_one(self):
        self.assertEqual(self._client(-5)._resolve_timeout(30), 1)

    def test_one_passes_through(self):
        self.assertEqual(self._client(1)._resolve_timeout(30), 1)


if __name__ == "__main__":
    unittest.main()
