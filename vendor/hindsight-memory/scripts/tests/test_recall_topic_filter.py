"""PR6 — unit tests for recall.py's topic-aware helpers.

Covers:
  - _filter_by_active_topic — drops memories whose metadata.thread_id
    differs from the active prompt's thread_id; passes through untagged
    legacy memories.
  - _summarise_source_topics — distribution counts used in the recall
    log for binding-failure instrumentation.
  - _topic_filter_mode — env-var parsing with safe default.
  - _cache_key — active_thread_id participates in hash (cross-topic
    prompts in supergroup mode mustn't collide on the cache).

Stdlib-only.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from recall import (  # noqa: E402
    _cache_key,
    _filter_by_active_topic,
    _summarise_source_topics,
    _topic_filter_mode,
)


def _mem(thread_id):
    """Fake memory record with the metadata shape recall sees."""
    return {"id": f"m{thread_id}", "metadata": {"thread_id": thread_id}}


def _untagged_mem(suffix=""):
    return {"id": f"u{suffix}", "metadata": {"retained_at": "2026-01-01"}}


class FilterByActiveTopicTests(unittest.TestCase):
    def test_drops_cross_topic_when_active_set(self):
        results = [_mem("17"), _mem("31"), _mem("17")]
        kept, dropped = _filter_by_active_topic(results, "17")
        self.assertEqual(len(kept), 2)
        self.assertEqual(dropped, 1)
        self.assertTrue(all(m["metadata"]["thread_id"] == "17" for m in kept))

    def test_passes_through_untagged_memories(self):
        # Legacy memories (pre-PR6 retain) have no thread_id — must
        # never be dropped, regardless of active topic.
        results = [_mem("17"), _untagged_mem(), _mem("31"), _untagged_mem("b")]
        kept, dropped = _filter_by_active_topic(results, "17")
        # Kept: the 17 tagged + both untagged.
        self.assertEqual(len(kept), 3)
        self.assertEqual(dropped, 1)

    def test_no_active_thread_is_passthrough(self):
        # DM / fleet-shared agents have no active_thread_id; the
        # filter is a no-op regardless of mode.
        results = [_mem("17"), _mem("31"), _untagged_mem()]
        kept, dropped = _filter_by_active_topic(results, None)
        self.assertEqual(len(kept), 3)
        self.assertEqual(dropped, 0)

    def test_str_int_equivalence(self):
        # Metadata can carry thread_ids as either string or int
        # depending on how retain serialized them. The active_thread_id
        # is always string (envelope is parsed as text). Compare as
        # strings.
        results = [{"id": "m", "metadata": {"thread_id": 17}}]  # numeric
        kept, dropped = _filter_by_active_topic(results, "17")
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 0)


class SummariseSourceTopicsTests(unittest.TestCase):
    def test_counts_by_thread(self):
        results = [_mem("17"), _mem("17"), _mem("31")]
        self.assertEqual(_summarise_source_topics(results), {"17": 2, "31": 1})

    def test_untagged_bucket(self):
        results = [_mem("17"), _untagged_mem(), _untagged_mem()]
        summary = _summarise_source_topics(results)
        self.assertEqual(summary["17"], 1)
        self.assertEqual(summary["__no_thread__"], 2)

    def test_missing_metadata_bucket(self):
        results = [{"id": "x"}]  # no metadata key at all
        self.assertEqual(_summarise_source_topics(results), {"__untagged__": 1})


class TopicFilterModeTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("HINDSIGHT_TOPIC_FILTER_MODE")
        os.environ.pop("HINDSIGHT_TOPIC_FILTER_MODE", None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("HINDSIGHT_TOPIC_FILTER_MODE", None)
        else:
            os.environ["HINDSIGHT_TOPIC_FILTER_MODE"] = self._saved

    def test_default_is_soft_preamble(self):
        self.assertEqual(_topic_filter_mode(), "soft-preamble")

    def test_hard_filter_env(self):
        os.environ["HINDSIGHT_TOPIC_FILTER_MODE"] = "hard-filter"
        self.assertEqual(_topic_filter_mode(), "hard-filter")

    def test_unknown_value_falls_back_to_default(self):
        # Operator typos shouldn't silently enable a strict mode.
        os.environ["HINDSIGHT_TOPIC_FILTER_MODE"] = "strict"
        self.assertEqual(_topic_filter_mode(), "soft-preamble")

    def test_case_insensitive(self):
        os.environ["HINDSIGHT_TOPIC_FILTER_MODE"] = "Hard-Filter"
        self.assertEqual(_topic_filter_mode(), "hard-filter")


class CacheKeyIncludesActiveTopicTests(unittest.TestCase):
    def test_same_prompt_different_topic_misses(self):
        k1 = _cache_key("sess", "what's up?", "bank", [], "17")
        k2 = _cache_key("sess", "what's up?", "bank", [], "31")
        self.assertNotEqual(k1, k2)

    def test_backward_compat_no_topic(self):
        # Pre-PR6 callers (none after this PR, but the param is
        # optional so they couldn't break) get a stable key.
        k1 = _cache_key("sess", "p", "bank", [])
        k2 = _cache_key("sess", "p", "bank", [], None)
        k3 = _cache_key("sess", "p", "bank", [], "")
        # All three collapse to the empty-thread case → same hash.
        self.assertEqual(k1, k2)
        self.assertEqual(k1, k3)


if __name__ == "__main__":
    unittest.main()
