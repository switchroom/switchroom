"""M4 #4778 — prefetch buffer TOPIC-RELEVANCE guard.

The F3 freshness machinery proves a joined buffer is FRESH (a strictly-newer
sentinel this session); it does NOT prove the buffer is ON TOPIC. The producer
builds the buffer from turn N's last human prompt, so on a topic PIVOT a
perfectly-fresh buffer holds the WRONG-topic memories. These are OUTCOME tests
on the rendered ``additionalContext`` (the real injection surface):

  * RED/GREEN: a pivot query must NOT be served the prior-topic buffer — it must
    fall through to SYNCHRONOUS recall (correct, current-topic memories). On the
    pre-guard code the prior-topic block is injected at warm-buffer latency; with
    the guard the pivot turn shows the synchronous result instead.
  * An on-topic follow-up is STILL a warm hit (the guard is not so tight it kills
    the latency win).
  * A legacy buffer with no stored query fails safe to synchronous recall.

Mirrors the harness in ``tests/test_recall_buffer_join.py`` (drives ``recall.main``
end-to-end, asserts on transport). Stdlib-only.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from lib import recall_buffer  # noqa: E402

SESSION = "topic-guard-session"

# The producer built the warm buffer for turn N's prompt about a DB failover
# rollback; its recalled block is the us-east-1 standby plan.
PRODUCER_QUERY = "what's the rollback plan for the us-east-1 primary failover"
BUFFERED_BLOCK = "- Rollback plan: keep the us-east-1 primary in read-only standby"

# Turn N+1 PIVOTS sharply to an unrelated topic (the issue's reproduction shape).
PIVOT_PROMPT = "what's the weather forecast for Melbourne this weekend"
SYNC_RECALL_TEXT = "sync recalled: Melbourne weekend outlook is sunny"

# An on-topic FOLLOW-UP that reuses the salient nouns of the producer query.
ONTOPIC_PROMPT = "and is the us-east-1 primary still the rollback target"


class _SyncClient:
    """Directive-free client whose synchronous recall returns a marker distinct
    from the buffered block, so a served warm buffer and a served sync result are
    unambiguously distinguishable in the rendered output."""

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        return {"results": [{
            "text": SYNC_RECALL_TEXT, "type": "fact",
            "mentioned_at": "2026-01-01", "id": "s1", "scores": {"final": 0.9},
        }]}


class TopicGuardBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="topic-guard-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

        self._bufdir = tempfile.mkdtemp(prefix="topic-guard-buf-")
        self.env = mock.patch.dict(
            os.environ, {"HINDSIGHT_PREFETCH_BUFFER_DIR": self._bufdir}, clear=False
        )
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self._bufdir, ignore_errors=True)
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _config(self):
        return {
            "autoRecall": True,
            "bankId": "test-bank",
            "recallMaxTokens": 4096,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "directivesCacheTtlSeconds": 0,
            "memoryPrefetchEnabled": True,
            "memoryPrefetchPollCapMs": 100,
        }

    def _run(self, config, client, prompt):
        hook_input = {"prompt": prompt, "session_id": SESSION, "transcript_path": "", "cwd": "/tmp"}
        stdout = io.StringIO()
        with patch("recall.load_config", return_value=config), \
                patch("recall.get_api_url", return_value="http://fake"), \
                patch("recall.HindsightClient", return_value=client), \
                patch("recall.ensure_bank_mission"), \
                patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                patch("sys.stdout", stdout):
            recall.main()
        out = stdout.getvalue()
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""


class PivotFallsThroughTests(TopicGuardBase):
    def test_pivot_query_is_not_served_the_prior_topic_buffer(self):
        # RED on pre-guard code: `read_if_fresh` returns the fresh buffer and the
        # consumer injects the rollback block for a WEATHER prompt at ~1ms. GREEN
        # with the guard: the topic mismatch falls through to synchronous recall.
        recall_buffer.write_buffer(SESSION, BUFFERED_BLOCK, {}, query=PRODUCER_QUERY)
        recall_buffer.write_sentinel(SESSION)

        ctx = self._run(self._config(), _SyncClient(), PIVOT_PROMPT)

        self.assertNotIn(
            "us-east-1", ctx,
            "a topic pivot must NOT be served the prior turn's wrong-topic buffer",
        )
        self.assertIn(
            SYNC_RECALL_TEXT, ctx,
            "a topic pivot must fall through to synchronous recall for correct memories",
        )


class OnTopicStillHitsTests(TopicGuardBase):
    def test_ontopic_followup_still_gets_the_warm_buffer(self):
        # The guard must not be so tight it kills the latency win: a follow-up
        # reusing the salient nouns still clears the Jaccard threshold and joins
        # the warm buffer WITHOUT a synchronous recall.
        class _ExplodingRecallClient:
            def list_directives(self, bank_id, active_only=True, timeout=2):
                return {"items": []}

            def recall(self, bank_id, query, **kwargs):
                raise AssertionError("on-topic warm hit must not fall through to synchronous recall")

        recall_buffer.write_buffer(SESSION, BUFFERED_BLOCK, {}, query=PRODUCER_QUERY)
        recall_buffer.write_sentinel(SESSION)

        ctx = self._run(self._config(), _ExplodingRecallClient(), ONTOPIC_PROMPT)
        self.assertIn(
            "us-east-1", ctx,
            "an on-topic follow-up must still join the warm prefetch buffer",
        )


class LegacyBufferFailsSafeTests(TopicGuardBase):
    def test_buffer_without_stored_query_falls_through_to_sync_recall(self):
        # Backward-compat: a buffer written before the `query` field existed has
        # query="" -> the guard cannot establish a topic match -> fail-safe to
        # synchronous recall, never a blind wrong-topic serve.
        recall_buffer.write_buffer(SESSION, BUFFERED_BLOCK, {})  # no query
        recall_buffer.write_sentinel(SESSION)

        ctx = self._run(self._config(), _SyncClient(), PIVOT_PROMPT)
        self.assertNotIn("us-east-1", ctx)
        self.assertIn(SYNC_RECALL_TEXT, ctx)


class TopicMatchUnitTests(TopicGuardBase):
    def test_jaccard_threshold_boundaries(self):
        cfg = self._config()
        # Disjoint content tokens -> pivot -> no match.
        self.assertFalse(recall._prefetch_topic_matches(PIVOT_PROMPT, PRODUCER_QUERY, cfg))
        # Identical query -> match.
        self.assertTrue(recall._prefetch_topic_matches(PRODUCER_QUERY, PRODUCER_QUERY, cfg))
        # On-topic follow-up sharing salient nouns -> match.
        self.assertTrue(recall._prefetch_topic_matches(ONTOPIC_PROMPT, PRODUCER_QUERY, cfg))
        # Empty buffered query (legacy) -> fail-safe miss.
        self.assertFalse(recall._prefetch_topic_matches(PRODUCER_QUERY, "", cfg))
        # Empty current prompt -> fail-safe miss.
        self.assertFalse(recall._prefetch_topic_matches("", PRODUCER_QUERY, cfg))
        # Garbage threshold coerces to the 0.3 default rather than raising.
        bad = dict(cfg)
        bad["memoryPrefetchMinTopicOverlap"] = "not-a-number"
        self.assertTrue(recall._prefetch_topic_matches(PRODUCER_QUERY, PRODUCER_QUERY, bad))


if __name__ == "__main__":
    unittest.main()
