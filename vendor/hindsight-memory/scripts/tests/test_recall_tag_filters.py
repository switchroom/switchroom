"""Unit tests for the recall tag-filter port (upstream 962140eef).

Covers the switchroom-specific composition points that upstream's own tests
cannot: the tag-filter fingerprint (`_tag_filter_sig`) and its inclusion in
the recall cache key (`_cache_key`). Tag filters change what the recall API
returns for an identical query, so a filter change within the cache TTL must
produce a cache MISS — otherwise stale, differently-filtered results would
be served.

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402


class TagFilterSigTests(unittest.TestCase):
    def test_empty_filters_collapse_to_empty_string(self):
        # Backward-compat: unused feature must not perturb existing keys.
        self.assertEqual(recall._tag_filter_sig(None, None, None, {}), "")
        self.assertEqual(recall._tag_filter_sig([], None, None, {}), "")

    def test_tags_produce_nonempty_sig(self):
        self.assertNotEqual(recall._tag_filter_sig(["memory_type:rule"], "any", None, {}), "")

    def test_tag_groups_alone_produce_nonempty_sig(self):
        groups = [{"op": "all", "tags": ["a", "b"]}]
        self.assertNotEqual(recall._tag_filter_sig(None, "any", groups, {}), "")

    def test_bank_filters_alone_produce_nonempty_sig(self):
        filters = {"profile-bank": {"recallTags": ["memory_type:rule"]}}
        self.assertNotEqual(recall._tag_filter_sig(None, None, None, filters), "")

    def test_sig_is_deterministic(self):
        a = recall._tag_filter_sig(["t1"], "all", None, {"b": {"recallTags": ["x"]}})
        b = recall._tag_filter_sig(["t1"], "all", None, {"b": {"recallTags": ["x"]}})
        self.assertEqual(a, b)

    def test_sig_stable_across_dict_key_order(self):
        f1 = {"a": {"recallTags": ["x"]}, "b": {"recallTags": ["y"]}}
        f2 = {"b": {"recallTags": ["y"]}, "a": {"recallTags": ["x"]}}
        self.assertEqual(
            recall._tag_filter_sig(["t"], "any", None, f1),
            recall._tag_filter_sig(["t"], "any", None, f2),
        )

    def test_different_tags_different_sig(self):
        self.assertNotEqual(
            recall._tag_filter_sig(["memory_type:rule"], "any", None, {}),
            recall._tag_filter_sig(["memory_type:fact"], "any", None, {}),
        )

    def test_different_match_mode_different_sig(self):
        self.assertNotEqual(
            recall._tag_filter_sig(["t"], "any", None, {}),
            recall._tag_filter_sig(["t"], "all_strict", None, {}),
        )

    def test_unserializable_falls_back_to_repr(self):
        # A pathological config value must not raise; it still yields a
        # non-empty signature distinguishing it from "no filters".
        sig = recall._tag_filter_sig([object()], "any", None, {})
        self.assertTrue(sig)


class CacheKeyTagFilterTests(unittest.TestCase):
    """The tag-filter fingerprint must be part of the recall cache key."""

    ARGS = ("s1", "what are the rules", "clerk", ["profile"], "42", "ken")

    def test_no_filters_matches_legacy_key(self):
        # Default arg == explicit "" — pre-feature cache keys are unchanged.
        legacy = recall._cache_key(*self.ARGS)
        explicit = recall._cache_key(*self.ARGS, "")
        self.assertEqual(legacy, explicit)

    def test_filters_change_the_key(self):
        sig = recall._tag_filter_sig(["memory_type:rule"], "any", None, {})
        self.assertNotEqual(recall._cache_key(*self.ARGS), recall._cache_key(*self.ARGS, sig))

    def test_different_filters_different_keys(self):
        sig_a = recall._tag_filter_sig(["memory_type:rule"], "any", None, {})
        sig_b = recall._tag_filter_sig(["memory_type:fact"], "any", None, {})
        self.assertNotEqual(recall._cache_key(*self.ARGS, sig_a), recall._cache_key(*self.ARGS, sig_b))

    def test_per_bank_filter_change_changes_key(self):
        # Editing only recallAdditionalBankFilters (e.g. for a sender bank)
        # must also invalidate the cache.
        sig_a = recall._tag_filter_sig(["t"], "any", None, {"profile": {"recallTags": ["x"]}})
        sig_b = recall._tag_filter_sig(["t"], "any", None, {"profile": {"recallTags": ["y"]}})
        self.assertNotEqual(recall._cache_key(*self.ARGS, sig_a), recall._cache_key(*self.ARGS, sig_b))

    def test_same_filters_same_key(self):
        sig1 = recall._tag_filter_sig(["t"], "all", None, {})
        sig2 = recall._tag_filter_sig(["t"], "all", None, {})
        self.assertEqual(recall._cache_key(*self.ARGS, sig1), recall._cache_key(*self.ARGS, sig2))


if __name__ == "__main__":
    unittest.main()
