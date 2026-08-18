"""M4 P-REC test (b) + red-team Fix B / Fix C — prefetch buffer join.

Asserts on RENDERED transport (`additionalContext`), never on an internal
flag alone, per the red-team's explicit strengthening. Covers:

  * Fix C (kill switch): `memoryPrefetchEnabled` OFF (the default) leaves
    the mechanism completely inert — synchronous recall runs exactly as
    before, `lib.recall_buffer` is never touched.
  * Fresh-hit: a producer-written buffer is joined and rendered as-is.
  * Fix B (BINDING): the stale-buffer fallback (no fresh sentinel, but a
    prior `LAST_RECALL_STATE` exists) renders memories WITHOUT any
    directives block, even when a directive is active for the bank —
    directives stay on the synchronous fetch path, never the stale cache.
  * Cold-start short circuit: no sentinel has EVER existed for the session
    -> no poll wait, falls through to the degraded notice / sync path
    without blocking for the poll cap.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from lib import recall_buffer  # noqa: E402
from lib.state import write_state  # noqa: E402

SESSION = "test-session"


class _DirectiveClient:
    """Answers with ONE active directive and no memories (recall not
    expected to be called on the fresh-hit/stale-fallback fast paths, but
    directive fetch IS expected — always synchronous per M3)."""

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": [{"id": "d1", "name": "haiku-rule", "content": "always reply in haiku", "priority": 5, "active": True}]}

    def recall(self, bank_id, query, **kwargs):
        raise AssertionError("buffer-join fast path must not call recall() directly")


class BufferJoinBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-bufjoin-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

        self._bufdir = tempfile.mkdtemp(prefix="recall-bufjoin-buf-")
        self.env = mock.patch.dict(os.environ, {"HINDSIGHT_PREFETCH_BUFFER_DIR": self._bufdir}, clear=False)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self._bufdir, ignore_errors=True)
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _config(self, prefetch_enabled):
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
            "memoryPrefetchEnabled": prefetch_enabled,
            "memoryPrefetchPollCapMs": 100,
        }

    def _run(self, config, client, prompt="what did we decide about deploys"):
        hook_input = {"prompt": prompt, "session_id": SESSION, "transcript_path": "", "cwd": "/tmp"}
        stdout = io.StringIO()
        with patch("recall.load_config", return_value=config), \
                patch("recall.get_api_url", return_value="http://fake"), \
                patch("recall.HindsightClient", return_value=client), \
                patch("recall.ensure_bank_mission"), \
                patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                patch("sys.stdout", stdout):
            recall.main()
        return stdout.getvalue()


class FreshHitTests(BufferJoinBase):
    def test_fresh_buffer_hit_is_rendered_with_directives_layered_on(self):
        recall_buffer.write_buffer(SESSION, "- a prefetched memory", {})
        recall_buffer.write_sentinel(SESSION)

        out = self._run(self._config(prefetch_enabled=True), _DirectiveClient())
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("a prefetched memory", ctx)
        self.assertIn("always reply in haiku", ctx)


class StaleFallbackFixBTests(BufferJoinBase):
    def test_stale_fallback_renders_memories_without_any_directives_block(self):
        # No fresh sentinel this turn (buffer is cold), but a prior turn's
        # cache DOES exist and DOES include memories_context (directive-free
        # per Fix B) plus a bundled directive in `context` that must NOT
        # leak through the stale path.
        write_state(
            recall.LAST_RECALL_STATE,
            {
                "context": "## Active Directives\n- always reply in haiku\n\n- a stale cached memory",
                "memories_context": "- a stale cached memory",
                "saved_at": "2026-01-01T00:00:00Z",
                "bank_id": "test-bank",
                "result_count": 1,
                "directive_count": 1,
            },
        )
        out = self._run(self._config(prefetch_enabled=True), _DirectiveClient())
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("a stale cached memory", ctx)
        self.assertIn("stale", ctx.lower())
        # Fix B, BINDING: the fresh directive fetch (synchronous, M3 rule)
        # IS allowed to appear — what must NEVER appear is the STALE
        # directives text sourced from the cached `context` field. Prove
        # this by using a client whose directive text differs from what a
        # stale-context leak would have produced, and confirming there is
        # exactly one occurrence (the fresh fetch), not a duplicate/leaked
        # second copy from the cache.
        self.assertEqual(ctx.count("always reply in haiku"), 1)

    def test_stale_fallback_directive_free_field_never_leaks_bare_context_directives(self):
        # A cache row is deliberately malformed/legacy-shaped (missing the
        # M4 `memories_context` field entirely, i.e. pre-M4 cache on disk).
        # The fallback must degrade to "nothing stale to show", NEVER fall
        # back to the directive-contaminated `context` field.
        write_state(
            recall.LAST_RECALL_STATE,
            {
                "context": "## Active Directives\n- always reply in haiku\n\n- a stale cached memory",
                "saved_at": "2026-01-01T00:00:00Z",
                "bank_id": "test-bank",
                "result_count": 1,
                "directive_count": 1,
            },
        )
        client = _DirectiveClient()
        out = self._run(self._config(prefetch_enabled=True), client)
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("a stale cached memory", ctx, "must not fall back to the directive-contaminated context field")


class ColdStartShortCircuitTests(BufferJoinBase):
    def test_no_sentinel_ever_written_skips_the_poll_wait(self):
        config = self._config(prefetch_enabled=True)
        config["memoryPrefetchPollCapMs"] = 5000  # would dominate the test if NOT short-circuited
        start = time.monotonic()
        out = self._run(config, _DirectiveClient())
        elapsed_ms = (time.monotonic() - start) * 1000
        self.assertTrue(out)
        self.assertLess(elapsed_ms, 1000, "cold-start (no sentinel ever) must not wait out the poll cap")


class KillSwitchOffTests(BufferJoinBase):
    def test_flag_off_never_touches_the_buffer_module(self):
        recall_buffer.write_buffer(SESSION, "- a prefetched memory", {})
        recall_buffer.write_sentinel(SESSION)

        with patch("recall.recall_buffer.read_if_fresh", side_effect=AssertionError("must not be called when flag is off")):
            client = _DirectiveClient()
            client.recall = lambda *a, **kw: {"results": []}  # sync path IS allowed to call recall
            out = self._run(self._config(prefetch_enabled=False), client)
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        # Byte-identical-behaviour proof: the buffer's content must NOT
        # appear (it was never consulted) even though it exists on disk.
        self.assertNotIn("a prefetched memory", ctx)


class StaleBufferTokenTests(BufferJoinBase):
    """F3 — a buffer consumed on turn N must NOT be re-served as fresh on
    turns N+1..N+k when no strictly-newer sentinel has been produced."""

    def test_consumed_buffer_is_not_reserved_as_fresh_next_turn(self):
        recall_buffer.write_buffer(SESSION, "- a prefetched memory", {})
        recall_buffer.write_sentinel(SESSION)
        cfg = self._config(prefetch_enabled=True)

        # Turn N+1: fresh hit — the buffer is consumed and its token recorded.
        out1 = self._run(cfg, _DirectiveClient())
        ctx1 = json.loads(out1)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("a prefetched memory", ctx1)

        # Turn N+2: the producer did NOT run again (no new sentinel). The same
        # on-disk buffer must now read as STALE (already-consumed token), so its
        # memory must NOT be injected again. On the pre-fix code — which hard-
        # wired last_consumed_token=None — read_if_fresh reported the old
        # sentinel "fresh" and re-injected the turn-N memory here.
        out2 = self._run(cfg, _DirectiveClient())
        ctx2 = json.loads(out2)["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn(
            "a prefetched memory", ctx2,
            "a buffer consumed on a prior turn must not be re-served as fresh",
        )

    def test_a_newer_sentinel_is_served_after_consumption(self):
        # Positive control: once the producer writes a STRICTLY-NEWER sentinel,
        # the fresh path serves again — the token gate rejects only re-reads of
        # an ALREADY-consumed sentinel, never a genuinely new one.
        recall_buffer.write_buffer(SESSION, "- memory one", {})
        recall_buffer.write_sentinel(SESSION)
        cfg = self._config(prefetch_enabled=True)

        out1 = self._run(cfg, _DirectiveClient())
        self.assertIn("memory one", json.loads(out1)["hookSpecificOutput"]["additionalContext"])

        # New turn's producer output.
        recall_buffer.write_buffer(SESSION, "- memory two", {})
        recall_buffer.write_sentinel(SESSION)
        out2 = self._run(cfg, _DirectiveClient())
        ctx2 = json.loads(out2)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("memory two", ctx2)


class ColdSessionSyncRecallTests(BufferJoinBase):
    """F4 — a flag-on cold session's first turn (no sentinel ever, no prior
    recall, no directives) must fall through to SYNCHRONOUS recall, not emit a
    degraded banner and short-circuit it."""

    class _MemClient:
        def list_directives(self, bank_id, active_only=True, timeout=2):
            return {"items": []}

        def recall(self, bank_id, query, **kwargs):
            return {"results": [{
                "text": "sync recalled memory", "type": "fact",
                "mentioned_at": "2026-01-01", "id": "s1", "scores": {"final": 0.9},
            }]}

    def test_cold_session_with_no_directives_runs_synchronous_recall(self):
        out = self._run(self._config(prefetch_enabled=True), self._MemClient())
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn(
            "sync recalled memory", ctx,
            "cold session's first turn must run synchronous recall, not a degraded no-op",
        )


if __name__ == "__main__":
    unittest.main()
